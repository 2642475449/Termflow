use crate::path_utils::normalize_input_path;
use git2::{Delta, DiffFindOptions, DiffOptions, ObjectType, Oid, Patch, Repository};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::diff::parse_patch_hunks;
use super::types::{GitDiffContentResult, GitDiffHunkResult};
use super::utils::{git_command, run_git_blocking};

static TURN_SEQUENCE: AtomicU64 = AtomicU64::new(1);
const CHECKPOINT_VERSION: u32 = 1;
const MAX_RETAINED_TURNS_PER_SESSION: usize = 100;
const REVIEWED_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1_000;
const CHECKPOINT_TIMEOUT_MESSAGE: &str = "Checkpoint capture timed out";
const CHECKPOINT_ADD_PATHS: &[&str] = &[
    ".",
    ":(exclude).claude/worktrees",
    ":(exclude,glob).claude/worktrees/**",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointSnapshot {
    pub commit_oid: String,
    pub tree_oid: String,
    pub reference: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDecision {
    Pending,
    Accepted,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointChangedFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub insertions: Option<usize>,
    pub deletions: Option<usize>,
    pub is_binary: bool,
    #[serde(default = "pending_decision")]
    pub decision: ReviewDecision,
}

fn pending_decision() -> ReviewDecision {
    ReviewDecision::Pending
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnReview {
    pub version: u32,
    pub id: String,
    pub session_id: String,
    pub agent_id: String,
    pub project_path: String,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    pub completion_source: Option<String>,
    pub attribution_confidence: String,
    pub baseline: CheckpointSnapshot,
    pub result: Option<CheckpointSnapshot>,
    #[serde(default)]
    pub files: Vec<CheckpointChangedFile>,
    #[serde(default)]
    pub hunk_decisions: HashMap<String, ReviewDecision>,
    pub insertions: usize,
    pub deletions: usize,
    pub review_status: String,
    pub reviewed_at: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnStartResult {
    pub turn: Option<AgentTurnReview>,
    pub completed_previous: Option<AgentTurnReview>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRestoreResult {
    pub safety_checkpoint: CheckpointSnapshot,
    pub turn: AgentTurnReview,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn hash_component(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())[..20].to_string()
}

fn new_turn_id(session_id: &str) -> String {
    let sequence = TURN_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    hash_component(&format!(
        "{session_id}:{}:{}:{sequence}",
        now_ms(),
        std::process::id()
    ))
}

fn command_error(output: &std::process::Output, fallback: &str) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        fallback.to_string()
    }
}

fn command_output_before_deadline(
    mut command: Command,
    deadline: Option<Instant>,
) -> Result<Output, String> {
    let Some(deadline) = deadline else {
        return command
            .output()
            .map_err(|error| format!("Failed to execute git checkpoint command: {error}"));
    };

    if Instant::now() >= deadline {
        return Err(CHECKPOINT_TIMEOUT_MESSAGE.to_string());
    }

    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to execute git checkpoint command: {error}"))?;

    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .map_err(|error| format!("Failed to read git checkpoint output: {error}"));
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CHECKPOINT_TIMEOUT_MESSAGE.to_string());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "Failed to wait for git checkpoint command: {error}"
                ));
            }
        }
    }
}

fn run_git_before_deadline(
    project_path: &str,
    args: &[&str],
    deadline: Option<Instant>,
) -> Result<String, String> {
    let mut command = git_command();
    command
        .args(args)
        .current_dir(normalize_input_path(project_path));
    let output = command_output_before_deadline(command, deadline)?;
    if !output.status.success() {
        return Err(command_error(&output, "Git command failed"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_git(project_path: &str, args: &[&str]) -> Result<String, String> {
    run_git_before_deadline(project_path, args, None)
}

fn run_git_raw(project_path: &str, args: &[&str]) -> Result<String, String> {
    let output = git_command()
        .args(args)
        .current_dir(normalize_input_path(project_path))
        .output()
        .map_err(|error| format!("Failed to execute git: {error}"))?;
    if !output.status.success() {
        return Err(command_error(&output, "Git command failed"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn git_common_dir_before_deadline(
    project_path: &str,
    deadline: Option<Instant>,
) -> Result<PathBuf, String> {
    let raw = run_git_before_deadline(project_path, &["rev-parse", "--git-common-dir"], deadline)?;
    let raw_path = PathBuf::from(raw);
    let path = if raw_path.is_absolute() {
        raw_path
    } else {
        normalize_input_path(project_path).join(raw_path)
    };
    Ok(path)
}

fn checkpoint_root(project_path: &str) -> Result<PathBuf, String> {
    checkpoint_root_before_deadline(project_path, None)
}

fn checkpoint_root_before_deadline(
    project_path: &str,
    deadline: Option<Instant>,
) -> Result<PathBuf, String> {
    Ok(git_common_dir_before_deadline(project_path, deadline)?
        .join("termflow")
        .join("checkpoints"))
}

fn turn_file_path(project_path: &str, session_id: &str, turn_id: &str) -> Result<PathBuf, String> {
    Ok(checkpoint_root(project_path)?
        .join("turns")
        .join(hash_component(session_id))
        .join(format!("{turn_id}.json")))
}

fn atomic_write_json(path: &Path, value: &AgentTurnReview) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Checkpoint metadata path has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create checkpoint metadata directory: {error}"))?;
    let temp = path.with_extension(format!(
        "json.tmp-{}",
        TURN_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Failed to encode checkpoint metadata: {error}"))?;
    fs::write(&temp, bytes)
        .map_err(|error| format!("Failed to write checkpoint metadata: {error}"))?;
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("Failed to replace checkpoint metadata: {error}"))?;
    }
    fs::rename(&temp, path)
        .map_err(|error| format!("Failed to publish checkpoint metadata: {error}"))?;
    Ok(())
}

fn load_turn(project_path: &str, turn_id: &str) -> Result<AgentTurnReview, String> {
    let root = checkpoint_root(project_path)?.join("turns");
    if !root.exists() {
        return Err("Checkpoint turn was not found".to_string());
    }
    for session_dir in fs::read_dir(&root)
        .map_err(|error| format!("Failed to read checkpoint directory: {error}"))?
    {
        let session_dir = session_dir.map_err(|error| error.to_string())?;
        let candidate = session_dir.path().join(format!("{turn_id}.json"));
        if candidate.is_file() {
            let bytes = fs::read(&candidate)
                .map_err(|error| format!("Failed to read checkpoint metadata: {error}"))?;
            return serde_json::from_slice(&bytes)
                .map_err(|error| format!("Invalid checkpoint metadata: {error}"));
        }
    }
    Err("Checkpoint turn was not found".to_string())
}

fn save_turn(turn: &AgentTurnReview) -> Result<(), String> {
    let path = turn_file_path(&turn.project_path, &turn.session_id, &turn.id)?;
    atomic_write_json(&path, turn)
}

fn delete_turn_refs(project_path: &str, session_id: &str, turn_id: &str) -> Result<(), String> {
    let prefix = format!(
        "refs/termflow/checkpoints/{}/{turn_id}/",
        hash_component(session_id)
    );
    let refs = run_git(
        project_path,
        &["for-each-ref", "--format=%(refname)", &prefix],
    )?;
    for reference in refs.lines().filter(|line| !line.trim().is_empty()) {
        let _ = run_git(project_path, &["update-ref", "-d", reference.trim()]);
    }
    Ok(())
}

fn delete_turn(turn: &AgentTurnReview) -> Result<(), String> {
    delete_turn_refs(&turn.project_path, &turn.session_id, &turn.id)?;
    let path = turn_file_path(&turn.project_path, &turn.session_id, &turn.id)?;
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("Failed to delete checkpoint turn: {error}"))?;
    }
    Ok(())
}

fn load_session_turns(
    project_path: &str,
    session_id: &str,
) -> Result<Vec<AgentTurnReview>, String> {
    let mut turns = Vec::new();
    let directory = checkpoint_root(project_path)?
        .join("turns")
        .join(hash_component(session_id));
    list_turn_files(&directory, &mut turns)?;
    turns.sort_by(|left, right| left.started_at.cmp(&right.started_at));
    Ok(turns)
}

fn prune_session_turns(project_path: &str, session_id: &str) -> Result<(), String> {
    let directory = checkpoint_root(project_path)?
        .join("turns")
        .join(hash_component(session_id));
    if !directory.exists() {
        return Ok(());
    }
    let mut turns = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else { continue };
        let Ok(turn) = serde_json::from_slice::<AgentTurnReview>(&bytes) else {
            continue;
        };
        turns.push((path, turn));
    }
    turns.sort_by(|left, right| right.1.started_at.cmp(&left.1.started_at));
    let cutoff = now_ms() - REVIEWED_RETENTION_MS;
    for (index, (path, turn)) in turns.into_iter().enumerate() {
        let resolved = matches!(
            turn.review_status.as_str(),
            "reviewed" | "restored" | "no_changes"
        );
        if resolved && (turn.updated_at < cutoff || index >= MAX_RETAINED_TURNS_PER_SESSION) {
            delete_turn_refs(project_path, session_id, &turn.id)?;
            fs::remove_file(path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn snapshot_ref(session_id: &str, turn_id: &str, phase: &str) -> String {
    let safe_phase = phase
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    format!(
        "refs/termflow/checkpoints/{}/{turn_id}/{safe_phase}",
        hash_component(session_id)
    )
}

fn git_head_oid_before_deadline(
    project_path: &str,
    deadline: Option<Instant>,
) -> Result<Option<String>, String> {
    match run_git_before_deadline(project_path, &["rev-parse", "--verify", "HEAD"], deadline) {
        Ok(head) => Ok(Some(head)),
        Err(error) if error == CHECKPOINT_TIMEOUT_MESSAGE => Err(error),
        Err(_) => Ok(None),
    }
}

fn create_snapshot(
    project_path: &str,
    session_id: &str,
    turn_id: &str,
    phase: &str,
) -> Result<CheckpointSnapshot, String> {
    create_snapshot_before_deadline(project_path, session_id, turn_id, phase, None)
}

fn create_snapshot_before_deadline(
    project_path: &str,
    session_id: &str,
    turn_id: &str,
    phase: &str,
    deadline: Option<Instant>,
) -> Result<CheckpointSnapshot, String> {
    run_git_before_deadline(
        project_path,
        &["rev-parse", "--is-inside-work-tree"],
        deadline,
    )?;
    let root = checkpoint_root_before_deadline(project_path, deadline)?;
    let temp_dir = root.join("tmp");
    fs::create_dir_all(&temp_dir)
        .map_err(|error| format!("Failed to create checkpoint temp directory: {error}"))?;
    let index_path = temp_dir.join(format!(
        "index-{turn_id}-{}",
        TURN_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let worktree = normalize_input_path(project_path);

    let run_with_index = |args: &[&str]| -> Result<String, String> {
        let mut command = git_command();
        command
            .args(args)
            .current_dir(&worktree)
            .env("GIT_INDEX_FILE", &index_path)
            .env("GIT_AUTHOR_NAME", "Termflow Checkpoint")
            .env("GIT_AUTHOR_EMAIL", "checkpoint@termflow.local")
            .env("GIT_COMMITTER_NAME", "Termflow Checkpoint")
            .env("GIT_COMMITTER_EMAIL", "checkpoint@termflow.local");
        let output = command_output_before_deadline(command, deadline)?;
        if !output.status.success() {
            return Err(command_error(&output, "Git checkpoint command failed"));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    };

    let result = (|| {
        let head = git_head_oid_before_deadline(project_path, deadline)?;
        if head.is_some() {
            run_with_index(&["read-tree", "HEAD"])?;
        } else {
            run_with_index(&["read-tree", "--empty"])?;
        }
        // This intentionally respects .gitignore. Ignored caches and secrets must not be
        // copied into Termflow-owned Git objects by default. Claude's nested worktrees are
        // runtime state rather than user-authored changes, so keep them out of checkpoints
        // without modifying the user's ignore configuration.
        let mut add_args = vec!["add", "-A", "--"];
        add_args.extend_from_slice(CHECKPOINT_ADD_PATHS);
        run_with_index(&add_args)?;
        let tree_oid = run_with_index(&["write-tree"])?;
        let message = format!("Termflow checkpoint {turn_id} {phase}");
        let mut owned_args = vec!["commit-tree".to_string(), tree_oid.clone()];
        if let Some(head) = head {
            owned_args.push("-p".to_string());
            owned_args.push(head);
        }
        owned_args.push("-m".to_string());
        owned_args.push(message);
        let borrowed_args = owned_args.iter().map(String::as_str).collect::<Vec<_>>();
        let commit_oid = run_with_index(&borrowed_args)?;
        let reference = snapshot_ref(session_id, turn_id, phase);
        run_git_before_deadline(
            project_path,
            &["update-ref", &reference, &commit_oid],
            deadline,
        )?;
        Ok(CheckpointSnapshot {
            commit_oid,
            tree_oid,
            reference,
            created_at: now_ms(),
        })
    })();

    let _ = fs::remove_file(&index_path);
    result
}

fn oid_is_binary(repo: &Repository, oid: Oid) -> bool {
    !oid.is_zero()
        && repo
            .find_blob(oid)
            .map(|blob| blob.is_binary())
            .unwrap_or(false)
}

fn delta_status(status: Delta) -> &'static str {
    match status {
        Delta::Added => "added",
        Delta::Deleted => "deleted",
        Delta::Renamed => "renamed",
        Delta::Copied => "copied",
        Delta::Typechange => "typechange",
        Delta::Unmodified => "unmodified",
        _ => "modified",
    }
}

fn collect_changes(
    project_path: &str,
    baseline_oid: &str,
    result_oid: &str,
) -> Result<Vec<CheckpointChangedFile>, String> {
    let repo = Repository::open(normalize_input_path(project_path))
        .map_err(|error| format!("Failed to open Git repository: {error}"))?;
    let baseline = repo
        .find_commit(Oid::from_str(baseline_oid).map_err(|error| error.to_string())?)
        .map_err(|error| format!("Baseline checkpoint is unavailable: {error}"))?;
    let result = repo
        .find_commit(Oid::from_str(result_oid).map_err(|error| error.to_string())?)
        .map_err(|error| format!("Result checkpoint is unavailable: {error}"))?;
    let baseline_tree = baseline.tree().map_err(|error| error.to_string())?;
    let result_tree = result.tree().map_err(|error| error.to_string())?;
    let mut options = DiffOptions::new();
    options.include_typechange(true);
    let mut diff = repo
        .diff_tree_to_tree(Some(&baseline_tree), Some(&result_tree), Some(&mut options))
        .map_err(|error| format!("Failed to compare checkpoints: {error}"))?;
    let mut find = DiffFindOptions::new();
    find.renames(true).copies(true);
    let _ = diff.find_similar(Some(&mut find));

    let mut files = Vec::new();
    for (index, delta) in diff.deltas().enumerate() {
        let old_path = delta
            .old_file()
            .path()
            .map(|path| path.to_string_lossy().to_string());
        let new_path = delta
            .new_file()
            .path()
            .map(|path| path.to_string_lossy().to_string());
        let path = new_path
            .clone()
            .or_else(|| old_path.clone())
            .unwrap_or_default();
        if path.is_empty() {
            continue;
        }
        let patch = Patch::from_diff(&diff, index)
            .map_err(|error| format!("Failed to inspect checkpoint patch: {error}"))?;
        let (insertions, deletions) = match patch {
            Some(ref patch) => {
                let (_, additions, deletions) = patch
                    .line_stats()
                    .map_err(|error| format!("Failed to inspect patch statistics: {error}"))?;
                (Some(additions), Some(deletions))
            }
            None => (None, None),
        };
        let is_binary = oid_is_binary(&repo, delta.old_file().id())
            || oid_is_binary(&repo, delta.new_file().id());
        files.push(CheckpointChangedFile {
            path,
            old_path: if old_path != new_path { old_path } else { None },
            status: delta_status(delta.status()).to_string(),
            insertions,
            deletions,
            is_binary,
            decision: ReviewDecision::Pending,
        });
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

#[cfg(test)]
pub fn begin_turn(
    project_path: &str,
    session_id: &str,
    agent_id: &str,
) -> Result<AgentTurnReview, String> {
    begin_turn_before_deadline(project_path, session_id, agent_id, None)
}

pub fn begin_turn_with_timeout(
    project_path: &str,
    session_id: &str,
    agent_id: &str,
    timeout: Duration,
) -> Result<AgentTurnReview, String> {
    begin_turn_before_deadline(
        project_path,
        session_id,
        agent_id,
        Some(Instant::now() + timeout),
    )
}

fn begin_turn_before_deadline(
    project_path: &str,
    session_id: &str,
    agent_id: &str,
    deadline: Option<Instant>,
) -> Result<AgentTurnReview, String> {
    let turn_id = new_turn_id(session_id);
    let baseline =
        create_snapshot_before_deadline(project_path, session_id, &turn_id, "baseline", deadline)?;
    let now = now_ms();
    let turn = AgentTurnReview {
        version: CHECKPOINT_VERSION,
        id: turn_id,
        session_id: session_id.to_string(),
        agent_id: agent_id.to_string(),
        project_path: project_path.to_string(),
        started_at: now,
        completed_at: None,
        completion_source: None,
        // Shared workspaces cannot prove authorship when another writer changes files during a turn.
        attribution_confidence: "medium".to_string(),
        baseline,
        result: None,
        files: Vec::new(),
        hunk_decisions: HashMap::new(),
        insertions: 0,
        deletions: 0,
        review_status: "running".to_string(),
        reviewed_at: None,
        updated_at: now,
    };
    save_turn(&turn)?;
    let _ = prune_session_turns(project_path, session_id);
    Ok(turn)
}

pub fn complete_turn(
    turn_id: &str,
    project_path: &str,
    source: &str,
) -> Result<AgentTurnReview, String> {
    complete_turn_before_deadline(turn_id, project_path, source, None)
}

pub fn complete_turn_with_timeout(
    turn_id: &str,
    project_path: &str,
    source: &str,
    timeout: Duration,
) -> Result<AgentTurnReview, String> {
    complete_turn_before_deadline(
        turn_id,
        project_path,
        source,
        Some(Instant::now() + timeout),
    )
}

fn complete_turn_before_deadline(
    turn_id: &str,
    project_path: &str,
    source: &str,
    deadline: Option<Instant>,
) -> Result<AgentTurnReview, String> {
    let mut turn = load_turn(project_path, turn_id)?;
    if turn.result.is_some() {
        return Ok(turn);
    }
    let result = create_snapshot_before_deadline(
        project_path,
        &turn.session_id,
        &turn.id,
        "result",
        deadline,
    )?;
    let files = collect_changes(project_path, &turn.baseline.commit_oid, &result.commit_oid)?;
    turn.insertions = files.iter().filter_map(|file| file.insertions).sum();
    turn.deletions = files.iter().filter_map(|file| file.deletions).sum();
    turn.review_status = if files.is_empty() {
        "no_changes".to_string()
    } else {
        "awaiting_review".to_string()
    };
    turn.files = files;
    turn.result = Some(result);
    turn.completed_at = Some(now_ms());
    turn.completion_source = Some(source.to_string());
    turn.updated_at = now_ms();
    save_turn(&turn)?;
    Ok(turn)
}

fn list_turn_files(root: &Path, output: &mut Vec<AgentTurnReview>) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            list_turn_files(&path, output)?;
        } else if path.extension().and_then(|value| value.to_str()) == Some("json") {
            let bytes = fs::read(&path).map_err(|error| error.to_string())?;
            if let Ok(turn) = serde_json::from_slice::<AgentTurnReview>(&bytes) {
                output.push(turn);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn checkpoint_list_turns(
    project_path: String,
    session_id: Option<String>,
) -> Result<Vec<AgentTurnReview>, String> {
    run_git_blocking("list checkpoints", move || {
        let mut turns = Vec::new();
        list_turn_files(&checkpoint_root(&project_path)?.join("turns"), &mut turns)?;
        if let Some(session_id) = session_id {
            turns.retain(|turn| turn.session_id == session_id);
        }
        // Reconcile metadata written by older versions. A turn whose every file or
        // hunk already has a decision is complete and must not remain in the inbox.
        for turn in &mut turns {
            if matches!(
                turn.review_status.as_str(),
                "awaiting_review" | "partially_reviewed"
            ) {
                let previous_status = turn.review_status.clone();
                if recompute_review_status(turn).is_ok() && turn.review_status != previous_status {
                    turn.updated_at = now_ms();
                    save_turn(turn)?;
                }
            }
        }
        turns.sort_by(|left, right| right.started_at.cmp(&left.started_at));
        Ok(turns)
    })
    .await
}

#[derive(Debug, PartialEq, Eq)]
enum CheckpointEntryContent {
    Missing,
    Text(String),
    Binary,
    Gitlink(String),
}

fn read_checkpoint_entry(
    repo: &Repository,
    commit_oid: &str,
    path: &str,
) -> Result<CheckpointEntryContent, String> {
    let commit = repo
        .find_commit(Oid::from_str(commit_oid).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    let tree = commit.tree().map_err(|error| error.to_string())?;
    let entry = match tree.get_path(Path::new(path)) {
        Ok(entry) => entry,
        Err(_) => return Ok(CheckpointEntryContent::Missing),
    };
    if entry.kind() == Some(ObjectType::Commit) {
        return Ok(CheckpointEntryContent::Gitlink(entry.id().to_string()));
    }
    if entry.kind() != Some(ObjectType::Blob) {
        let kind = entry
            .kind()
            .map(|value| format!("{value:?}").to_lowercase())
            .unwrap_or_else(|| "unknown".to_string());
        return Err(format!("Checkpoint entry type is not previewable: {kind}"));
    }
    let blob = repo
        .find_blob(entry.id())
        .map_err(|error| error.to_string())?;
    if blob.is_binary() {
        return Ok(CheckpointEntryContent::Binary);
    }
    Ok(CheckpointEntryContent::Text(
        String::from_utf8_lossy(blob.content()).to_string(),
    ))
}

fn text_or_empty(content: CheckpointEntryContent) -> Result<String, String> {
    match content {
        CheckpointEntryContent::Missing => Ok(String::new()),
        CheckpointEntryContent::Text(content) => Ok(content),
        CheckpointEntryContent::Binary => Ok(String::new()),
        CheckpointEntryContent::Gitlink(_) => {
            Err("Checkpoint entry changed between file and gitlink".to_string())
        }
    }
}

fn gitlink_or_empty(content: CheckpointEntryContent) -> Result<String, String> {
    match content {
        CheckpointEntryContent::Missing => Ok(String::new()),
        CheckpointEntryContent::Gitlink(oid) => Ok(oid),
        CheckpointEntryContent::Text(_) | CheckpointEntryContent::Binary => {
            Err("Checkpoint entry changed between file and gitlink".to_string())
        }
    }
}

fn checkpoint_file_diff_sync(
    project_path: &str,
    turn_id: &str,
    file_path: &str,
) -> Result<GitDiffContentResult, String> {
    let turn = load_turn(project_path, turn_id)?;
    let result = turn
        .result
        .as_ref()
        .ok_or_else(|| "Turn is still running".to_string())?;
    let file = turn
        .files
        .iter()
        .find(|item| item.path == file_path || item.old_path.as_deref() == Some(file_path))
        .ok_or_else(|| "File is not part of this turn".to_string())?;
    let repo =
        Repository::open(normalize_input_path(project_path)).map_err(|error| error.to_string())?;
    let original_path = file.old_path.as_deref().unwrap_or(&file.path);
    let original = read_checkpoint_entry(&repo, &turn.baseline.commit_oid, original_path)?;
    let modified = read_checkpoint_entry(&repo, &result.commit_oid, &file.path)?;
    let is_gitlink = matches!(&original, CheckpointEntryContent::Gitlink(_))
        || matches!(&modified, CheckpointEntryContent::Gitlink(_));
    let is_binary = matches!(&original, CheckpointEntryContent::Binary)
        || matches!(&modified, CheckpointEntryContent::Binary);
    let (original_content, modified_content, content_kind) = if is_gitlink {
        (
            gitlink_or_empty(original)?,
            gitlink_or_empty(modified)?,
            "gitlink",
        )
    } else {
        (
            text_or_empty(original)?,
            text_or_empty(modified)?,
            if is_binary { "binary" } else { "text" },
        )
    };

    Ok(GitDiffContentResult {
        file_path: file.path.clone(),
        original_content,
        modified_content,
        is_binary,
        content_kind: Some(content_kind.to_string()),
        original_label: format!("Turn {} start", &turn.id[..8]),
        modified_label: format!("Turn {} result", &turn.id[..8]),
    })
}

#[tauri::command]
pub async fn checkpoint_file_diff(
    project_path: String,
    turn_id: String,
    file_path: String,
) -> Result<GitDiffContentResult, String> {
    run_git_blocking("load checkpoint diff", move || {
        checkpoint_file_diff_sync(&project_path, &turn_id, &file_path)
    })
    .await
}

fn checkpoint_patch(
    project_path: &str,
    baseline: &str,
    result: &str,
    file_path: Option<&str>,
) -> Result<String, String> {
    let mut args = vec![
        "diff",
        "--binary",
        "--no-ext-diff",
        "--unified=3",
        baseline,
        result,
    ];
    if let Some(path) = file_path {
        args.push("--");
        args.push(path);
    }
    run_git_raw(project_path, &args)
}

#[tauri::command]
pub async fn checkpoint_file_hunks(
    project_path: String,
    turn_id: String,
    file_path: String,
) -> Result<GitDiffHunkResult, String> {
    run_git_blocking("load checkpoint hunks", move || {
        let turn = load_turn(&project_path, &turn_id)?;
        let result = turn
            .result
            .as_ref()
            .ok_or_else(|| "Turn is still running".to_string())?;
        let patch = checkpoint_patch(
            &project_path,
            &turn.baseline.commit_oid,
            &result.commit_oid,
            Some(&file_path),
        )?;
        let mut hunks = parse_patch_hunks(&patch);
        for hunk in &mut hunks {
            hunk.decision = turn
                .hunk_decisions
                .get(&hunk_key(&file_path, &hunk.header))
                .map(|decision| match decision {
                    ReviewDecision::Pending => "pending",
                    ReviewDecision::Accepted => "accepted",
                    ReviewDecision::Rejected => "rejected",
                })
                .map(str::to_string);
        }
        Ok(GitDiffHunkResult { file_path, hunks })
    })
    .await
}

fn hunk_key(path: &str, header: &str) -> String {
    format!("{}:{}", hash_component(path), hash_component(header))
}

fn file_hunks_fully_decided(
    turn: &AgentTurnReview,
    file: &CheckpointChangedFile,
) -> Result<bool, String> {
    let Some(result) = turn.result.as_ref() else {
        return Ok(false);
    };
    let patch = checkpoint_patch(
        &turn.project_path,
        &turn.baseline.commit_oid,
        &result.commit_oid,
        Some(&file.path),
    )?;
    let hunks = parse_patch_hunks(&patch);
    Ok(!hunks.is_empty()
        && hunks.iter().all(|hunk| {
            turn.hunk_decisions
                .get(&hunk_key(&file.path, &hunk.header))
                .is_some_and(|decision| *decision != ReviewDecision::Pending)
        }))
}

fn recompute_review_status(turn: &mut AgentTurnReview) -> Result<(), String> {
    if turn.files.is_empty() {
        turn.review_status = "no_changes".to_string();
        return Ok(());
    }

    let has_decisions = turn
        .files
        .iter()
        .any(|file| file.decision != ReviewDecision::Pending)
        || turn
            .hunk_decisions
            .values()
            .any(|decision| *decision != ReviewDecision::Pending);
    let mut all_files_decided = true;
    for file in &turn.files {
        if file.decision == ReviewDecision::Pending && !file_hunks_fully_decided(turn, file)? {
            all_files_decided = false;
            break;
        }
    }

    if turn.reviewed_at.is_some() || all_files_decided {
        turn.review_status = "reviewed".to_string();
        if turn.reviewed_at.is_none() {
            turn.reviewed_at = Some(now_ms());
        }
    } else if has_decisions {
        turn.review_status = "partially_reviewed".to_string();
    } else {
        turn.review_status = "awaiting_review".to_string();
    }
    Ok(())
}

#[tauri::command]
pub async fn checkpoint_set_file_decision(
    project_path: String,
    turn_id: String,
    file_path: String,
    decision: ReviewDecision,
) -> Result<AgentTurnReview, String> {
    run_git_blocking("save checkpoint review", move || {
        let mut turn = load_turn(&project_path, &turn_id)?;
        let file = turn
            .files
            .iter_mut()
            .find(|file| file.path == file_path)
            .ok_or_else(|| "File is not part of this turn".to_string())?;
        file.decision = decision;
        turn.updated_at = now_ms();
        recompute_review_status(&mut turn)?;
        save_turn(&turn)?;
        Ok(turn)
    })
    .await
}

fn single_hunk_patch(patch_text: &str, hunk_header: &str) -> Result<String, String> {
    let target = hunk_header.trim();
    let mut header = Vec::new();
    let mut selected = Vec::new();
    let mut saw_hunk = false;
    let mut in_target = false;
    for line in patch_text.lines() {
        if line.starts_with("@@") {
            saw_hunk = true;
            if in_target {
                break;
            }
            in_target = line.trim() == target;
            if in_target {
                selected.push(line);
            }
        } else if !saw_hunk {
            header.push(line);
        } else if in_target {
            selected.push(line);
        }
    }
    if selected.is_empty() {
        return Err("Checkpoint hunk was not found".to_string());
    }
    Ok(format!("{}\n{}\n", header.join("\n"), selected.join("\n")))
}

fn apply_patch(project_path: &str, patch: &str, reverse: bool) -> Result<(), String> {
    let execute = |check: bool| -> Result<(), String> {
        let mut command = git_command();
        command.arg("apply");
        if check {
            command.arg("--check");
        }
        if reverse {
            command.arg("--reverse");
        }
        let mut child = command
            .arg("--whitespace=nowarn")
            .current_dir(normalize_input_path(project_path))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Failed to start git apply: {error}"))?;
        child
            .stdin
            .take()
            .ok_or_else(|| "Failed to open git apply input".to_string())?
            .write_all(patch.as_bytes())
            .map_err(|error| format!("Failed to write checkpoint patch: {error}"))?;
        let output = child
            .wait_with_output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(format!(
                "Workspace changed after this turn; restore was stopped safely: {}",
                command_error(&output, "patch no longer applies")
            ));
        }
        Ok(())
    };
    execute(true)?;
    execute(false)
}

fn ensure_path_not_staged(project_path: &str, file_path: &str) -> Result<(), String> {
    let status = git_command()
        .args(["diff", "--cached", "--quiet", "--", file_path])
        .current_dir(normalize_input_path(project_path))
        .status()
        .map_err(|error| format!("Failed to inspect staged changes: {error}"))?;
    if status.success() {
        Ok(())
    } else if status.code() == Some(1) {
        Err(
            "This file has staged changes. Unstage it before rejecting checkpoint changes."
                .to_string(),
        )
    } else {
        Err("Failed to inspect staged changes".to_string())
    }
}

fn create_safety_snapshot(turn: &AgentTurnReview) -> Result<CheckpointSnapshot, String> {
    create_snapshot(
        &turn.project_path,
        &turn.session_id,
        &turn.id,
        &format!("pre-restore-{}", now_ms()),
    )
}

#[tauri::command]
pub async fn checkpoint_reject_file(
    project_path: String,
    turn_id: String,
    file_path: String,
) -> Result<CheckpointRestoreResult, String> {
    run_git_blocking("reject checkpoint file", move || {
        let mut turn = load_turn(&project_path, &turn_id)?;
        let result = turn
            .result
            .as_ref()
            .ok_or_else(|| "Turn is still running".to_string())?;
        let hunk_prefix = format!("{}:", hash_component(&file_path));
        if turn
            .hunk_decisions
            .keys()
            .any(|key| key.starts_with(&hunk_prefix))
        {
            return Err(
                "This file already has hunk decisions. Review the remaining hunks individually."
                    .to_string(),
            );
        }
        ensure_path_not_staged(&project_path, &file_path)?;
        let patch = checkpoint_patch(
            &project_path,
            &turn.baseline.commit_oid,
            &result.commit_oid,
            Some(&file_path),
        )?;
        if patch.trim().is_empty() {
            return Err("No file change is available to reject".to_string());
        }
        let safety_checkpoint = create_safety_snapshot(&turn)?;
        apply_patch(&project_path, &patch, true)?;
        if let Some(file) = turn.files.iter_mut().find(|file| file.path == file_path) {
            file.decision = ReviewDecision::Rejected;
        }
        turn.updated_at = now_ms();
        recompute_review_status(&mut turn)?;
        save_turn(&turn)?;
        Ok(CheckpointRestoreResult {
            safety_checkpoint,
            turn,
        })
    })
    .await
}

#[tauri::command]
pub async fn checkpoint_set_hunk_decision(
    project_path: String,
    turn_id: String,
    file_path: String,
    hunk_header: String,
    decision: ReviewDecision,
) -> Result<CheckpointRestoreResult, String> {
    run_git_blocking("review checkpoint hunk", move || {
        let mut turn = load_turn(&project_path, &turn_id)?;
        let result = turn
            .result
            .as_ref()
            .ok_or_else(|| "Turn is still running".to_string())?;
        let safety_checkpoint = if decision == ReviewDecision::Rejected {
            ensure_path_not_staged(&project_path, &file_path)?;
            let patch = checkpoint_patch(
                &project_path,
                &turn.baseline.commit_oid,
                &result.commit_oid,
                Some(&file_path),
            )?;
            let selected = single_hunk_patch(&patch, &hunk_header)?;
            let safety = create_safety_snapshot(&turn)?;
            apply_patch(&project_path, &selected, true)?;
            safety
        } else {
            turn.result.clone().unwrap()
        };
        turn.hunk_decisions
            .insert(hunk_key(&file_path, &hunk_header), decision);
        turn.updated_at = now_ms();
        recompute_review_status(&mut turn)?;
        save_turn(&turn)?;
        Ok(CheckpointRestoreResult {
            safety_checkpoint,
            turn,
        })
    })
    .await
}

#[tauri::command]
pub async fn checkpoint_mark_reviewed(
    project_path: String,
    turn_id: String,
) -> Result<AgentTurnReview, String> {
    run_git_blocking("mark checkpoint reviewed", move || {
        let mut turn = load_turn(&project_path, &turn_id)?;
        for file in &mut turn.files {
            if file.decision == ReviewDecision::Pending {
                file.decision = ReviewDecision::Accepted;
            }
        }
        turn.reviewed_at = Some(now_ms());
        turn.updated_at = now_ms();
        recompute_review_status(&mut turn)?;
        save_turn(&turn)?;
        Ok(turn)
    })
    .await
}

#[tauri::command]
pub async fn checkpoint_restore_turn(
    project_path: String,
    turn_id: String,
) -> Result<CheckpointRestoreResult, String> {
    run_git_blocking("restore checkpoint timeline", move || {
        restore_timeline_to_turn(&project_path, &turn_id)
    })
    .await
}

fn restore_timeline_to_turn(
    project_path: &str,
    turn_id: &str,
) -> Result<CheckpointRestoreResult, String> {
    let turn = load_turn(project_path, turn_id)?;
    let result = turn
        .result
        .as_ref()
        .ok_or_else(|| "Turn is still running".to_string())?;
    let timeline_boundary = turn.completed_at.unwrap_or(turn.started_at);
    let later_turns = load_session_turns(project_path, &turn.session_id)?
        .into_iter()
        .filter(|candidate| candidate.id != turn.id && candidate.started_at >= timeline_boundary)
        .collect::<Vec<_>>();
    if later_turns
        .iter()
        .any(|candidate| candidate.result.is_none())
    {
        return Err(
            "A later turn is still running. Finish it before restoring the timeline.".to_string(),
        );
    }
    let safety_checkpoint = restore_workspace_to_snapshot(&turn, &result.commit_oid)?;

    // Only discard future history after the workspace restore has succeeded.
    for later_turn in &later_turns {
        delete_turn(later_turn)?;
    }

    Ok(CheckpointRestoreResult {
        safety_checkpoint,
        turn,
    })
}

fn restore_workspace_to_snapshot(
    turn: &AgentTurnReview,
    target_commit_oid: &str,
) -> Result<CheckpointSnapshot, String> {
    // Capture the complete current workspace first. The restore patch is generated
    // against this exact snapshot, so timeline operations never depend on replaying
    // or reversing intermediate turns individually.
    let safety_checkpoint = create_safety_snapshot(turn)?;
    let changed_files = collect_changes(
        &turn.project_path,
        target_commit_oid,
        &safety_checkpoint.commit_oid,
    )?;
    for file in &changed_files {
        ensure_path_not_staged(&turn.project_path, &file.path)?;
        if let Some(old_path) = file.old_path.as_deref() {
            ensure_path_not_staged(&turn.project_path, old_path)?;
        }
    }
    let patch = checkpoint_patch(
        &turn.project_path,
        target_commit_oid,
        &safety_checkpoint.commit_oid,
        None,
    )?;
    if !patch.trim().is_empty() {
        apply_patch(&turn.project_path, &patch, true)?;
    }
    Ok(safety_checkpoint)
}

#[tauri::command]
pub async fn checkpoint_discard_turn(
    project_path: String,
    turn_id: String,
) -> Result<CheckpointRestoreResult, String> {
    run_git_blocking("discard checkpoint timeline", move || {
        discard_timeline_from_turn(&project_path, &turn_id)
    })
    .await
}

fn discard_timeline_from_turn(
    project_path: &str,
    turn_id: &str,
) -> Result<CheckpointRestoreResult, String> {
    let mut turn = load_turn(project_path, turn_id)?;
    if turn.result.is_none() {
        return Err("Turn is still running".to_string());
    }
    let timeline_boundary = turn.completed_at.unwrap_or(turn.started_at);
    let later_turns = load_session_turns(project_path, &turn.session_id)?
        .into_iter()
        .filter(|candidate| candidate.id != turn.id && candidate.started_at >= timeline_boundary)
        .collect::<Vec<_>>();
    if later_turns
        .iter()
        .any(|candidate| candidate.result.is_none())
    {
        return Err(
            "A later turn is still running. Finish it before discarding the timeline.".to_string(),
        );
    }

    let safety_checkpoint = restore_workspace_to_snapshot(&turn, &turn.baseline.commit_oid)?;
    for later_turn in &later_turns {
        delete_turn(later_turn)?;
    }
    for file in &mut turn.files {
        file.decision = ReviewDecision::Rejected;
    }
    turn.review_status = "restored".to_string();
    turn.reviewed_at = Some(now_ms());
    turn.updated_at = now_ms();
    save_turn(&turn)?;

    Ok(CheckpointRestoreResult {
        safety_checkpoint,
        turn,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    fn slow_test_command() -> Command {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 5",
        ]);
        command
    }

    #[cfg(not(target_os = "windows"))]
    fn slow_test_command() -> Command {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 5"]);
        command
    }

    #[test]
    fn checkpoint_command_is_terminated_at_its_deadline() {
        let started_at = Instant::now();
        let result = command_output_before_deadline(
            slow_test_command(),
            Some(Instant::now() + Duration::from_millis(150)),
        );

        assert_eq!(result.unwrap_err(), CHECKPOINT_TIMEOUT_MESSAGE);
        assert!(started_at.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn interactive_baseline_fails_open_when_its_budget_is_exhausted() {
        let repo = temp_repo("interactive-timeout");
        let started_at = Instant::now();
        let result = begin_turn_with_timeout(
            repo.to_string_lossy().as_ref(),
            "session-timeout",
            "claude",
            Duration::ZERO,
        );

        assert_eq!(result.unwrap_err(), CHECKPOINT_TIMEOUT_MESSAGE);
        assert!(started_at.elapsed() < Duration::from_secs(1));
        let _ = fs::remove_dir_all(repo);
    }

    fn temp_repo(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "termflow-checkpoint-{name}-{}-{}",
            std::process::id(),
            TURN_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        run_git(path.to_str().unwrap(), &["init"]).unwrap();
        run_git(path.to_str().unwrap(), &["config", "user.name", "Test"]).unwrap();
        run_git(
            path.to_str().unwrap(),
            &["config", "user.email", "test@example.com"],
        )
        .unwrap();
        fs::write(path.join("tracked.txt"), "base\n").unwrap();
        run_git(path.to_str().unwrap(), &["add", "tracked.txt"]).unwrap();
        run_git(path.to_str().unwrap(), &["commit", "-m", "base"]).unwrap();
        path
    }

    fn nested_repo(path: &Path) -> String {
        fs::create_dir_all(path).unwrap();
        run_git(path.to_str().unwrap(), &["init"]).unwrap();
        run_git(path.to_str().unwrap(), &["config", "user.name", "Test"]).unwrap();
        run_git(
            path.to_str().unwrap(),
            &["config", "user.email", "test@example.com"],
        )
        .unwrap();
        fs::write(path.join("nested.txt"), "first\n").unwrap();
        run_git(path.to_str().unwrap(), &["add", "nested.txt"]).unwrap();
        run_git(path.to_str().unwrap(), &["commit", "-m", "nested base"]).unwrap();
        run_git(path.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap()
    }

    #[test]
    fn baseline_excludes_preexisting_dirty_content_from_turn_diff() {
        let repo = temp_repo("dirty-baseline");
        fs::write(repo.join("tracked.txt"), "user dirty\n").unwrap();
        let turn = begin_turn(repo.to_str().unwrap(), "session-a", "generic").unwrap();
        fs::write(repo.join("tracked.txt"), "user dirty\nagent line\n").unwrap();
        let completed = complete_turn(&turn.id, repo.to_str().unwrap(), "test").unwrap();
        assert_eq!(completed.files.len(), 1);
        assert_eq!(completed.insertions, 1);
        assert_eq!(completed.deletions, 0);
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn checkpoint_excludes_claude_runtime_worktrees() {
        let repo = temp_repo("exclude-claude-worktree");
        let turn = begin_turn(repo.to_str().unwrap(), "session-exclude", "claude").unwrap();
        nested_repo(&repo.join(".claude/worktrees/agent-test"));

        let completed = complete_turn(&turn.id, repo.to_str().unwrap(), "test").unwrap();

        assert!(completed.files.is_empty());
        let result = completed.result.unwrap();
        assert!(run_git(
            repo.to_str().unwrap(),
            &[
                "ls-tree",
                "-r",
                &result.commit_oid,
                "--",
                ".claude/worktrees"
            ]
        )
        .unwrap()
        .is_empty());
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn checkpoint_previews_gitlinks_as_commit_references() {
        let repo = temp_repo("gitlink-preview");
        let nested = repo.join("vendor/dependency");
        let original_oid = nested_repo(&nested);
        run_git(repo.to_str().unwrap(), &["add", "vendor/dependency"]).unwrap();
        run_git(repo.to_str().unwrap(), &["commit", "-m", "add dependency"]).unwrap();
        let turn = begin_turn(repo.to_str().unwrap(), "session-gitlink", "generic").unwrap();

        fs::write(nested.join("nested.txt"), "second\n").unwrap();
        run_git(nested.to_str().unwrap(), &["add", "nested.txt"]).unwrap();
        run_git(nested.to_str().unwrap(), &["commit", "-m", "nested update"]).unwrap();
        let modified_oid = run_git(nested.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();

        let completed = complete_turn(&turn.id, repo.to_str().unwrap(), "test").unwrap();
        assert_eq!(completed.files.len(), 1);
        assert_eq!(completed.files[0].path, "vendor/dependency");
        let preview =
            checkpoint_file_diff_sync(repo.to_str().unwrap(), &turn.id, "vendor/dependency")
                .unwrap();
        assert_eq!(preview.content_kind.as_deref(), Some("gitlink"));
        assert_eq!(preview.original_content, original_oid);
        assert_eq!(preview.modified_content, modified_oid);
        assert!(!preview.is_binary);
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn checkpoint_does_not_move_head_or_user_index() {
        let repo = temp_repo("head-index");
        fs::write(repo.join("staged.txt"), "staged\n").unwrap();
        run_git(repo.to_str().unwrap(), &["add", "staged.txt"]).unwrap();
        let head_before = run_git(repo.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap();
        let staged_before =
            run_git(repo.to_str().unwrap(), &["diff", "--cached", "--name-only"]).unwrap();
        let _turn = begin_turn(repo.to_str().unwrap(), "session-b", "generic").unwrap();
        assert_eq!(
            run_git(repo.to_str().unwrap(), &["rev-parse", "HEAD"]).unwrap(),
            head_before
        );
        assert_eq!(
            run_git(repo.to_str().unwrap(), &["diff", "--cached", "--name-only"]).unwrap(),
            staged_before
        );
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn review_decisions_can_replace_persisted_metadata() {
        let repo = temp_repo("metadata-update");
        let turn = begin_turn(repo.to_str().unwrap(), "session-c", "generic").unwrap();
        fs::write(repo.join("tracked.txt"), "base\nagent\n").unwrap();
        let mut completed = complete_turn(&turn.id, repo.to_str().unwrap(), "test").unwrap();
        completed.files[0].decision = ReviewDecision::Accepted;
        save_turn(&completed).unwrap();
        let reloaded = load_turn(repo.to_str().unwrap(), &turn.id).unwrap();
        assert_eq!(reloaded.files[0].decision, ReviewDecision::Accepted);
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn deciding_the_only_hunk_automatically_completes_review() {
        let repo = temp_repo("single-hunk-review");
        let turn = begin_turn(repo.to_str().unwrap(), "session-hunk", "generic").unwrap();
        fs::write(repo.join("tracked.txt"), "base\nagent\n").unwrap();
        let mut completed = complete_turn(&turn.id, repo.to_str().unwrap(), "test").unwrap();
        let result = completed.result.as_ref().unwrap();
        let patch = checkpoint_patch(
            repo.to_str().unwrap(),
            &completed.baseline.commit_oid,
            &result.commit_oid,
            Some("tracked.txt"),
        )
        .unwrap();
        let hunks = parse_patch_hunks(&patch);
        assert_eq!(hunks.len(), 1);
        completed.hunk_decisions.insert(
            hunk_key("tracked.txt", &hunks[0].header),
            ReviewDecision::Rejected,
        );

        recompute_review_status(&mut completed).unwrap();

        assert_eq!(completed.review_status, "reviewed");
        assert!(completed.reviewed_at.is_some());
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn review_stays_partial_while_another_hunk_is_pending() {
        let repo = temp_repo("partial-hunk-review");
        let original = (1..=20)
            .map(|line| format!("line {line}"))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        fs::write(repo.join("tracked.txt"), &original).unwrap();
        let turn = begin_turn(repo.to_str().unwrap(), "session-partial", "generic").unwrap();
        let changed = original
            .replace("line 2\n", "line 2 changed\n")
            .replace("line 19\n", "line 19 changed\n");
        fs::write(repo.join("tracked.txt"), changed).unwrap();
        let mut completed = complete_turn(&turn.id, repo.to_str().unwrap(), "test").unwrap();
        let result = completed.result.as_ref().unwrap();
        let patch = checkpoint_patch(
            repo.to_str().unwrap(),
            &completed.baseline.commit_oid,
            &result.commit_oid,
            Some("tracked.txt"),
        )
        .unwrap();
        let hunks = parse_patch_hunks(&patch);
        assert_eq!(hunks.len(), 2);
        completed.hunk_decisions.insert(
            hunk_key("tracked.txt", &hunks[0].header),
            ReviewDecision::Accepted,
        );

        recompute_review_status(&mut completed).unwrap();

        assert_eq!(completed.review_status, "partially_reviewed");
        assert!(completed.reviewed_at.is_none());
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn inverse_patch_restores_turn_without_hard_reset() {
        let repo = temp_repo("restore");
        let turn = begin_turn(repo.to_str().unwrap(), "session-d", "generic").unwrap();
        fs::write(repo.join("tracked.txt"), "base\nagent\n").unwrap();
        let completed = complete_turn(&turn.id, repo.to_str().unwrap(), "test").unwrap();
        let result = completed.result.as_ref().unwrap();
        let patch = checkpoint_patch(
            repo.to_str().unwrap(),
            &completed.baseline.commit_oid,
            &result.commit_oid,
            None,
        )
        .unwrap();
        apply_patch(repo.to_str().unwrap(), &patch, true).unwrap();
        assert_eq!(
            fs::read_to_string(repo.join("tracked.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "base\n"
        );
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn inverse_patch_stops_when_same_lines_changed_later() {
        let repo = temp_repo("restore-conflict");
        let turn = begin_turn(repo.to_str().unwrap(), "session-e", "generic").unwrap();
        fs::write(repo.join("tracked.txt"), "agent changed\n").unwrap();
        let completed = complete_turn(&turn.id, repo.to_str().unwrap(), "test").unwrap();
        let result = completed.result.as_ref().unwrap();
        fs::write(repo.join("tracked.txt"), "user changed later\n").unwrap();
        let patch = checkpoint_patch(
            repo.to_str().unwrap(),
            &completed.baseline.commit_oid,
            &result.commit_oid,
            None,
        )
        .unwrap();
        assert!(apply_patch(repo.to_str().unwrap(), &patch, true).is_err());
        assert_eq!(
            fs::read_to_string(repo.join("tracked.txt")).unwrap(),
            "user changed later\n"
        );
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn timeline_restore_returns_to_selected_turn_and_deletes_later_turns() {
        let repo = temp_repo("timeline-restore");
        let project_path = repo.to_str().unwrap();

        let first = begin_turn(project_path, "session-timeline", "generic").unwrap();
        fs::write(repo.join("tracked.txt"), "base\nfirst\n").unwrap();
        let first = complete_turn(&first.id, project_path, "test").unwrap();

        let second = begin_turn(project_path, "session-timeline", "generic").unwrap();
        fs::write(repo.join("tracked.txt"), "base\nfirst\nsecond\n").unwrap();
        fs::write(repo.join("second.txt"), "keep me\n").unwrap();
        let second = complete_turn(&second.id, project_path, "test").unwrap();

        let third = begin_turn(project_path, "session-timeline", "generic").unwrap();
        fs::write(repo.join("tracked.txt"), "replaced by third\n").unwrap();
        fs::write(repo.join("third.txt"), "remove me\n").unwrap();
        let third = complete_turn(&third.id, project_path, "test").unwrap();

        restore_timeline_to_turn(project_path, &second.id).unwrap();

        assert_eq!(
            fs::read_to_string(repo.join("tracked.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "base\nfirst\nsecond\n"
        );
        assert_eq!(
            fs::read_to_string(repo.join("second.txt")).unwrap(),
            "keep me\n"
        );
        assert!(!repo.join("third.txt").exists());
        assert!(load_turn(project_path, &first.id).is_ok());
        assert!(load_turn(project_path, &second.id).is_ok());
        assert!(load_turn(project_path, &third.id).is_err());
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn timeline_restore_stops_while_a_later_turn_is_running() {
        let repo = temp_repo("timeline-running");
        let project_path = repo.to_str().unwrap();
        let first = begin_turn(project_path, "session-running", "generic").unwrap();
        fs::write(repo.join("tracked.txt"), "base\nfirst\n").unwrap();
        let first = complete_turn(&first.id, project_path, "test").unwrap();
        let running = begin_turn(project_path, "session-running", "generic").unwrap();

        let error = restore_timeline_to_turn(project_path, &first.id).unwrap_err();

        assert!(error.contains("later turn is still running"));
        assert!(load_turn(project_path, &running.id).is_ok());
        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn timeline_discard_restores_turn_start_and_removes_later_turns() {
        let repo = temp_repo("timeline-discard");
        let project_path = repo.to_str().unwrap();

        let first = begin_turn(project_path, "session-discard", "generic").unwrap();
        fs::write(repo.join("tracked.txt"), "base\nfirst\n").unwrap();
        let first = complete_turn(&first.id, project_path, "test").unwrap();

        let second = begin_turn(project_path, "session-discard", "generic").unwrap();
        fs::write(repo.join("tracked.txt"), "base\nfirst\nsecond\n").unwrap();
        fs::write(repo.join("second.txt"), "discard me\n").unwrap();
        let second = complete_turn(&second.id, project_path, "test").unwrap();

        let third = begin_turn(project_path, "session-discard", "generic").unwrap();
        fs::write(repo.join("third.txt"), "discard me too\n").unwrap();
        let third = complete_turn(&third.id, project_path, "test").unwrap();

        let restored = discard_timeline_from_turn(project_path, &second.id).unwrap();

        assert_eq!(
            fs::read_to_string(repo.join("tracked.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "base\nfirst\n"
        );
        assert!(!repo.join("second.txt").exists());
        assert!(!repo.join("third.txt").exists());
        assert_eq!(restored.turn.review_status, "restored");
        assert!(restored
            .turn
            .files
            .iter()
            .all(|file| file.decision == ReviewDecision::Rejected));
        assert!(load_turn(project_path, &first.id).is_ok());
        assert_eq!(
            load_turn(project_path, &second.id).unwrap().review_status,
            "restored"
        );
        assert!(load_turn(project_path, &third.id).is_err());
        assert!(!restored.safety_checkpoint.reference.is_empty());
        let _ = fs::remove_dir_all(repo);
    }
}
