use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ignore::WalkBuilder;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{params, Connection, OpenFlags};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::database::{Database, SearchIndexStorageSettings};
use crate::path_utils::{display_path, normalize_input_path};

const INDEX_SCHEMA_VERSION: u32 = 1;
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
const STATUS_EMIT_INTERVAL: Duration = Duration::from_millis(150);
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSearchIndexStatus {
    pub project_path: String,
    pub enabled: bool,
    pub state: String,
    pub backend: String,
    pub phase: String,
    pub processed_files: u64,
    pub total_files: Option<u64>,
    pub indexed_files: u64,
    pub skipped_files: u64,
    pub processed_bytes: u64,
    pub total_bytes: Option<u64>,
    pub index_size_bytes: u64,
    pub started_at: Option<u64>,
    pub updated_at: Option<u64>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexStorageStatus {
    pub cache_root: String,
    pub quota_bytes: u64,
    pub used_bytes: u64,
    pub project_count: u64,
}

#[derive(Clone)]
struct ActiveEntry {
    job_id: u64,
    cancel: Arc<AtomicBool>,
    revision: Arc<AtomicU64>,
    status: ProjectSearchIndexStatus,
}

struct ProjectIndexWatcher {
    _watcher: Box<dyn Watcher + Send>,
    _sender: mpsc::Sender<Result<Event, notify::Error>>,
}

#[derive(Clone, Default)]
pub struct SearchIndexState {
    entries: Arc<Mutex<HashMap<String, ActiveEntry>>>,
    watchers: Arc<Mutex<HashMap<String, ProjectIndexWatcher>>>,
    next_job_id: Arc<AtomicU64>,
}

#[derive(Clone)]
struct ResolvedProject {
    path: PathBuf,
    display_path: String,
    preference_key: String,
}

#[derive(Clone)]
struct IndexCandidate {
    path: PathBuf,
    relative_path: String,
    size: u64,
    modified_ns: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TextEncoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
}

pub(crate) enum IndexCandidateLookup {
    Ready {
        paths: Vec<PathBuf>,
        generation: u64,
    },
    Fallback {
        reason: String,
        index_state: String,
    },
}

impl TextEncoding {
    fn as_str(self) -> &'static str {
        match self {
            Self::Utf8 => "utf-8",
            Self::Utf8Bom => "utf-8-bom",
            Self::Utf16Le => "utf-16-le",
            Self::Utf16Be => "utf-16-be",
        }
    }
}

fn resolve_project(project_path: &str) -> Result<ResolvedProject, String> {
    let trimmed = project_path.trim();
    if trimmed.is_empty() {
        return Err("Project path cannot be empty".to_string());
    }
    let path = normalize_input_path(trimmed);
    if !path.is_dir() {
        return Err("Project directory does not exist".to_string());
    }
    let display = display_path(&path);
    let normalized = display.replace('\\', "/");
    #[cfg(windows)]
    let preference_key = normalized.to_lowercase();
    #[cfg(not(windows))]
    let preference_key = normalized;
    Ok(ResolvedProject {
        path,
        display_path: display,
        preference_key,
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default()
}

fn disabled_status(project_path: String) -> ProjectSearchIndexStatus {
    ProjectSearchIndexStatus {
        project_path,
        enabled: false,
        state: "disabled".to_string(),
        backend: "scan".to_string(),
        phase: "disabled".to_string(),
        processed_files: 0,
        total_files: None,
        indexed_files: 0,
        skipped_files: 0,
        processed_bytes: 0,
        total_bytes: None,
        index_size_bytes: 0,
        started_at: None,
        updated_at: None,
        error: None,
    }
}

fn initial_build_status(project_path: String) -> ProjectSearchIndexStatus {
    ProjectSearchIndexStatus {
        project_path,
        enabled: true,
        state: "preflight".to_string(),
        backend: "scan".to_string(),
        phase: "discovering".to_string(),
        processed_files: 0,
        total_files: None,
        indexed_files: 0,
        skipped_files: 0,
        processed_bytes: 0,
        total_bytes: None,
        index_size_bytes: 0,
        started_at: Some(now_ms()),
        updated_at: Some(now_ms()),
        error: None,
    }
}

fn project_hash(project: &ResolvedProject) -> String {
    let mut hasher = Sha256::new();
    hasher.update(project.preference_key.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn default_index_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Failed to resolve application cache directory: {error}"))?
        .join("search-index"))
}

fn index_root_from_settings(
    app: &AppHandle,
    settings: &SearchIndexStorageSettings,
) -> Result<PathBuf, String> {
    match settings.cache_root.as_deref().filter(|value| !value.trim().is_empty()) {
        Some(path) => Ok(PathBuf::from(path)),
        None => default_index_root(app),
    }
}

fn index_root(app: &AppHandle) -> Result<PathBuf, String> {
    let database = app.state::<Arc<Database>>();
    let settings = database.load_search_index_storage()?;
    index_root_from_settings(app, &settings)
}

fn index_directory(app: &AppHandle, project: &ResolvedProject) -> Result<PathBuf, String> {
    Ok(index_root(app)?
        .join(format!("v{INDEX_SCHEMA_VERSION}"))
        .join(project_hash(project)))
}

fn directory_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            let Ok(file_type) = entry.file_type() else {
                return 0;
            };
            if file_type.is_dir() {
                directory_size(&entry.path())
            } else if file_type.is_file() {
                entry.metadata().map(|metadata| metadata.len()).unwrap_or(0)
            } else {
                0
            }
        })
        .sum()
}

fn modified_at_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default()
}

fn touch_index_usage(index_dir: &Path) {
    let _ = fs::write(index_dir.join("last-used"), now_ms().to_string());
}

fn last_index_use(index_dir: &Path) -> u64 {
    fs::read_to_string(index_dir.join("last-used"))
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or_else(|| modified_at_ms(&index_dir.join("index.sqlite3")))
}

fn cached_index_directories(root: &Path) -> Vec<(PathBuf, u64, u64)> {
    let Ok(versions) = fs::read_dir(root) else {
        return Vec::new();
    };
    versions
        .flatten()
        .filter_map(|version| {
            version
                .file_type()
                .ok()
                .filter(|file_type| file_type.is_dir())
                .map(|_| version.path())
        })
        .flat_map(|version| fs::read_dir(version).into_iter().flatten().flatten())
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|file_type| file_type.is_dir())
                .map(|_| entry.path())
        })
        .filter(|path| path.join("index.sqlite3").is_file())
        .map(|path| {
            let size = directory_size(&path);
            let last_used = last_index_use(&path);
            (path, size, last_used)
        })
        .collect()
}

fn storage_status(app: &AppHandle) -> Result<SearchIndexStorageStatus, String> {
    let database = app.state::<Arc<Database>>();
    let settings = database.load_search_index_storage()?;
    let root = index_root_from_settings(app, &settings)?;
    let indexes = cached_index_directories(&root);
    Ok(SearchIndexStorageStatus {
        cache_root: display_path(&root),
        quota_bytes: settings.quota_bytes,
        used_bytes: indexes.iter().map(|(_, size, _)| *size).sum(),
        project_count: indexes.len() as u64,
    })
}

fn enforce_storage_quota(app: &AppHandle, keep: &Path) -> Result<(), String> {
    let database = app.state::<Arc<Database>>();
    let settings = database.load_search_index_storage()?;
    let root = index_root_from_settings(app, &settings)?;
    let mut indexes = cached_index_directories(&root);
    let mut used_bytes: u64 = indexes.iter().map(|(_, size, _)| *size).sum();
    indexes.sort_by_key(|(_, _, last_used)| *last_used);
    for (path, size, _) in indexes {
        if used_bytes <= settings.quota_bytes {
            break;
        }
        if path == keep {
            continue;
        }
        fs::remove_dir_all(&path)
            .map_err(|error| format!("Failed to evict old search index {}: {error}", path.display()))?;
        used_bytes = used_bytes.saturating_sub(size);
    }
    Ok(())
}

fn has_active_build(state: &SearchIndexState) -> bool {
    state.entries.lock().ok().is_some_and(|entries| {
        entries.values().any(|entry| matches!(entry.status.state.as_str(), "preflight" | "building"))
    })
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("Failed to create cache directory {}: {error}", destination.display()))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("Failed to read cache directory {}: {error}", source.display()))?
        .flatten()
    {
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect cache entry {}: {error}", source_path.display()))?;
        if file_type.is_dir() {
            copy_directory(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &destination_path).map_err(|error| {
                format!("Failed to copy cache entry {}: {error}", source_path.display())
            })?;
        }
    }
    Ok(())
}

fn relocate_index_root(source: &Path, destination: &Path) -> Result<(), String> {
    if source == destination || !source.exists() {
        return Ok(());
    }
    if destination.exists() {
        let is_empty = fs::read_dir(destination)
            .map_err(|error| format!("Failed to read destination cache directory: {error}"))?
            .next()
            .is_none();
        if !is_empty {
            return Err("The selected index cache folder is not empty".to_string());
        }
    }
    let temporary = destination.with_file_name(format!(
        ".termflow-search-index-moving-{}",
        now_ms()
    ));
    copy_directory(source, &temporary)?;
    if destination.exists() {
        fs::remove_dir(destination)
            .map_err(|error| format!("Failed to prepare destination cache directory: {error}"))?;
    }
    fs::rename(&temporary, destination)
        .map_err(|error| format!("Failed to activate relocated index cache: {error}"))?;
    fs::remove_dir_all(source)
        .map_err(|error| format!("Index cache was copied but the old cache could not be removed: {error}"))?;
    Ok(())
}

fn get_active_status(state: &SearchIndexState, key: &str) -> Option<ProjectSearchIndexStatus> {
    state
        .entries
        .lock()
        .ok()
        .and_then(|entries| entries.get(key).map(|entry| entry.status.clone()))
}

fn set_status(
    app: &AppHandle,
    state: &SearchIndexState,
    key: &str,
    job_id: u64,
    status: ProjectSearchIndexStatus,
) -> bool {
    let updated = state.entries.lock().ok().is_some_and(|mut entries| {
        let Some(entry) = entries.get_mut(key) else {
            return false;
        };
        if entry.job_id != job_id {
            return false;
        }
        entry.status = status.clone();
        true
    });
    if updated {
        let _ = app.emit("search-index-status", status);
    }
    updated
}

fn cancel_active_job(state: &SearchIndexState, key: &str) {
    if let Ok(entries) = state.entries.lock() {
        if let Some(entry) = entries.get(key) {
            entry.cancel.store(true, Ordering::Relaxed);
        }
    }
}

fn active_revision(state: &SearchIndexState, key: &str) -> Option<Arc<AtomicU64>> {
    state
        .entries
        .lock()
        .ok()
        .and_then(|entries| entries.get(key).map(|entry| entry.revision.clone()))
}

fn mark_index_stale(app: &AppHandle, state: &SearchIndexState, key: &str) {
    let status = state.entries.lock().ok().and_then(|mut entries| {
        let entry = entries.get_mut(key)?;
        entry.revision.fetch_add(1, Ordering::Relaxed);
        if entry.status.state != "ready" {
            return None;
        }
        entry.status.state = "stale".to_string();
        entry.status.backend = "scan".to_string();
        entry.status.phase = "waiting_changes".to_string();
        entry.status.updated_at = Some(now_ms());
        Some(entry.status.clone())
    });
    if let Some(status) = status {
        let _ = app.emit("search-index-status", status);
    }
}

fn event_requires_rebuild(project_path: &Path, event: &Event) -> bool {
    if matches!(event.kind, EventKind::Access(_)) {
        return false;
    }
    if event.need_rescan() {
        return true;
    }
    event.paths.iter().any(|path| {
        let Ok(relative) = path.strip_prefix(project_path) else {
            return false;
        };
        if relative.to_string_lossy().replace('\\', "/") == ".git/info/exclude" {
            return true;
        }
        !relative.components().any(|component| {
            let name = component.as_os_str().to_string_lossy();
            IGNORED_DIRECTORIES
                .iter()
                .any(|ignored| name.eq_ignore_ascii_case(ignored))
        })
    })
}

fn ensure_project_watcher(
    app: &AppHandle,
    state: &SearchIndexState,
    project: &ResolvedProject,
) -> Result<(), String> {
    let mut watchers = state
        .watchers
        .lock()
        .map_err(|_| "Failed to access search index watchers".to_string())?;
    if watchers.contains_key(&project.preference_key) {
        return Ok(());
    }

    let (sender, receiver) = mpsc::channel::<Result<Event, notify::Error>>();
    let watcher_config = Config::default()
        .with_poll_interval(Duration::from_secs(2))
        .with_compare_contents(false);
    let recommended_sender = sender.clone();
    let watcher: Box<dyn Watcher + Send> = match RecommendedWatcher::new(
        move |result| {
            let _ = recommended_sender.send(result);
        },
        watcher_config.clone(),
    )
    .and_then(|mut watcher| {
        watcher.watch(&project.path, RecursiveMode::Recursive)?;
        Ok(watcher)
    }) {
        Ok(watcher) => Box::new(watcher),
        Err(recommended_error) => {
            let poll_sender = sender.clone();
            let mut watcher = notify::PollWatcher::new(
                move |result| {
                    let _ = poll_sender.send(result);
                },
                watcher_config,
            )
            .map_err(|poll_error| {
                format!(
                    "Failed to create search index watcher: native={recommended_error}; poll={poll_error}"
                )
            })?;
            watcher
                .watch(&project.path, RecursiveMode::Recursive)
                .map_err(|poll_error| {
                    format!(
                        "Failed to watch project for index changes: native={recommended_error}; poll={poll_error}"
                    )
                })?;
            Box::new(watcher)
        }
    };

    let worker_app = app.clone();
    let worker_state = state.clone();
    let worker_project = project.clone();
    std::thread::Builder::new()
        .name(format!("termflow-index-watch-{}", project_hash(project)))
        .spawn(move || {
            while let Ok(result) = receiver.recv() {
                let mut rebuild_requested =
                    process_watcher_result(&worker_app, &worker_state, &worker_project, result);
                while let Ok(result) = receiver.recv_timeout(Duration::from_millis(500)) {
                    rebuild_requested |=
                        process_watcher_result(&worker_app, &worker_state, &worker_project, result);
                }
                if !rebuild_requested {
                    continue;
                }
                let should_rebuild =
                    get_active_status(&worker_state, &worker_project.preference_key)
                        .is_some_and(|status| status.enabled && status.state == "stale");
                if should_rebuild {
                    let _ = start_index_build(
                        worker_app.clone(),
                        worker_state.clone(),
                        worker_project.clone(),
                        true,
                    );
                }
            }
        })
        .map_err(|error| format!("Failed to start search index watcher worker: {error}"))?;

    watchers.insert(
        project.preference_key.clone(),
        ProjectIndexWatcher {
            _watcher: watcher,
            _sender: sender,
        },
    );
    Ok(())
}

fn process_watcher_result(
    app: &AppHandle,
    state: &SearchIndexState,
    project: &ResolvedProject,
    result: Result<Event, notify::Error>,
) -> bool {
    match result {
        Ok(event) if event_requires_rebuild(&project.path, &event) => {
            mark_index_stale(app, state, &project.preference_key);
            true
        }
        Ok(_) => false,
        Err(error) => {
            if let Some(revision) = active_revision(state, &project.preference_key) {
                revision.fetch_add(1, Ordering::Relaxed);
            }
            let mut status = get_active_status(state, &project.preference_key);
            if let Some(ref mut status) = status {
                status.state = "stale".to_string();
                status.backend = "scan".to_string();
                status.phase = "watch_failed".to_string();
                status.error = Some(format!("Search index watcher failed: {error}"));
                status.updated_at = Some(now_ms());
            }
            if let Some(status) = status {
                let job_id = state.entries.lock().ok().and_then(|entries| {
                    entries
                        .get(&project.preference_key)
                        .map(|entry| entry.job_id)
                });
                if let Some(job_id) = job_id {
                    set_status(app, state, &project.preference_key, job_id, status);
                }
            }
            false
        }
    }
}

fn stop_project_watcher(state: &SearchIndexState, key: &str) {
    if let Ok(mut watchers) = state.watchers.lock() {
        watchers.remove(key);
    }
}

fn start_index_build(
    app: AppHandle,
    state: SearchIndexState,
    project: ResolvedProject,
    force: bool,
) -> Result<ProjectSearchIndexStatus, String> {
    if !force {
        if let Some(status) = get_active_status(&state, &project.preference_key) {
            if matches!(status.state.as_str(), "preflight" | "building" | "ready") {
                return Ok(status);
            }
        }
    }

    cancel_active_job(&state, &project.preference_key);
    let job_id = state.next_job_id.fetch_add(1, Ordering::Relaxed) + 1;
    let cancel = Arc::new(AtomicBool::new(false));
    let revision = Arc::new(AtomicU64::new(0));
    let status = initial_build_status(project.display_path.clone());
    state
        .entries
        .lock()
        .map_err(|_| "Failed to initialize search index state".to_string())?
        .insert(
            project.preference_key.clone(),
            ActiveEntry {
                job_id,
                cancel: cancel.clone(),
                revision: revision.clone(),
                status: status.clone(),
            },
        );
    if let Err(error) = ensure_project_watcher(&app, &state, &project) {
        cancel.store(true, Ordering::Relaxed);
        if let Ok(mut entries) = state.entries.lock() {
            if entries
                .get(&project.preference_key)
                .is_some_and(|entry| entry.job_id == job_id)
            {
                entries.remove(&project.preference_key);
            }
        }
        return Err(error);
    }
    let start_revision = revision.load(Ordering::Relaxed);
    let _ = app.emit("search-index-status", status.clone());

    tauri::async_runtime::spawn_blocking(move || {
        let result = build_project_index(&app, &state, &project, job_id, start_revision, &cancel);
        if let Err(error) = result {
            if cancel.load(Ordering::Relaxed) {
                return;
            }
            let unsupported = error.contains("FTS5 is unavailable")
                || error.contains("no such module: fts5")
                || error.contains("no such tokenizer");
            let mut failed = get_active_status(&state, &project.preference_key)
                .unwrap_or_else(|| initial_build_status(project.display_path.clone()));
            failed.state = if unsupported {
                "unsupported".to_string()
            } else {
                "failed".to_string()
            };
            failed.phase = "failed".to_string();
            failed.backend = "scan".to_string();
            failed.updated_at = Some(now_ms());
            failed.error = Some(error);
            set_status(&app, &state, &project.preference_key, job_id, failed);
        }
    });

    Ok(status)
}

fn build_project_index(
    app: &AppHandle,
    state: &SearchIndexState,
    project: &ResolvedProject,
    job_id: u64,
    start_revision: u64,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let index_dir = index_directory(app, project)?;
    fs::create_dir_all(&index_dir)
        .map_err(|error| format!("Failed to create search index directory: {error}"))?;
    cleanup_temporary_indexes(&index_dir);
    let temp_path = index_dir.join(format!("index.build-{job_id}.sqlite3"));
    if temp_path.exists() {
        fs::remove_file(&temp_path)
            .map_err(|error| format!("Failed to remove stale temporary index: {error}"))?;
    }

    let mut status = get_active_status(state, &project.preference_key)
        .unwrap_or_else(|| initial_build_status(project.display_path.clone()));
    let mut last_emit = Instant::now();
    let candidates = discover_candidates(project, cancel, |discovered, bytes, skipped| {
        status.processed_files = discovered;
        status.processed_bytes = bytes;
        status.skipped_files = skipped;
        status.updated_at = Some(now_ms());
        if last_emit.elapsed() >= STATUS_EMIT_INTERVAL {
            set_status(app, state, &project.preference_key, job_id, status.clone());
            last_emit = Instant::now();
        }
    })?;
    if cancel.load(Ordering::Relaxed) {
        return Ok(());
    }

    let total_bytes = candidates.iter().map(|candidate| candidate.size).sum();
    let preflight_skipped = status.skipped_files;
    status.state = "building".to_string();
    status.phase = "writing".to_string();
    status.processed_files = 0;
    status.processed_bytes = 0;
    status.total_files = Some(candidates.len() as u64);
    status.total_bytes = Some(total_bytes);
    status.indexed_files = 0;
    status.updated_at = Some(now_ms());
    set_status(app, state, &project.preference_key, job_id, status.clone());

    let build_result = write_index_database(
        &temp_path,
        project,
        &candidates,
        cancel,
        |processed, indexed, skipped, bytes| {
            status.processed_files = processed;
            status.indexed_files = indexed;
            status.skipped_files = preflight_skipped.saturating_add(skipped);
            status.processed_bytes = bytes;
            status.updated_at = Some(now_ms());
            if last_emit.elapsed() >= STATUS_EMIT_INTERVAL || processed == candidates.len() as u64 {
                set_status(app, state, &project.preference_key, job_id, status.clone());
                last_emit = Instant::now();
            }
        },
    );

    if cancel.load(Ordering::Relaxed) {
        let _ = fs::remove_file(&temp_path);
        return Ok(());
    }
    if let Err(error) = build_result {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }

    status.phase = "finalizing".to_string();
    status.updated_at = Some(now_ms());
    set_status(app, state, &project.preference_key, job_id, status.clone());
    replace_index_atomically(&index_dir, &temp_path)?;

    let changed_during_build = active_revision(state, &project.preference_key)
        .is_some_and(|revision| revision.load(Ordering::Relaxed) != start_revision);
    if changed_during_build {
        status.state = "stale".to_string();
        status.phase = "replaying_changes".to_string();
        status.backend = "scan".to_string();
        status.updated_at = Some(now_ms());
        set_status(app, state, &project.preference_key, job_id, status);
        let _ = start_index_build(app.clone(), state.clone(), project.clone(), true);
        return Ok(());
    }

    let final_path = index_dir.join("index.sqlite3");
    status.state = "ready".to_string();
    status.phase = "ready".to_string();
    status.backend = "fts5".to_string();
    status.index_size_bytes = fs::metadata(&final_path)
        .map(|meta| meta.len())
        .unwrap_or(0);
    touch_index_usage(&index_dir);
    enforce_storage_quota(app, &index_dir)?;
    status.updated_at = Some(now_ms());
    status.error = None;
    set_status(app, state, &project.preference_key, job_id, status);
    Ok(())
}

fn discover_candidates<F>(
    project: &ResolvedProject,
    cancel: &AtomicBool,
    mut progress: F,
) -> Result<Vec<IndexCandidate>, String>
where
    F: FnMut(u64, u64, u64),
{
    let filter_root = project.path.clone();
    let mut builder = WalkBuilder::new(&project.path);
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
            let is_builtin = IGNORED_DIRECTORIES
                .iter()
                .any(|ignored| name.eq_ignore_ascii_case(ignored));
            !is_builtin && entry.path().starts_with(&filter_root)
        });

    let mut candidates = Vec::new();
    let mut discovered_bytes = 0_u64;
    let mut skipped = 0_u64;
    for entry in builder.build() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        let Some(file_type) = entry.file_type() else {
            skipped += 1;
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        if metadata.len() > MAX_FILE_BYTES {
            skipped += 1;
            continue;
        }
        let Some(relative_path) = entry
            .path()
            .strip_prefix(&project.path)
            .ok()
            .and_then(Path::to_str)
            .map(|path| path.replace('\\', "/"))
        else {
            skipped += 1;
            continue;
        };
        discovered_bytes = discovered_bytes.saturating_add(metadata.len());
        candidates.push(IndexCandidate {
            path: entry.path().to_path_buf(),
            relative_path,
            size: metadata.len(),
            modified_ns: modified_ns(&metadata),
        });
        progress(candidates.len() as u64, discovered_bytes, skipped);
    }
    Ok(candidates)
}

fn modified_ns(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().min(i64::MAX as u128) as i64)
        .unwrap_or_default()
}

fn write_index_database<F>(
    path: &Path,
    project: &ResolvedProject,
    candidates: &[IndexCandidate],
    cancel: &AtomicBool,
    mut progress: F,
) -> Result<(), String>
where
    F: FnMut(u64, u64, u64, u64),
{
    let mut connection = Connection::open(path)
        .map_err(|error| format!("Failed to create temporary search index: {error}"))?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = DELETE;
             PRAGMA synchronous = NORMAL;
             PRAGMA temp_store = MEMORY;
             CREATE TABLE index_meta (
               key TEXT PRIMARY KEY NOT NULL,
               value TEXT NOT NULL
             );
             CREATE TABLE indexed_files (
               id INTEGER PRIMARY KEY,
               relative_path TEXT UNIQUE NOT NULL,
               size INTEGER NOT NULL,
               modified_ns INTEGER NOT NULL,
               encoding TEXT NOT NULL,
               indexed_at INTEGER NOT NULL
             );
             CREATE VIRTUAL TABLE content_fts USING fts5(
               content,
               content='',
               contentless_delete=1,
               tokenize='trigram'
             );",
        )
        .map_err(|error| format!("FTS5 is unavailable or could not initialize: {error}"))?;

    let built_at = now_ms();
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Failed to start index transaction: {error}"))?;
    let mut indexed = 0_u64;
    let mut skipped = 0_u64;
    let mut processed_bytes = 0_u64;
    {
        let mut file_statement = transaction
            .prepare(
                "INSERT INTO indexed_files
                 (relative_path, size, modified_ns, encoding, indexed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )
            .map_err(|error| format!("Failed to prepare indexed file write: {error}"))?;
        let mut fts_statement = transaction
            .prepare("INSERT INTO content_fts(rowid, content) VALUES (?1, ?2)")
            .map_err(|error| format!("Failed to prepare FTS5 write: {error}"))?;

        for (index, candidate) in candidates.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return Ok(());
            }
            processed_bytes = processed_bytes.saturating_add(candidate.size);
            match read_text_file(&candidate.path) {
                Ok((content, encoding)) => {
                    file_statement
                        .execute(params![
                            candidate.relative_path,
                            candidate.size as i64,
                            candidate.modified_ns,
                            encoding.as_str(),
                            built_at as i64,
                        ])
                        .map_err(|error| {
                            format!("Failed to index {}: {error}", candidate.relative_path)
                        })?;
                    let row_id = transaction.last_insert_rowid();
                    fts_statement
                        .execute(params![row_id, content])
                        .map_err(|error| {
                            format!(
                                "Failed to write FTS data for {}: {error}",
                                candidate.relative_path
                            )
                        })?;
                    indexed += 1;
                }
                Err(_) => skipped += 1,
            }
            progress(index as u64 + 1, indexed, skipped, processed_bytes);
        }
    }

    if cancel.load(Ordering::Relaxed) {
        return Ok(());
    }
    let metadata = [
        ("schema_version", INDEX_SCHEMA_VERSION.to_string()),
        ("project_path", project.display_path.clone()),
        ("project_key", project.preference_key.clone()),
        ("state", "ready".to_string()),
        ("built_at", built_at.to_string()),
        ("total_files", candidates.len().to_string()),
        ("indexed_files", indexed.to_string()),
        ("skipped_files", skipped.to_string()),
        ("total_bytes", processed_bytes.to_string()),
    ];
    for (key, value) in metadata {
        transaction
            .execute(
                "INSERT INTO index_meta(key, value) VALUES (?1, ?2)",
                params![key, value],
            )
            .map_err(|error| format!("Failed to write index metadata: {error}"))?;
    }
    transaction
        .execute(
            "INSERT INTO content_fts(content_fts) VALUES ('optimize')",
            [],
        )
        .map_err(|error| format!("Failed to optimize FTS5 index: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Failed to commit search index: {error}"))?;

    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|error| format!("Failed to verify search index: {error}"))?;
    if integrity != "ok" {
        return Err(format!("Search index integrity check failed: {integrity}"));
    }
    let fts_count: u64 = connection
        .query_row("SELECT count(*) FROM content_fts", [], |row| row.get(0))
        .map_err(|error| format!("Failed to verify FTS5 rows: {error}"))?;
    if fts_count != indexed {
        return Err(format!(
            "Search index row count mismatch: expected {indexed}, found {fts_count}"
        ));
    }
    Ok(())
}

fn read_text_file(path: &Path) -> Result<(String, TextEncoding), String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("file grew beyond the index size limit".to_string());
    }
    if bytes.starts_with(&[0xff, 0xfe]) {
        return decode_utf16(&bytes[2..], true).map(|text| (text, TextEncoding::Utf16Le));
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        return decode_utf16(&bytes[2..], false).map(|text| (text, TextEncoding::Utf16Be));
    }
    if bytes.contains(&0) {
        return Err("binary file".to_string());
    }
    if let Some(content) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        return String::from_utf8(content.to_vec())
            .map(|text| (text, TextEncoding::Utf8Bom))
            .map_err(|error| error.to_string());
    }
    String::from_utf8(bytes)
        .map(|text| (text, TextEncoding::Utf8))
        .map_err(|error| error.to_string())
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> Result<String, String> {
    if bytes.len() % 2 != 0 {
        return Err("invalid UTF-16 byte length".to_string());
    }
    let units = bytes.chunks_exact(2).map(|pair| {
        if little_endian {
            u16::from_le_bytes([pair[0], pair[1]])
        } else {
            u16::from_be_bytes([pair[0], pair[1]])
        }
    });
    std::char::decode_utf16(units)
        .collect::<Result<String, _>>()
        .map_err(|error| error.to_string())
}

fn replace_index_atomically(index_dir: &Path, temp_path: &Path) -> Result<(), String> {
    let final_path = index_dir.join("index.sqlite3");
    let backup_path = index_dir.join("index.sqlite3.backup");
    if backup_path.exists() {
        fs::remove_file(&backup_path)
            .map_err(|error| format!("Failed to remove stale index backup: {error}"))?;
    }
    if final_path.exists() {
        fs::rename(&final_path, &backup_path)
            .map_err(|error| format!("Failed to preserve the previous search index: {error}"))?;
    }
    if let Err(error) = fs::rename(temp_path, &final_path) {
        if backup_path.exists() {
            let _ = fs::rename(&backup_path, &final_path);
        }
        return Err(format!("Failed to activate the new search index: {error}"));
    }
    if backup_path.exists() {
        let _ = fs::remove_file(backup_path);
    }
    Ok(())
}

fn cleanup_temporary_indexes(index_dir: &Path) {
    let Ok(entries) = fs::read_dir(index_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        if file_name.starts_with("index.build-") && file_name.ends_with(".sqlite3") {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn load_ready_status(
    app: &AppHandle,
    project: &ResolvedProject,
) -> Option<ProjectSearchIndexStatus> {
    let index_dir = index_directory(app, project).ok()?;
    let final_path = index_dir.join("index.sqlite3");
    let backup_path = index_dir.join("index.sqlite3.backup");
    if !final_path.exists() && backup_path.exists() {
        fs::rename(&backup_path, &final_path).ok()?;
    }
    let connection =
        Connection::open_with_flags(&final_path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let read_meta = |key: &str| -> Option<String> {
        connection
            .query_row(
                "SELECT value FROM index_meta WHERE key = ?1",
                [key],
                |row| row.get(0),
            )
            .ok()
    };
    if read_meta("schema_version")?.parse::<u32>().ok()? != INDEX_SCHEMA_VERSION
        || read_meta("project_key")? != project.preference_key
        || read_meta("state")?.as_str() != "ready"
    {
        return None;
    }
    let indexed_files = read_meta("indexed_files")?.parse().ok()?;
    let skipped_files = read_meta("skipped_files")?.parse().ok()?;
    let total_files = read_meta("total_files")?.parse().ok()?;
    let total_bytes = read_meta("total_bytes")?.parse().ok()?;
    let built_at = read_meta("built_at")?.parse().ok()?;
    Some(ProjectSearchIndexStatus {
        project_path: project.display_path.clone(),
        enabled: true,
        state: "ready".to_string(),
        backend: "fts5".to_string(),
        phase: "ready".to_string(),
        processed_files: total_files,
        total_files: Some(total_files),
        indexed_files,
        skipped_files,
        processed_bytes: total_bytes,
        total_bytes: Some(total_bytes),
        index_size_bytes: fs::metadata(final_path).map(|meta| meta.len()).unwrap_or(0),
        started_at: None,
        updated_at: Some(built_at),
        error: None,
    })
}

fn quote_fts5_literal(query: &str) -> String {
    format!("\"{}\"", query.replace('"', "\"\""))
}

fn query_candidate_relative_paths(
    connection: &Connection,
    query: &str,
    limit: usize,
) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(
            "SELECT indexed_files.relative_path
             FROM content_fts
             JOIN indexed_files ON indexed_files.id = content_fts.rowid
             WHERE content_fts MATCH ?1
             LIMIT ?2",
        )
        .map_err(|error| format!("index_query_prepare_failed: {error}"))?;
    let rows = statement
        .query_map(
            params![quote_fts5_literal(query), (limit + 1) as i64],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("index_query_failed: {error}"))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| format!("index_result_failed: {error}"))
}

pub(crate) fn lookup_index_candidates(
    app: &AppHandle,
    project_path: &str,
    query: &str,
    use_regex: bool,
) -> IndexCandidateLookup {
    let query = query.trim();
    if use_regex {
        return IndexCandidateLookup::Fallback {
            reason: "regex_query".to_string(),
            index_state: "not_applicable".to_string(),
        };
    }
    if query.chars().count() < 3 || query.contains('\0') {
        return IndexCandidateLookup::Fallback {
            reason: "query_too_short".to_string(),
            index_state: "not_applicable".to_string(),
        };
    }
    let project = match resolve_project(project_path) {
        Ok(project) => project,
        Err(error) => {
            return IndexCandidateLookup::Fallback {
                reason: error,
                index_state: "unavailable".to_string(),
            }
        }
    };
    let database = app.state::<Arc<Database>>();
    let enabled = database
        .load_project_search_index_enabled(&project.preference_key)
        .unwrap_or(false);
    if !enabled {
        return IndexCandidateLookup::Fallback {
            reason: "index_disabled".to_string(),
            index_state: "disabled".to_string(),
        };
    }

    let state = app.state::<SearchIndexState>();
    if get_active_status(&state, &project.preference_key).is_none() {
        if let Some(mut status) = load_ready_status(app, &project) {
            status.state = "stale".to_string();
            status.backend = "scan".to_string();
            status.phase = "reconciling".to_string();
            if let Ok(mut entries) = state.entries.lock() {
                entries.insert(
                    project.preference_key.clone(),
                    ActiveEntry {
                        job_id: 0,
                        cancel: Arc::new(AtomicBool::new(false)),
                        revision: Arc::new(AtomicU64::new(0)),
                        status,
                    },
                );
            }
        }
        let _ = start_index_build(app.clone(), state.inner().clone(), project.clone(), true);
    }

    let snapshot = state.entries.lock().ok().and_then(|entries| {
        let entry = entries.get(&project.preference_key)?;
        if entry.status.state != "ready" {
            return None;
        }
        Some((entry.job_id, entry.revision.load(Ordering::Relaxed)))
    });
    let Some((job_id, revision)) = snapshot else {
        let index_state = get_active_status(&state, &project.preference_key)
            .map(|status| status.state)
            .unwrap_or_else(|| "unavailable".to_string());
        return IndexCandidateLookup::Fallback {
            reason: "index_not_ready".to_string(),
            index_state,
        };
    };

    let final_path = match index_directory(app, &project) {
        Ok(directory) => directory.join("index.sqlite3"),
        Err(error) => {
            return IndexCandidateLookup::Fallback {
                reason: error,
                index_state: "unavailable".to_string(),
            }
        }
    };
    let connection =
        match Connection::open_with_flags(&final_path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
            Ok(connection) => connection,
            Err(error) => {
                return IndexCandidateLookup::Fallback {
                    reason: format!("index_open_failed: {error}"),
                    index_state: "ready".to_string(),
                }
            }
        };
    const CANDIDATE_LIMIT: usize = 50_000;
    let relative_paths = match query_candidate_relative_paths(&connection, query, CANDIDATE_LIMIT) {
        Ok(paths) => paths,
        Err(reason) => {
            return IndexCandidateLookup::Fallback {
                reason,
                index_state: "ready".to_string(),
            }
        }
    };
    if relative_paths.len() > CANDIDATE_LIMIT {
        return IndexCandidateLookup::Fallback {
            reason: "too_many_index_candidates".to_string(),
            index_state: "ready".to_string(),
        };
    }

    let still_current = state.entries.lock().ok().is_some_and(|entries| {
        entries.get(&project.preference_key).is_some_and(|entry| {
            entry.job_id == job_id
                && entry.status.state == "ready"
                && entry.revision.load(Ordering::Relaxed) == revision
        })
    });
    if !still_current {
        return IndexCandidateLookup::Fallback {
            reason: "index_changed_during_query".to_string(),
            index_state: "stale".to_string(),
        };
    }

    let paths = relative_paths
        .into_iter()
        .filter(|relative| {
            Path::new(relative)
                .components()
                .all(|component| matches!(component, std::path::Component::Normal(_)))
        })
        .map(|relative| project.path.join(relative))
        .collect();
    touch_index_usage(final_path.parent().unwrap_or_else(|| Path::new("")));
    IndexCandidateLookup::Ready {
        paths,
        generation: job_id,
    }
}

#[tauri::command]
pub fn get_search_index_status(
    app: AppHandle,
    database: State<'_, Arc<Database>>,
    state: State<'_, SearchIndexState>,
    project_path: String,
) -> Result<ProjectSearchIndexStatus, String> {
    let project = resolve_project(&project_path)?;
    let enabled = database.load_project_search_index_enabled(&project.preference_key)?;
    if !enabled {
        cancel_active_job(&state, &project.preference_key);
        stop_project_watcher(&state, &project.preference_key);
        return Ok(disabled_status(project.display_path));
    }
    if let Some(status) = get_active_status(&state, &project.preference_key) {
        return Ok(status);
    }
    if let Some(mut status) = load_ready_status(&app, &project) {
        status.state = "stale".to_string();
        status.backend = "scan".to_string();
        status.phase = "reconciling".to_string();
        state
            .entries
            .lock()
            .map_err(|_| "Failed to restore search index state".to_string())?
            .insert(
                project.preference_key.clone(),
                ActiveEntry {
                    job_id: 0,
                    cancel: Arc::new(AtomicBool::new(false)),
                    revision: Arc::new(AtomicU64::new(0)),
                    status,
                },
            );
        return start_index_build(app, state.inner().clone(), project, true);
    }
    start_index_build(app, state.inner().clone(), project, false)
}

#[tauri::command]
pub fn set_project_index_enabled(
    app: AppHandle,
    database: State<'_, Arc<Database>>,
    state: State<'_, SearchIndexState>,
    project_path: String,
    enabled: bool,
) -> Result<ProjectSearchIndexStatus, String> {
    let project = resolve_project(&project_path)?;
    database.save_project_search_index_enabled(&project.preference_key, enabled)?;
    if !enabled {
        cancel_active_job(&state, &project.preference_key);
        stop_project_watcher(&state, &project.preference_key);
        let status = disabled_status(project.display_path);
        let job_id = state.next_job_id.fetch_add(1, Ordering::Relaxed) + 1;
        state
            .entries
            .lock()
            .map_err(|_| "Failed to update search index state".to_string())?
            .insert(
                project.preference_key,
                ActiveEntry {
                    job_id,
                    cancel: Arc::new(AtomicBool::new(true)),
                    revision: Arc::new(AtomicU64::new(0)),
                    status: status.clone(),
                },
            );
        let _ = app.emit("search-index-status", status.clone());
        return Ok(status);
    }
    if let Some(mut status) = load_ready_status(&app, &project) {
        status.state = "stale".to_string();
        status.backend = "scan".to_string();
        status.phase = "reconciling".to_string();
        state
            .entries
            .lock()
            .map_err(|_| "Failed to restore search index state".to_string())?
            .insert(
                project.preference_key.clone(),
                ActiveEntry {
                    job_id: 0,
                    cancel: Arc::new(AtomicBool::new(false)),
                    revision: Arc::new(AtomicU64::new(0)),
                    status,
                },
            );
        return start_index_build(app, state.inner().clone(), project, true);
    }
    start_index_build(app, state.inner().clone(), project, false)
}

#[tauri::command]
pub fn rebuild_project_index(
    app: AppHandle,
    database: State<'_, Arc<Database>>,
    state: State<'_, SearchIndexState>,
    project_path: String,
) -> Result<ProjectSearchIndexStatus, String> {
    let project = resolve_project(&project_path)?;
    database.save_project_search_index_enabled(&project.preference_key, true)?;
    start_index_build(app, state.inner().clone(), project, true)
}

#[tauri::command]
pub fn get_search_index_storage_status(app: AppHandle) -> Result<SearchIndexStorageStatus, String> {
    storage_status(&app)
}

#[tauri::command]
pub fn set_search_index_storage(
    app: AppHandle,
    database: State<'_, Arc<Database>>,
    state: State<'_, SearchIndexState>,
    cache_root: Option<String>,
    quota_bytes: u64,
) -> Result<SearchIndexStorageStatus, String> {
    const MIN_QUOTA_BYTES: u64 = 256 * 1024 * 1024;
    if quota_bytes < MIN_QUOTA_BYTES {
        return Err("Search index cache limit must be at least 256 MiB".to_string());
    }
    if has_active_build(&state) {
        return Err("Wait for active search index builds to finish before moving the cache".to_string());
    }

    let mut settings = database.load_search_index_storage()?;
    let source_root = index_root_from_settings(&app, &settings)?;
    let default_root = default_index_root(&app)?;
    let custom_root = cache_root
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    if let Some(path) = &custom_root {
        if !path.is_absolute() {
            return Err("Search index cache folder must be an absolute path".to_string());
        }
        if path.is_file() {
            return Err("Search index cache folder points to a file".to_string());
        }
    }
    let destination_root = custom_root.unwrap_or_else(|| default_root.clone());
    relocate_index_root(&source_root, &destination_root)?;
    settings.cache_root = if destination_root == default_root {
        None
    } else {
        Some(display_path(&destination_root))
    };
    settings.quota_bytes = quota_bytes;
    database.save_search_index_storage(&settings)?;

    if let Ok(mut entries) = state.entries.lock() {
        for entry in entries.values() {
            entry.cancel.store(true, Ordering::Relaxed);
        }
        entries.clear();
    }
    if let Ok(mut watchers) = state.watchers.lock() {
        watchers.clear();
    }
    enforce_storage_quota(&app, &destination_root.join(".no-active-index"))?;
    storage_status(&app)
}

#[tauri::command]
pub fn clear_search_index_cache(
    app: AppHandle,
    state: State<'_, SearchIndexState>,
) -> Result<SearchIndexStorageStatus, String> {
    if has_active_build(&state) {
        return Err("Wait for active search index builds to finish before clearing the cache".to_string());
    }
    let root = index_root(&app)?;
    if root.exists() {
        fs::remove_dir_all(&root)
            .map_err(|error| format!("Failed to clear search index cache: {error}"))?;
    }
    if let Ok(mut entries) = state.entries.lock() {
        for entry in entries.values() {
            entry.cancel.store(true, Ordering::Relaxed);
        }
        entries.clear();
    }
    if let Ok(mut watchers) = state.watchers.lock() {
        watchers.clear();
    }
    storage_status(&app)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn test_project(path: &Path) -> ResolvedProject {
        let display = display_path(path);
        ResolvedProject {
            path: path.to_path_buf(),
            preference_key: display.replace('\\', "/").to_lowercase(),
            display_path: display,
        }
    }

    #[test]
    fn builds_queryable_trigram_index_and_skips_ignored_and_binary_files() {
        let root = tempdir().unwrap();
        fs::write(root.path().join("source.txt"), "alpha updateWrapper omega").unwrap();
        fs::write(root.path().join("quoted.txt"), "alpha OR \"beta\"").unwrap();
        fs::write(root.path().join("binary.dat"), [0, 1, 2, 3]).unwrap();
        fs::create_dir(root.path().join("node_modules")).unwrap();
        fs::write(
            root.path().join("node_modules").join("ignored.txt"),
            "updateWrapper",
        )
        .unwrap();
        let project = test_project(root.path());
        let cancel = AtomicBool::new(false);
        let candidates = discover_candidates(&project, &cancel, |_, _, _| {}).unwrap();
        assert_eq!(candidates.len(), 3);

        let database_path = root.path().join("index.sqlite3");
        write_index_database(
            &database_path,
            &project,
            &candidates,
            &cancel,
            |_, _, _, _| {},
        )
        .unwrap();
        let connection = Connection::open(database_path).unwrap();
        let matches = query_candidate_relative_paths(&connection, "updateWrapper", 10).unwrap();
        assert_eq!(matches, vec!["source.txt"]);
        let quoted = query_candidate_relative_paths(&connection, "alpha OR \"beta\"", 10).unwrap();
        assert_eq!(quoted, vec!["quoted.txt"]);
        let indexed: u64 = connection
            .query_row("SELECT count(*) FROM indexed_files", [], |row| row.get(0))
            .unwrap();
        assert_eq!(indexed, 2);
    }

    #[test]
    fn decodes_supported_text_encodings_and_rejects_binary_data() {
        let root = tempdir().unwrap();
        let utf8_bom = root.path().join("utf8-bom.txt");
        fs::write(&utf8_bom, [b"\xef\xbb\xbf".as_slice(), b"hello"].concat()).unwrap();
        assert_eq!(read_text_file(&utf8_bom).unwrap().1, TextEncoding::Utf8Bom);

        let utf16 = root.path().join("utf16.txt");
        let mut bytes = vec![0xff, 0xfe];
        bytes.extend("hello".encode_utf16().flat_map(u16::to_le_bytes));
        fs::write(&utf16, bytes).unwrap();
        assert_eq!(read_text_file(&utf16).unwrap().0, "hello");

        let binary = root.path().join("binary.dat");
        fs::write(&binary, [1, 0, 2]).unwrap();
        assert!(read_text_file(&binary).is_err());
    }

    #[test]
    fn disabled_status_is_explicitly_scan_backed() {
        let status = disabled_status("E:/projects/Termflow".to_string());
        assert!(!status.enabled);
        assert_eq!(status.state, "disabled");
        assert_eq!(status.backend, "scan");
    }

    #[test]
    fn watcher_filters_generated_directories_but_keeps_source_changes() {
        let root = tempdir().unwrap();
        let source_event = Event::new(EventKind::Modify(notify::event::ModifyKind::Any))
            .add_path(root.path().join("src").join("main.rs"));
        assert!(event_requires_rebuild(root.path(), &source_event));

        let target_event = Event::new(EventKind::Modify(notify::event::ModifyKind::Any)).add_path(
            root.path()
                .join("target")
                .join("debug")
                .join("termflow.exe"),
        );
        assert!(!event_requires_rebuild(root.path(), &target_event));

        let git_exclude_event = Event::new(EventKind::Modify(notify::event::ModifyKind::Any))
            .add_path(root.path().join(".git").join("info").join("exclude"));
        assert!(event_requires_rebuild(root.path(), &git_exclude_event));
    }

    #[test]
    fn fts_literal_quoting_escapes_query_syntax() {
        assert_eq!(
            quote_fts5_literal("alpha OR \"beta\""),
            "\"alpha OR \"\"beta\"\"\""
        );
    }

    #[test]
    fn relocating_cache_preserves_index_files() {
        let root = tempdir().unwrap();
        let source = root.path().join("old-cache");
        let destination = root.path().join("new-cache");
        let index = source.join("v1").join("project-a").join("index.sqlite3");
        fs::create_dir_all(index.parent().unwrap()).unwrap();
        fs::write(&index, "index-content").unwrap();

        relocate_index_root(&source, &destination).unwrap();

        assert!(!source.exists());
        assert_eq!(
            fs::read_to_string(destination.join("v1").join("project-a").join("index.sqlite3"))
                .unwrap(),
            "index-content"
        );
    }

    #[test]
    fn cached_indexes_include_size_and_last_use() {
        let root = tempdir().unwrap();
        let first = root.path().join("v1").join("first");
        let second = root.path().join("v1").join("second");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        fs::write(first.join("index.sqlite3"), [1_u8; 3]).unwrap();
        fs::write(second.join("index.sqlite3"), [2_u8; 5]).unwrap();
        fs::write(first.join("last-used"), "10").unwrap();
        fs::write(second.join("last-used"), "20").unwrap();

        let indexes = cached_index_directories(root.path());

        assert_eq!(indexes.len(), 2);
        assert!(indexes.iter().any(|(path, size, used)| {
            path == &first && *size >= 3 && *used == 10
        }));
        assert!(indexes.iter().any(|(path, size, used)| {
            path == &second && *size >= 5 && *used == 20
        }));
    }
}
