use crate::commands::search_index::{lookup_index_candidates, IndexCandidateLookup};
use crate::path_utils::{display_path, normalize_input_path};
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkContext, SinkMatch};
#[cfg(test)]
use ignore::Walk;
use ignore::{WalkBuilder, WalkState};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
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
    pub backend: String,
    pub fallback_reason: Option<String>,
    pub candidate_files: Option<usize>,
    pub index_generation: Option<u64>,
    pub index_state: String,
}

struct SearchContext {
    emit_batch: Arc<dyn Fn(ContentSearchBatch) + Send + Sync>,
    request: ContentSearchRequest,
    root_path: PathBuf,
    matcher: Regex,
    searcher_matcher: RegexMatcher,
    filters: SearchFilters,
    cancelled_searches: Arc<Mutex<HashSet<String>>>,
    pending_batch: Vec<ContentSearchMatch>,
    matched_paths: HashSet<PathBuf>,
    summary: ContentSearchSummary,
}

#[derive(Default)]
struct FileSearchOutcome {
    matches: Vec<ContentSearchMatch>,
    skipped: bool,
    cancelled: bool,
    truncated: bool,
}

#[derive(Clone)]
struct CompiledPatterns {
    path_patterns: GlobSet,
    file_name_patterns: GlobSet,
    is_empty: bool,
}

#[derive(Clone)]
struct SearchFilters {
    includes: CompiledPatterns,
    excludes: CompiledPatterns,
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
    let lookup = lookup_index_candidates(
        &app,
        &request.project_path,
        &request.query,
        request.use_regex,
    );
    let (candidate_paths, backend, fallback_reason, index_generation, index_state) = match lookup {
        IndexCandidateLookup::Ready { paths, generation } => (
            Some(paths),
            "index".to_string(),
            None,
            Some(generation),
            "ready".to_string(),
        ),
        IndexCandidateLookup::Fallback {
            reason,
            index_state,
        } => (None, "scan".to_string(), Some(reason), None, index_state),
    };
    let emit_app = app.clone();
    let emit_batch: Arc<dyn Fn(ContentSearchBatch) + Send + Sync> = Arc::new(move |payload| {
        let _ = emit_app.emit("content-search-batch", payload);
    });
    run_content_search_core_with_plan(
        request,
        cancelled_searches,
        emit_batch,
        candidate_paths,
        backend,
        fallback_reason,
        index_generation,
        index_state,
    )
}

#[cfg(test)]
fn run_content_search_core(
    request: ContentSearchRequest,
    cancelled_searches: Arc<Mutex<HashSet<String>>>,
    emit_batch: Arc<dyn Fn(ContentSearchBatch) + Send + Sync>,
) -> Result<ContentSearchSummary, String> {
    run_content_search_core_with_plan(
        request,
        cancelled_searches,
        emit_batch,
        None,
        "scan".to_string(),
        None,
        None,
        "not_checked".to_string(),
    )
}

#[allow(clippy::too_many_arguments)]
fn run_content_search_core_with_plan(
    request: ContentSearchRequest,
    cancelled_searches: Arc<Mutex<HashSet<String>>>,
    emit_batch: Arc<dyn Fn(ContentSearchBatch) + Send + Sync>,
    candidate_paths: Option<Vec<PathBuf>>,
    backend: String,
    fallback_reason: Option<String>,
    index_generation: Option<u64>,
    index_state: String,
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

    let pattern = build_pattern(&request)?;
    let matcher = build_exact_matcher(&request, &pattern)?;
    let searcher_matcher = build_searcher_matcher(&request, &pattern)?;
    let filters = SearchFilters::new(&request)?;
    let context = SearchContext {
        emit_batch,
        summary: ContentSearchSummary {
            search_id: request.search_id.clone(),
            backend,
            fallback_reason,
            candidate_files: candidate_paths.as_ref().map(Vec::len),
            index_generation,
            index_state,
            ..ContentSearchSummary::default()
        },
        request,
        root_path,
        matcher,
        searcher_matcher,
        filters,
        cancelled_searches,
        pending_batch: Vec::with_capacity(BATCH_SIZE),
        matched_paths: HashSet::new(),
    };

    if candidate_paths.as_ref().is_some_and(Vec::is_empty) {
        let mut context = context;
        context.summary.duration_ms = started_at.elapsed().as_millis();
        return Ok(context.summary);
    }
    let walker = if let Some(candidate_paths) = candidate_paths {
        let mut paths = candidate_paths.into_iter();
        let first = paths
            .next()
            .expect("empty index candidate lists return before creating a walker");
        let mut builder = WalkBuilder::new(first);
        for path in paths {
            builder.add(path);
        }
        let worker_count = std::thread::available_parallelism()
            .map(|count| usize::min(6, usize::max(1, count.get() / 2)))
            .unwrap_or(2);
        builder.threads(worker_count);
        builder.build_parallel()
    } else {
        build_search_walker_builder(&scope_path, &context.root_path, &context.filters)
            .build_parallel()
    };
    let shared_context = Arc::new(Mutex::new(context));
    let stop_requested = Arc::new(AtomicBool::new(false));
    walker.run(|| {
        let shared_context = shared_context.clone();
        let stop_requested = stop_requested.clone();
        let (
            root_path,
            scope_path,
            matcher,
            searcher_matcher,
            filters,
            cancelled_searches,
            search_id,
        ) = {
            let context = shared_context
                .lock()
                .expect("content search context must be available before workers start");
            (
                context.root_path.clone(),
                scope_path.clone(),
                context.matcher.clone(),
                context.searcher_matcher.clone(),
                context.filters.clone(),
                context.cancelled_searches.clone(),
                context.request.search_id.clone(),
            )
        };
        let mut searcher = build_file_searcher();

        Box::new(move |entry| {
            if stop_requested.load(Ordering::Relaxed)
                || search_is_cancelled(&cancelled_searches, &search_id)
            {
                if let Ok(mut context) = shared_context.lock() {
                    if search_is_cancelled(&cancelled_searches, &search_id) {
                        context.summary.cancelled = true;
                    }
                }
                stop_requested.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }

            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    if let Ok(mut context) = shared_context.lock() {
                        context.summary.skipped_files += 1;
                    }
                    return WalkState::Continue;
                }
            };
            let path = entry.path();
            if path == root_path || entry.file_type().is_some_and(|kind| kind.is_dir()) {
                return WalkState::Continue;
            }
            if !path.starts_with(&scope_path) {
                return WalkState::Continue;
            }
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => {
                    if let Ok(mut context) = shared_context.lock() {
                        context.summary.skipped_files += 1;
                    }
                    return WalkState::Continue;
                }
            };
            if metadata.file_type().is_symlink() {
                return WalkState::Continue;
            }
            if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
                if let Ok(mut context) = shared_context.lock() {
                    context.summary.skipped_files += 1;
                }
                return WalkState::Continue;
            }

            let relative_path = relative_search_path(&root_path, path);
            if !filters.matches_file(&relative_path) {
                return WalkState::Continue;
            }
            if let Ok(mut context) = shared_context.lock() {
                context.summary.scanned_files += 1;
            } else {
                stop_requested.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }

            let outcome = search_file(
                &mut searcher,
                &searcher_matcher,
                path,
                &relative_path,
                &matcher,
                MAX_MATCHES,
                || search_is_cancelled(&cancelled_searches, &search_id),
            );
            let should_stop = match shared_context.lock() {
                Ok(mut context) => {
                    context.apply_file_outcome(path, outcome);
                    context.summary.cancelled || context.summary.truncated
                }
                Err(_) => true,
            };
            if should_stop {
                stop_requested.store(true, Ordering::Relaxed);
                WalkState::Quit
            } else {
                WalkState::Continue
            }
        })
    });

    let mut context = Arc::try_unwrap(shared_context)
        .map_err(|_| "Search workers did not shut down cleanly".to_string())?
        .into_inner()
        .map_err(|_| "Search context became unavailable".to_string())?;

    context.flush_batch();
    context.summary.matched_files = context.matched_paths.len();
    context.summary.duration_ms = started_at.elapsed().as_millis();
    Ok(context.summary)
}

fn build_search_walker_builder(
    scope_path: &Path,
    root_path: &Path,
    filters: &SearchFilters,
) -> WalkBuilder {
    let filter_root = root_path.to_path_buf();
    let filters = filters.clone();
    let mut builder = WalkBuilder::new(scope_path);
    builder
        .hidden(false)
        .follow_links(false)
        .parents(true)
        .ignore(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .add_custom_ignore_filename(".rgignore")
        .filter_entry(move |entry| {
            if entry.depth() == 0 || !entry.file_type().is_some_and(|kind| kind.is_dir()) {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            !should_skip_directory(&name, entry.path(), &filter_root, &filters)
        });
    let worker_count = std::thread::available_parallelism()
        .map(|count| usize::min(6, usize::max(1, count.get() / 2)))
        .unwrap_or(2);
    builder.threads(worker_count);
    builder
}

#[cfg(test)]
fn build_search_walker(
    scope_path: &Path,
    root_path: &Path,
    request: &ContentSearchRequest,
) -> Walk {
    let filters = SearchFilters::new(request).expect("test search filters must compile");
    build_search_walker_builder(scope_path, root_path, &filters).build()
}

fn search_is_cancelled(cancelled_searches: &Arc<Mutex<HashSet<String>>>, search_id: &str) -> bool {
    cancelled_searches
        .lock()
        .map(|cancelled| cancelled.contains(search_id))
        .unwrap_or(true)
}

impl CompiledPatterns {
    fn new(patterns: &[String]) -> Result<Self, String> {
        let mut path_builder = GlobSetBuilder::new();
        let mut file_name_builder = GlobSetBuilder::new();
        let mut pattern_count = 0;
        for raw_pattern in patterns {
            let pattern = raw_pattern.trim().replace('\\', "/");
            if pattern.is_empty() {
                continue;
            }
            let mut builder = GlobBuilder::new(&pattern);
            builder
                .case_insensitive(true)
                .literal_separator(false)
                .backslash_escape(false);
            let glob = builder
                .build()
                .map_err(|error| format!("Invalid file glob '{pattern}': {error}"))?;
            if pattern.contains('/') {
                path_builder.add(glob);
            } else {
                file_name_builder.add(glob);
            }
            pattern_count += 1;
        }
        Ok(Self {
            path_patterns: path_builder
                .build()
                .map_err(|error| format!("Failed to compile path globs: {error}"))?,
            file_name_patterns: file_name_builder
                .build()
                .map_err(|error| format!("Failed to compile file name globs: {error}"))?,
            is_empty: pattern_count == 0,
        })
    }

    fn is_match(&self, path: &str) -> bool {
        if self.is_empty {
            return false;
        }
        let normalized_path = path.replace('\\', "/");
        let file_name = normalized_path
            .rsplit('/')
            .next()
            .unwrap_or(&normalized_path);
        self.path_patterns.is_match(&normalized_path) || self.file_name_patterns.is_match(file_name)
    }
}

impl SearchFilters {
    fn new(request: &ContentSearchRequest) -> Result<Self, String> {
        Ok(Self {
            includes: CompiledPatterns::new(&request.include_patterns)?,
            excludes: CompiledPatterns::new(&request.exclude_patterns)?,
        })
    }

    fn matches_file(&self, relative_path: &str) -> bool {
        !self.excludes.is_match(relative_path)
            && (self.includes.is_empty || self.includes.is_match(relative_path))
    }
}

fn build_pattern(request: &ContentSearchRequest) -> Result<String, String> {
    let query = request.query.trim();
    if query.is_empty() {
        return Err("Search query cannot be empty".to_string());
    }
    let base_pattern = if request.use_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    Ok(if request.whole_word {
        format!(r"\b(?:{base_pattern})\b")
    } else {
        base_pattern
    })
}

#[cfg(test)]
fn build_matcher(request: &ContentSearchRequest) -> Result<Regex, String> {
    let pattern = build_pattern(request)?;
    build_exact_matcher(request, &pattern)
}

fn build_exact_matcher(request: &ContentSearchRequest, pattern: &str) -> Result<Regex, String> {
    RegexBuilder::new(&pattern)
        .case_insensitive(!request.case_sensitive)
        .unicode(true)
        .build()
        .map_err(|error| format!("Invalid regular expression: {error}"))
}

fn build_searcher_matcher(
    request: &ContentSearchRequest,
    pattern: &str,
) -> Result<RegexMatcher, String> {
    RegexMatcherBuilder::new()
        .case_insensitive(!request.case_sensitive)
        .multi_line(true)
        .crlf(true)
        .line_terminator(None)
        .unicode(true)
        .build(pattern)
        .map_err(|error| format!("Invalid regular expression: {error}"))
}

fn should_skip_directory(
    name: &str,
    path: &Path,
    root_path: &Path,
    filters: &SearchFilters,
) -> bool {
    if IGNORED_DIRECTORIES
        .iter()
        .any(|ignored| name.eq_ignore_ascii_case(ignored))
    {
        return true;
    }
    let relative_path = relative_search_path(root_path, path);
    filters.excludes.is_match(&relative_path)
}

fn build_file_searcher() -> Searcher {
    let mut builder = SearcherBuilder::new();
    builder
        .line_number(true)
        .before_context(CONTEXT_LINE_COUNT)
        .after_context(CONTEXT_LINE_COUNT)
        .binary_detection(BinaryDetection::quit(0));
    builder.build()
}

struct ContentSearchSink<'a, F> {
    path: &'a Path,
    relative_path: &'a str,
    matcher: &'a Regex,
    match_limit: usize,
    is_cancelled: F,
    outcome: FileSearchOutcome,
    recent_lines: VecDeque<(usize, String)>,
    pending_after: VecDeque<usize>,
    last_line_number: Option<usize>,
}

impl<'a, F> ContentSearchSink<'a, F>
where
    F: FnMut() -> bool,
{
    fn new(
        path: &'a Path,
        relative_path: &'a str,
        matcher: &'a Regex,
        match_limit: usize,
        is_cancelled: F,
    ) -> Self {
        Self {
            path,
            relative_path,
            matcher,
            match_limit,
            is_cancelled,
            outcome: FileSearchOutcome::default(),
            recent_lines: VecDeque::with_capacity(CONTEXT_LINE_COUNT),
            pending_after: VecDeque::new(),
            last_line_number: None,
        }
    }

    fn cancelled(&mut self) -> bool {
        if (self.is_cancelled)() {
            self.outcome.cancelled = true;
            true
        } else {
            false
        }
    }

    fn decode_line(&mut self, bytes: &[u8]) -> Option<String> {
        let bytes = bytes.strip_suffix(b"\n").unwrap_or(bytes);
        let bytes = bytes.strip_suffix(b"\r").unwrap_or(bytes);
        match std::str::from_utf8(bytes) {
            Ok(line) => Some(line.to_string()),
            Err(_) => {
                self.outcome.skipped = true;
                self.outcome.matches.clear();
                None
            }
        }
    }

    fn prepare_line(&mut self, line_number: usize, line: &str) -> Option<Vec<String>> {
        if self
            .last_line_number
            .is_some_and(|last| line_number <= last)
        {
            return None;
        }
        self.last_line_number = Some(line_number);

        while let Some(&match_index) = self.pending_after.front() {
            let matched_line = self.outcome.matches[match_index].line_number;
            if line_number > matched_line + CONTEXT_LINE_COUNT {
                self.pending_after.pop_front();
            } else {
                break;
            }
        }
        for &match_index in &self.pending_after {
            let found = &mut self.outcome.matches[match_index];
            if line_number > found.line_number && found.context_after.len() < CONTEXT_LINE_COUNT {
                found.context_after.push(line.to_string());
            }
        }

        while self
            .recent_lines
            .front()
            .is_some_and(|(previous, _)| line_number.saturating_sub(*previous) > CONTEXT_LINE_COUNT)
        {
            self.recent_lines.pop_front();
        }
        Some(
            self.recent_lines
                .iter()
                .map(|(_, text)| text.clone())
                .collect(),
        )
    }

    fn finish_line(&mut self, line_number: usize, line: String) {
        self.recent_lines.push_back((line_number, line));
        while self.recent_lines.len() > CONTEXT_LINE_COUNT {
            self.recent_lines.pop_front();
        }
    }

    fn process_context_line(&mut self, line_number: usize, line: String) {
        if self.prepare_line(line_number, &line).is_some() {
            self.finish_line(line_number, line);
        }
    }

    fn process_matching_line(&mut self, line_number: usize, line: String) -> bool {
        let Some(context_before) = self.prepare_line(line_number, &line) else {
            return true;
        };
        for found in self.matcher.find_iter(&line) {
            if self.outcome.matches.len() >= self.match_limit {
                self.outcome.truncated = true;
                return false;
            }
            let match_index = self.outcome.matches.len();
            self.outcome.matches.push(ContentSearchMatch {
                path: display_path(self.path),
                relative_path: self.relative_path.to_string(),
                line_number,
                start_column: utf16_column(&line, found.start()),
                end_column: utf16_column(&line, found.end()),
                line_text: line.clone(),
                context_before: context_before.clone(),
                context_after: Vec::with_capacity(CONTEXT_LINE_COUNT),
            });
            self.pending_after.push_back(match_index);
        }
        self.finish_line(line_number, line);
        true
    }
}

impl<F> Sink for ContentSearchSink<'_, F>
where
    F: FnMut() -> bool,
{
    type Error = io::Error;

    fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, Self::Error> {
        if self.cancelled() {
            return Ok(false);
        }
        let Some(line_number) = mat
            .line_number()
            .and_then(|value| usize::try_from(value).ok())
        else {
            self.outcome.skipped = true;
            return Ok(false);
        };
        let Some(line) = self.decode_line(mat.bytes()) else {
            return Ok(false);
        };
        Ok(self.process_matching_line(line_number, line))
    }

    fn context(
        &mut self,
        _searcher: &Searcher,
        context: &SinkContext<'_>,
    ) -> Result<bool, Self::Error> {
        if self.cancelled() {
            return Ok(false);
        }
        let Some(line_number) = context
            .line_number()
            .and_then(|value| usize::try_from(value).ok())
        else {
            self.outcome.skipped = true;
            return Ok(false);
        };
        let Some(line) = self.decode_line(context.bytes()) else {
            return Ok(false);
        };
        self.process_context_line(line_number, line);
        Ok(true)
    }

    fn binary_data(
        &mut self,
        _searcher: &Searcher,
        _binary_byte_offset: u64,
    ) -> Result<bool, Self::Error> {
        self.outcome.skipped = true;
        self.outcome.matches.clear();
        Ok(false)
    }
}

fn search_file<F>(
    searcher: &mut Searcher,
    searcher_matcher: &RegexMatcher,
    path: &Path,
    relative_path: &str,
    matcher: &Regex,
    match_limit: usize,
    is_cancelled: F,
) -> FileSearchOutcome
where
    F: FnMut() -> bool,
{
    let mut sink = ContentSearchSink::new(path, relative_path, matcher, match_limit, is_cancelled);
    if searcher
        .search_path(searcher_matcher, path, &mut sink)
        .is_err()
    {
        sink.outcome.skipped = true;
        sink.outcome.matches.clear();
    }
    sink.outcome
}

fn utf16_column(line: &str, byte_offset: usize) -> usize {
    line[..byte_offset].encode_utf16().count() + 1
}

fn relative_search_path(root_path: &Path, path: &Path) -> String {
    path.strip_prefix(root_path)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

impl SearchContext {
    fn flush_batch(&mut self) {
        if self.pending_batch.is_empty() {
            return;
        }
        let payload = ContentSearchBatch {
            search_id: self.request.search_id.clone(),
            matches: std::mem::take(&mut self.pending_batch),
        };
        (self.emit_batch)(payload);
    }

    fn apply_file_outcome(&mut self, path: &Path, outcome: FileSearchOutcome) {
        if outcome.skipped {
            self.summary.skipped_files += 1;
        }
        if outcome.cancelled {
            self.summary.cancelled = true;
        }
        let remaining_matches = MAX_MATCHES.saturating_sub(self.summary.match_count);
        if outcome.truncated || outcome.matches.len() > remaining_matches {
            self.summary.truncated = true;
        }
        let accepted_matches: Vec<ContentSearchMatch> = outcome
            .matches
            .into_iter()
            .take(remaining_matches)
            .collect();
        if !accepted_matches.is_empty() {
            self.matched_paths.insert(path.to_path_buf());
        }
        for found in accepted_matches {
            self.pending_batch.push(found);
            self.summary.match_count += 1;
            if self.pending_batch.len() >= BATCH_SIZE {
                self.flush_batch();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

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

    fn search_test_file<F>(
        path: &Path,
        relative_path: &str,
        search_request: &ContentSearchRequest,
        match_limit: usize,
        is_cancelled: F,
    ) -> FileSearchOutcome
    where
        F: FnMut() -> bool,
    {
        let pattern = build_pattern(search_request).unwrap();
        let matcher = build_exact_matcher(search_request, &pattern).unwrap();
        let searcher_matcher = build_searcher_matcher(search_request, &pattern).unwrap();
        search_file(
            &mut build_file_searcher(),
            &searcher_matcher,
            path,
            relative_path,
            &matcher,
            match_limit,
            is_cancelled,
        )
    }

    #[test]
    fn compiled_globs_match_file_names_and_paths() {
        let patterns = CompiledPatterns::new(&[
            "*.tsx".to_string(),
            "src/*/App.?sx".to_string(),
            "SRC/**".to_string(),
        ])
        .unwrap();

        assert!(patterns.is_match("App.tsx"));
        assert!(patterns.is_match("src/components/App.tsx"));
        assert!(patterns.is_match("src/nested/other.ts"));
        assert!(!patterns.is_match("App.ts"));
    }

    #[test]
    fn file_filters_apply_excludes_before_includes() {
        let mut search_request = request("needle");
        search_request.include_patterns = vec!["*.ts".to_string()];
        search_request.exclude_patterns = vec!["src/generated/**".to_string()];
        let filters = SearchFilters::new(&search_request).unwrap();

        assert!(filters.matches_file("src/main.ts"));
        assert!(!filters.matches_file("src/generated/client.ts"));
        assert!(!filters.matches_file("src/main.rs"));
    }

    #[test]
    fn invalid_file_glob_is_rejected_before_search() {
        let mut search_request = request("needle");
        search_request.include_patterns = vec!["[unterminated".to_string()];
        assert!(SearchFilters::new(&search_request).is_err());
    }

    #[test]
    fn literal_matcher_escapes_regular_expression_characters() {
        let matcher = build_matcher(&request("value.*")).unwrap();
        assert!(matcher.is_match("const value.* = true"));
        assert!(!matcher.is_match("const value123 = true"));
    }

    #[test]
    fn literal_matcher_is_case_insensitive_by_default() {
        let matcher = build_matcher(&request("updateWrapper")).unwrap();
        assert!(matcher.is_match("UpdateWrapper.eq(\"id\", id)"));
    }

    #[test]
    fn case_sensitive_matcher_preserves_case() {
        let mut search_request = request("updateWrapper");
        search_request.case_sensitive = true;
        let matcher = build_matcher(&search_request).unwrap();

        assert!(matcher.is_match("updateWrapper.eq(\"id\", id)"));
        assert!(!matcher.is_match("UpdateWrapper.eq(\"id\", id)"));
    }

    #[test]
    fn invalid_regular_expression_is_rejected() {
        let mut search_request = request("(");
        search_request.use_regex = true;
        assert!(build_matcher(&search_request).is_err());
    }

    #[test]
    fn whole_word_matcher_does_not_match_identifier_suffixes() {
        let mut search_request = request("cat");
        search_request.whole_word = true;
        let matcher = build_matcher(&search_request).unwrap();
        assert!(matcher.is_match("a cat appears"));
        assert!(!matcher.is_match("concatenate"));
    }

    #[test]
    fn utf16_columns_match_webview_editor_coordinates() {
        let line = "a😀中updateWrapper";
        let match_start = line.find("updateWrapper").unwrap();
        let match_end = match_start + "updateWrapper".len();

        // a = 1 UTF-16 code unit, 😀 = 2, 中 = 1, then columns are 1-based.
        assert_eq!(utf16_column(line, match_start), 5);
        assert_eq!(utf16_column(line, match_end), 18);
    }

    #[test]
    fn relative_paths_are_stable_for_generated_fixture_trees() {
        let fixture = tempdir().unwrap();
        let nested = fixture.path().join("src").join("feature");
        fs::create_dir_all(&nested).unwrap();
        let file = nested.join("search_target.rs");
        fs::write(&file, "fn update_wrapper() {}\n").unwrap();

        assert_eq!(
            relative_search_path(fixture.path(), &file),
            "src/feature/search_target.rs"
        );
    }

    #[test]
    fn search_walker_respects_git_and_builtin_ignores() {
        let fixture = tempdir().unwrap();
        fs::create_dir_all(fixture.path().join(".git")).unwrap();
        fs::create_dir_all(fixture.path().join("src")).unwrap();
        fs::create_dir_all(fixture.path().join("node_modules")).unwrap();
        fs::create_dir_all(fixture.path().join("dist")).unwrap();
        fs::write(fixture.path().join(".gitignore"), "node_modules/\n").unwrap();
        fs::write(fixture.path().join("src").join("main.rs"), "needle\n").unwrap();
        fs::write(
            fixture.path().join("node_modules").join("ignored.js"),
            "needle\n",
        )
        .unwrap();
        fs::write(fixture.path().join("dist").join("bundle.js"), "needle\n").unwrap();

        let search_request = request("needle");
        let paths: Vec<String> =
            build_search_walker(fixture.path(), fixture.path(), &search_request)
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_some_and(|kind| kind.is_file()))
                .map(|entry| relative_search_path(fixture.path(), entry.path()))
                .collect();

        assert!(paths.contains(&"src/main.rs".to_string()));
        assert!(!paths.contains(&"node_modules/ignored.js".to_string()));
        assert!(!paths.contains(&"dist/bundle.js".to_string()));
    }

    #[test]
    fn file_search_preserves_context_and_utf16_columns() {
        let fixture = tempdir().unwrap();
        let file = fixture.path().join("unicode.ts");
        fs::write(
            &file,
            "before-1\nbefore-2\nbefore-3\na😀中 updateWrapper.eq()\nafter-1\nafter-2\nafter-3\nafter-4\n",
        )
        .unwrap();

        let search_request = request("updateWrapper");
        let outcome = search_test_file(&file, "unicode.ts", &search_request, MAX_MATCHES, || false);

        assert!(!outcome.skipped);
        assert!(!outcome.cancelled);
        assert!(!outcome.truncated);
        assert_eq!(outcome.matches.len(), 1);
        let found = &outcome.matches[0];
        assert_eq!(found.line_number, 4);
        assert_eq!(found.start_column, 6);
        assert_eq!(found.end_column, 19);
        assert_eq!(found.context_before, ["before-1", "before-2", "before-3"]);
        assert_eq!(found.context_after, ["after-1", "after-2", "after-3"]);
    }

    #[test]
    fn file_search_skips_binary_and_invalid_utf8_files() {
        let fixture = tempdir().unwrap();
        let binary = fixture.path().join("binary.bin");
        let invalid_utf8 = fixture.path().join("legacy.txt");
        fs::write(&binary, b"needle\0binary").unwrap();
        fs::write(&invalid_utf8, b"needle\xff\n").unwrap();
        let search_request = request("needle");

        assert!(
            search_test_file(&binary, "binary.bin", &search_request, MAX_MATCHES, || {
                false
            })
            .skipped
        );
        assert!(
            search_test_file(
                &invalid_utf8,
                "legacy.txt",
                &search_request,
                MAX_MATCHES,
                || false
            )
            .skipped
        );
    }

    #[test]
    fn file_search_transcodes_utf16_bom_files() {
        let fixture = tempdir().unwrap();
        let content: Vec<u16> = "before\nneedle 馃榾\nafter\n".encode_utf16().collect();
        let search_request = request("needle");
        for (name, bom, encoded) in [
            (
                "utf16-le.txt",
                [0xff, 0xfe],
                content
                    .iter()
                    .copied()
                    .flat_map(u16::to_le_bytes)
                    .collect::<Vec<_>>(),
            ),
            (
                "utf16-be.txt",
                [0xfe, 0xff],
                content
                    .iter()
                    .copied()
                    .flat_map(u16::to_be_bytes)
                    .collect::<Vec<_>>(),
            ),
        ] {
            let file = fixture.path().join(name);
            let mut bytes = bom.to_vec();
            bytes.extend(encoded);
            fs::write(&file, bytes).unwrap();

            let outcome = search_test_file(&file, name, &search_request, MAX_MATCHES, || false);
            assert!(!outcome.skipped, "{name}");
            assert_eq!(outcome.matches.len(), 1, "{name}");
            assert_eq!(outcome.matches[0].line_number, 2, "{name}");
            assert_eq!(outcome.matches[0].line_text, "needle 馃榾", "{name}");
            assert_eq!(outcome.matches[0].context_before, ["before"], "{name}");
            assert_eq!(outcome.matches[0].context_after, ["after"], "{name}");
        }
    }

    #[test]
    fn file_search_strips_utf8_bom_before_reporting_columns() {
        let fixture = tempdir().unwrap();
        let file = fixture.path().join("utf8-bom.txt");
        fs::write(&file, b"\xef\xbb\xbfneedle\n").unwrap();

        let search_request = request("needle");
        let outcome = search_test_file(&file, "utf8-bom.txt", &search_request, MAX_MATCHES, || {
            false
        });

        assert_eq!(outcome.matches.len(), 1);
        assert_eq!(outcome.matches[0].line_text, "needle");
        assert_eq!(outcome.matches[0].start_column, 1);
        assert_eq!(outcome.matches[0].end_column, 7);
    }

    #[test]
    fn file_search_reconstructs_overlapping_context_groups() {
        let fixture = tempdir().unwrap();
        let file = fixture.path().join("adjacent.txt");
        fs::write(
            &file,
            "zero\nneedle one\nbetween\nneedle two\nafter-1\nafter-2\nafter-3\n",
        )
        .unwrap();

        let search_request = request("needle");
        let outcome = search_test_file(&file, "adjacent.txt", &search_request, MAX_MATCHES, || {
            false
        });

        assert_eq!(outcome.matches.len(), 2);
        assert_eq!(outcome.matches[0].context_before, ["zero"]);
        assert_eq!(
            outcome.matches[0].context_after,
            ["between", "needle two", "after-1"]
        );
        assert_eq!(
            outcome.matches[1].context_before,
            ["zero", "needle one", "between"]
        );
        assert_eq!(
            outcome.matches[1].context_after,
            ["after-1", "after-2", "after-3"]
        );
    }

    #[test]
    fn file_search_preserves_per_line_anchor_semantics_for_crlf() {
        let fixture = tempdir().unwrap();
        let file = fixture.path().join("windows.txt");
        fs::write(&file, b"before\r\nneedle\r\nafter\r\n").unwrap();
        let mut search_request = request("^needle$");
        search_request.use_regex = true;

        let outcome =
            search_test_file(&file, "windows.txt", &search_request, MAX_MATCHES, || false);

        assert_eq!(outcome.matches.len(), 1);
        assert_eq!(outcome.matches[0].line_number, 2);
        assert_eq!(outcome.matches[0].line_text, "needle");
        assert_eq!(outcome.matches[0].context_before, ["before"]);
        assert_eq!(outcome.matches[0].context_after, ["after"]);
    }

    #[test]
    fn file_search_honors_match_limits_and_cancellation() {
        let fixture = tempdir().unwrap();
        let file = fixture.path().join("many.txt");
        fs::write(&file, "needle needle needle\n").unwrap();
        let search_request = request("needle");

        let limited = search_test_file(&file, "many.txt", &search_request, 2, || false);
        assert_eq!(limited.matches.len(), 2);
        assert!(limited.truncated);

        let cancelled = search_test_file(&file, "many.txt", &search_request, MAX_MATCHES, || true);
        assert!(cancelled.matches.is_empty());
        assert!(cancelled.cancelled);
    }

    #[test]
    fn search_core_streams_results_and_skips_ignored_directories() {
        let fixture = tempdir().unwrap();
        fs::create_dir_all(fixture.path().join(".git")).unwrap();
        fs::create_dir_all(fixture.path().join("src")).unwrap();
        fs::create_dir_all(fixture.path().join("node_modules")).unwrap();
        fs::write(fixture.path().join(".gitignore"), "node_modules/\n").unwrap();
        fs::write(
            fixture.path().join("src").join("main.ts"),
            "updateWrapper.eq(\"id\", id);\n",
        )
        .unwrap();
        fs::write(
            fixture.path().join("node_modules").join("ignored.js"),
            "updateWrapper.eq('ignored', true);\n",
        )
        .unwrap();

        let mut search_request = request("updateWrapper.");
        search_request.project_path = fixture.path().to_string_lossy().to_string();
        let batches = Arc::new(Mutex::new(Vec::<ContentSearchBatch>::new()));
        let captured_batches = batches.clone();
        let summary = run_content_search_core(
            search_request,
            Arc::new(Mutex::new(HashSet::new())),
            Arc::new(move |batch| captured_batches.lock().unwrap().push(batch)),
        )
        .unwrap();

        assert_eq!(summary.match_count, 1);
        assert_eq!(summary.matched_files, 1);
        assert!(!summary.cancelled);
        assert!(!summary.truncated);
        let batches = batches.lock().unwrap();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].matches.len(), 1);
        assert_eq!(batches[0].matches[0].relative_path, "src/main.ts");
    }

    #[test]
    fn indexed_candidate_plan_scans_only_candidates_and_keeps_exact_matching() {
        let fixture = tempdir().unwrap();
        let candidate = fixture.path().join("candidate.txt");
        let non_candidate = fixture.path().join("non-candidate.txt");
        fs::write(&candidate, "before\nNeedle value\nafter\n").unwrap();
        fs::write(&non_candidate, "Needle should not be scanned\n").unwrap();
        let mut search_request = request("Needle");
        search_request.project_path = fixture.path().to_string_lossy().to_string();
        search_request.case_sensitive = true;

        let summary = run_content_search_core_with_plan(
            search_request,
            Arc::new(Mutex::new(HashSet::new())),
            Arc::new(|_| {}),
            Some(vec![candidate]),
            "index".to_string(),
            None,
            Some(7),
            "ready".to_string(),
        )
        .unwrap();

        assert_eq!(summary.backend, "index");
        assert_eq!(summary.candidate_files, Some(1));
        assert_eq!(summary.scanned_files, 1);
        assert_eq!(summary.match_count, 1);
        assert_eq!(summary.index_generation, Some(7));
    }

    #[test]
    fn search_core_honors_preexisting_cancellation() {
        let fixture = tempdir().unwrap();
        fs::write(fixture.path().join("main.txt"), "needle\n").unwrap();
        let mut search_request = request("needle");
        search_request.project_path = fixture.path().to_string_lossy().to_string();
        let cancelled_searches = Arc::new(Mutex::new(HashSet::from(["test".to_string()])));

        let summary =
            run_content_search_core(search_request, cancelled_searches, Arc::new(|_| {})).unwrap();

        assert!(summary.cancelled);
        assert_eq!(summary.match_count, 0);
    }

    #[test]
    fn parallel_search_core_enforces_the_global_match_limit() {
        let fixture = tempdir().unwrap();
        let repeated = "needle ".repeat(3_000);
        fs::write(fixture.path().join("first.txt"), &repeated).unwrap();
        fs::write(fixture.path().join("second.txt"), &repeated).unwrap();
        let mut search_request = request("needle");
        search_request.project_path = fixture.path().to_string_lossy().to_string();

        let summary = run_content_search_core(
            search_request,
            Arc::new(Mutex::new(HashSet::new())),
            Arc::new(|_| {}),
        )
        .unwrap();

        assert_eq!(summary.match_count, MAX_MATCHES);
        assert!(summary.truncated);
        assert!(!summary.cancelled);
    }

    #[test]
    #[ignore = "manual performance fixture; set TERMFLOW_SEARCH_FIXTURE"]
    fn benchmark_generated_search_fixture() {
        let fixture = std::env::var("TERMFLOW_SEARCH_FIXTURE")
            .expect("TERMFLOW_SEARCH_FIXTURE must point to a generated fixture");
        let mut search_request = request("updateWrapper.");
        search_request.project_path = fixture;
        let summary = run_content_search_core(
            search_request,
            Arc::new(Mutex::new(HashSet::new())),
            Arc::new(|_| {}),
        )
        .unwrap();

        println!(
            "search-benchmark scanned={} matched_files={} matches={} duration_ms={}",
            summary.scanned_files, summary.matched_files, summary.match_count, summary.duration_ms
        );
        assert!(summary.scanned_files > 0);
    }
}
