use crate::path_utils::{display_path, normalize_input_path};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, State};

const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_MATCHES: usize = 5_000;
const BATCH_SIZE: usize = 200;
const CONTEXT_LINE_COUNT: usize = 3;

const IGNORED_DIRECTORIES: &[&str] = &[
    ".git",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "coverage",
    "__pycache__",
    ".cache",
    "vendor",
];

#[derive(Default)]
pub struct ContentSearchState {
    cancelled_searches: Arc<Mutex<HashSet<String>>>,
    active_searches: Arc<Mutex<HashSet<String>>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchRequest {
    pub search_id: String,
    pub project_path: String,
    pub scope_path: Option<String>,
    pub query: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub use_regex: bool,
    pub include_patterns: Vec<String>,
    pub exclude_patterns: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchMatch {
    pub path: String,
    pub relative_path: String,
    pub line_number: usize,
    pub start_column: usize,
    pub end_column: usize,
    pub line_text: String,
    pub context_before: Vec<String>,
    pub context_after: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContentSearchBatch {
    search_id: String,
    matches: Vec<ContentSearchMatch>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSearchSummary {
    pub search_id: String,
    pub scanned_files: usize,
    pub skipped_files: usize,
    pub matched_files: usize,
    pub match_count: usize,
    pub duration_ms: u128,
    pub truncated: bool,
    pub cancelled: bool,
}

struct SearchContext {
    app: AppHandle,
    request: ContentSearchRequest,
    root_path: PathBuf,
    matcher: Regex,
    cancelled_searches: Arc<Mutex<HashSet<String>>>,
    git_repository: Option<git2::Repository>,
    pending_batch: Vec<ContentSearchMatch>,
    matched_paths: HashSet<PathBuf>,
    summary: ContentSearchSummary,
}

#[tauri::command]
pub async fn search_project_text(
    app: AppHandle,
    state: State<'_, ContentSearchState>,
    request: ContentSearchRequest,
) -> Result<ContentSearchSummary, String> {
    let cancelled_searches = state.cancelled_searches.clone();
    let search_id = request.search_id.clone();
    state
        .active_searches
        .lock()
        .map_err(|_| "Failed to initialize active search state".to_string())?
        .insert(search_id.clone());

    let result = tauri::async_runtime::spawn_blocking(move || {
        run_content_search(app, request, cancelled_searches)
    })
    .await
    .map_err(|error| format!("Search task failed: {error}"))?;

    if let Ok(mut cancelled) = state.cancelled_searches.lock() {
        cancelled.remove(&search_id);
    }
    if let Ok(mut active) = state.active_searches.lock() {
        active.remove(&search_id);
    }
    result
}

#[tauri::command]
pub fn cancel_content_search(
    state: State<'_, ContentSearchState>,
    search_id: String,
) -> Result<(), String> {
    state
        .cancelled_searches
        .lock()
        .map_err(|_| "Failed to update search cancellation state".to_string())?
        .insert(search_id);
    Ok(())
}

fn run_content_search(
    app: AppHandle,
    request: ContentSearchRequest,
    cancelled_searches: Arc<Mutex<HashSet<String>>>,
) -> Result<ContentSearchSummary, String> {
    let started_at = Instant::now();
    let root_path = normalize_input_path(&request.project_path);
    if !root_path.is_dir() {
        return Err("Project directory does not exist".to_string());
    }

    let scope_path = request
        .scope_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(normalize_input_path)
        .unwrap_or_else(|| root_path.clone());
    if !scope_path.is_dir() || !scope_path.starts_with(&root_path) {
        return Err("Search scope must be a directory inside the project".to_string());
    }

    let matcher = build_matcher(&request)?;
    let git_repository = git2::Repository::discover(&root_path).ok();
    let mut context = SearchContext {
        app,
        summary: ContentSearchSummary {
            search_id: request.search_id.clone(),
            ..ContentSearchSummary::default()
        },
        request,
        root_path,
        matcher,
        cancelled_searches,
        git_repository,
        pending_batch: Vec::with_capacity(BATCH_SIZE),
        matched_paths: HashSet::new(),
    };

    let mut directories = VecDeque::from([scope_path]);
    while let Some(directory) = directories.pop_front() {
        if context.is_cancelled() {
            context.summary.cancelled = true;
            break;
        }
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => {
                context.summary.skipped_files += 1;
                continue;
            }
        };

        for entry in entries.flatten() {
            if context.is_cancelled() {
                context.summary.cancelled = true;
                break;
            }

            let path = entry.path();
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => {
                    context.summary.skipped_files += 1;
                    continue;
                }
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if context.is_git_ignored(&path) {
                continue;
            }
            if metadata.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !should_skip_directory(&name, &path, &context) {
                    directories.push_back(path);
                }
                continue;
            }
            if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
                context.summary.skipped_files += 1;
                continue;
            }

            let relative_path = relative_search_path(&context.root_path, &path);
            if !matches_file_filters(&relative_path, &context.request) {
                continue;
            }
            context.summary.scanned_files += 1;
            search_file(&path, &relative_path, &mut context);
            if context.summary.truncated {
                break;
            }
        }
        if context.summary.truncated {
            break;
        }
    }

    context.flush_batch();
    context.summary.matched_files = context.matched_paths.len();
    context.summary.duration_ms = started_at.elapsed().as_millis();
    Ok(context.summary)
}

fn build_matcher(request: &ContentSearchRequest) -> Result<Regex, String> {
    let query = request.query.trim();
    if query.is_empty() {
        return Err("Search query cannot be empty".to_string());
    }
    let base_pattern = if request.use_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    let pattern = if request.whole_word {
        format!(r"\b(?:{base_pattern})\b")
    } else {
        base_pattern
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!request.case_sensitive)
        .unicode(true)
        .build()
        .map_err(|error| format!("Invalid regular expression: {error}"))
}

fn should_skip_directory(name: &str, path: &Path, context: &SearchContext) -> bool {
    if IGNORED_DIRECTORIES
        .iter()
        .any(|ignored| name.eq_ignore_ascii_case(ignored))
    {
        return true;
    }
    let relative_path = relative_search_path(&context.root_path, path);
    matches_any_pattern(&relative_path, &context.request.exclude_patterns)
}

fn matches_file_filters(relative_path: &str, request: &ContentSearchRequest) -> bool {
    if matches_any_pattern(relative_path, &request.exclude_patterns) {
        return false;
    }
    request.include_patterns.is_empty()
        || matches_any_pattern(relative_path, &request.include_patterns)
}

fn matches_any_pattern(path: &str, patterns: &[String]) -> bool {
    let normalized_path = path.replace('\\', "/");
    let file_name = normalized_path
        .rsplit('/')
        .next()
        .unwrap_or(&normalized_path);
    patterns.iter().any(|pattern| {
        let normalized_pattern = pattern.trim().replace('\\', "/");
        if normalized_pattern.is_empty() {
            return false;
        }
        let target = if normalized_pattern.contains('/') {
            normalized_path.as_str()
        } else {
            file_name
        };
        wildcard_match(&normalized_pattern.to_lowercase(), &target.to_lowercase())
    })
}

fn wildcard_match(pattern: &str, value: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let value: Vec<char> = value.chars().collect();
    let mut previous = vec![false; value.len() + 1];
    previous[0] = true;
    for pattern_char in pattern {
        let mut current = vec![false; value.len() + 1];
        if pattern_char == '*' {
            current[0] = previous[0];
        }
        for index in 1..=value.len() {
            current[index] = match pattern_char {
                '*' => previous[index] || current[index - 1],
                '?' => previous[index - 1],
                literal => previous[index - 1] && literal == value[index - 1],
            };
        }
        previous = current;
    }
    previous[value.len()]
}

fn search_file(path: &Path, relative_path: &str, context: &mut SearchContext) {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => {
            context.summary.skipped_files += 1;
            return;
        }
    };
    if bytes.iter().take(8_192).any(|byte| *byte == 0) {
        context.summary.skipped_files += 1;
        return;
    }
    let content = match String::from_utf8(bytes) {
        Ok(content) => content,
        Err(_) => {
            context.summary.skipped_files += 1;
            return;
        }
    };
    let lines: Vec<&str> = content.lines().collect();
    let matcher = context.matcher.clone();
    for (line_index, line) in lines.iter().enumerate() {
        if context.is_cancelled() {
            context.summary.cancelled = true;
            return;
        }
        for found in matcher.find_iter(line) {
            if context.is_cancelled() {
                context.summary.cancelled = true;
                return;
            }
            if context.summary.match_count >= MAX_MATCHES {
                context.summary.truncated = true;
                return;
            }
            let match_start = found.start();
            let match_end = found.end();
            let start_column = line[..match_start].encode_utf16().count() + 1;
            let end_column = line[..match_end].encode_utf16().count() + 1;
            context.pending_batch.push(ContentSearchMatch {
                path: display_path(path),
                relative_path: relative_path.to_string(),
                line_number: line_index + 1,
                start_column,
                end_column,
                line_text: (*line).to_string(),
                context_before: lines[line_index.saturating_sub(CONTEXT_LINE_COUNT)..line_index]
                    .iter()
                    .map(|value| (*value).to_string())
                    .collect(),
                context_after: lines
                    [line_index + 1..usize::min(lines.len(), line_index + 1 + CONTEXT_LINE_COUNT)]
                    .iter()
                    .map(|value| (*value).to_string())
                    .collect(),
            });
            context.summary.match_count += 1;
            context.matched_paths.insert(path.to_path_buf());
            if context.pending_batch.len() >= BATCH_SIZE {
                context.flush_batch();
            }
        }
    }
}

fn relative_search_path(root_path: &Path, path: &Path) -> String {
    path.strip_prefix(root_path)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

impl SearchContext {
    fn is_cancelled(&self) -> bool {
        self.cancelled_searches
            .lock()
            .map(|cancelled| cancelled.contains(&self.request.search_id))
            .unwrap_or(true)
    }

    fn flush_batch(&mut self) {
        if self.pending_batch.is_empty() {
            return;
        }
        let payload = ContentSearchBatch {
            search_id: self.request.search_id.clone(),
            matches: std::mem::take(&mut self.pending_batch),
        };
        let _ = self.app.emit("content-search-batch", payload);
    }

    fn is_git_ignored(&self, path: &Path) -> bool {
        let Some(repository) = &self.git_repository else {
            return false;
        };
        let Some(workdir) = repository.workdir() else {
            return false;
        };
        let Ok(relative_path) = path.strip_prefix(workdir) else {
            return false;
        };
        repository
            .status_should_ignore(relative_path)
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(query: &str) -> ContentSearchRequest {
        ContentSearchRequest {
            search_id: "test".to_string(),
            project_path: ".".to_string(),
            scope_path: None,
            query: query.to_string(),
            case_sensitive: false,
            whole_word: false,
            use_regex: false,
            include_patterns: Vec::new(),
            exclude_patterns: Vec::new(),
        }
    }

    #[test]
    fn wildcard_filters_match_file_names_and_paths() {
        assert!(wildcard_match("*.tsx", "App.tsx"));
        assert!(wildcard_match("src/*/App.?sx", "src/components/App.tsx"));
        assert!(!wildcard_match("*.ts", "App.tsx"));
    }

    #[test]
    fn literal_matcher_escapes_regular_expression_characters() {
        let matcher = build_matcher(&request("value.*")).unwrap();
        assert!(matcher.is_match("const value.* = true"));
        assert!(!matcher.is_match("const value123 = true"));
    }

    #[test]
    fn whole_word_matcher_does_not_match_identifier_suffixes() {
        let mut search_request = request("cat");
        search_request.whole_word = true;
        let matcher = build_matcher(&search_request).unwrap();
        assert!(matcher.is_match("a cat appears"));
        assert!(!matcher.is_match("concatenate"));
    }
}
