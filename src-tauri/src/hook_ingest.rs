use crate::claude_rate_limits::{ingest_status_line_rate_limits, ClaudeRateLimitStore};
use crate::events::{emit_session_event, SessionEvent, SessionEventSeverity, SessionEventType};
use crate::pty::PtyManager;
use log::{error, info};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

#[derive(Clone)]
pub struct HookIngestConfig {
    pub port: u16,
    pub token: String,
}

#[derive(Debug, Deserialize)]
struct HookIngressPayload {
    event_type: Option<String>,
    event_id: Option<String>,
    agent: Option<String>,
    state: Option<String>,
    session_id: String,
    project_path: String,
    session_name: Option<String>,
    source: Option<String>,
    created_at: Option<i64>,
    provider_session_id: Option<String>,
    payload: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentStatusUpdate {
    event_id: String,
    revision: u64,
    session_id: String,
    project_path: String,
    session_name: String,
    agent: String,
    state: String,
    event_type: Option<String>,
    created_at: i64,
    duration_ms: Option<i64>,
    agent_session_id: Option<String>,
    metadata: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ToolPermissionCorrelation {
    tool_use_id: Option<String>,
    tool_fingerprint: Option<String>,
    permission_fingerprint: Option<String>,
    actor_fingerprint: String,
    has_explicit_actor: bool,
    created_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PermissionLifecycleEvent {
    UserPromptSubmit,
    PreToolUse,
    PermissionRequest,
    PermissionReplied,
    PermissionDenied,
    PostToolUse,
    PostToolUseFailure,
    Stop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClaudeTaskLifecycleEvent {
    UserPromptSubmit,
    SubagentStart,
    SubagentStop,
    Stop,
}

#[derive(Default)]
struct TaskCompletionCoordinator {
    generation: u64,
    generation_started_at: i64,
    active_subagents: HashSet<String>,
    recently_stopped_subagents: HashMap<String, i64>,
    subagent_seen: bool,
    unverifiable_subagent_seen: bool,
    activity_epoch: u64,
    completion_emitted_generation: Option<u64>,
}

#[derive(Default)]
struct SessionStatusGuard {
    revision: u64,
    last_event_id: Option<String>,
    last_state: Option<String>,
    last_event_type: Option<String>,
    last_created_at: i64,
    last_pre_tool: Option<ToolPermissionCorrelation>,
    pending_permission: Option<ToolPermissionCorrelation>,
    permission_pending: bool,
    task_coordinator: TaskCompletionCoordinator,
}

type StatusGuards = Arc<Mutex<HashMap<String, SessionStatusGuard>>>;

const COMPLETION_QUIET_MS: u64 = 1_500;
const MAX_STATUS_GUARDS: usize = 2_048;

pub fn create_ingest_config() -> Result<(HookIngestConfig, TcpListener), String> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("无法分配本地 Hook 接收端口: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("无法读取本地 Hook 接收端口: {e}"))?
        .port();
    let token = format!(
        "{:x}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    Ok((HookIngestConfig { port, token }, listener))
}

pub fn start_ingest_server(
    app: AppHandle,
    config: Arc<HookIngestConfig>,
    listener: TcpListener,
    manager: Arc<PtyManager>,
    claude_rate_limits: Arc<ClaudeRateLimitStore>,
) {
    thread::spawn(move || {
        let server = match tiny_http::Server::from_listener(listener, None) {
            Ok(server) => server,
            Err(error) => {
                let message = format!("Hook 接收服务启动失败: {error}");
                error!("{message}");
                notify_ingest_failure(&app, &message);
                return;
            }
        };
        info!("hook ingest server listening on 127.0.0.1:{}", config.port);
        let guards: StatusGuards = Arc::new(Mutex::new(HashMap::new()));

        for mut request in server.incoming_requests() {
            let request_path = request.url().to_string();
            if request.method() != &tiny_http::Method::Post
                || !matches!(
                    request_path.as_str(),
                    "/internal/session-events" | "/internal/claude-rate-limits"
                )
            {
                let _ = request
                    .respond(tiny_http::Response::from_string("not_found").with_status_code(404));
                continue;
            }

            let token_ok = request
                .headers()
                .iter()
                .find(|header| header.field.equiv("x-termflow-token"))
                .map(|header| header.value.as_str() == config.token)
                .unwrap_or(false);
            if !token_ok {
                let _ = request.respond(
                    tiny_http::Response::from_string("unauthorized").with_status_code(401),
                );
                continue;
            }

            let mut body = String::new();
            if request.as_reader().read_to_string(&mut body).is_err() {
                let _ = request
                    .respond(tiny_http::Response::from_string("bad_request").with_status_code(400));
                continue;
            }

            if request_path == "/internal/claude-rate-limits" {
                let response =
                    match ingest_status_line_rate_limits(&app, &claude_rate_limits, &body) {
                        Ok(()) => tiny_http::Response::from_string("ok").with_status_code(200),
                        Err(error) => {
                            error!("invalid Claude rate-limit payload: {error}");
                            tiny_http::Response::from_string("bad_json").with_status_code(400)
                        }
                    };
                let _ = request.respond(response);
                continue;
            }

            match serde_json::from_str::<HookIngressPayload>(&body) {
                Ok(payload) => {
                    handle_agent_status(&app, manager.clone(), guards.clone(), payload);
                    let _ = request
                        .respond(tiny_http::Response::from_string("ok").with_status_code(200));
                }
                Err(error) => {
                    error!("invalid agent hook payload: {error}");
                    let _ = request.respond(
                        tiny_http::Response::from_string("bad_json").with_status_code(400),
                    );
                }
            }
        }
    });
}

fn handle_agent_status(
    app: &AppHandle,
    manager: Arc<PtyManager>,
    guards: StatusGuards,
    payload: HookIngressPayload,
) {
    if payload.session_id.is_empty() || payload.project_path.is_empty() {
        return;
    }

    let Some(agent) = normalize_agent(payload.agent.as_deref().or(payload.source.as_deref()))
    else {
        return;
    };
    let created_at = payload.created_at.unwrap_or_else(now_ms);
    let task_lifecycle_event =
        normalize_claude_task_lifecycle_event(&agent, payload.event_type.as_deref());
    let actor_fingerprint = parse_actor_fingerprint(payload.payload.as_ref());

    if matches!(
        task_lifecycle_event,
        Some(ClaudeTaskLifecycleEvent::SubagentStart | ClaudeTaskLifecycleEvent::SubagentStop)
    ) {
        update_subagent_lifecycle(
            &guards,
            &payload.session_id,
            task_lifecycle_event.expect("subagent lifecycle was matched"),
            actor_fingerprint.as_deref(),
            created_at,
        );
        return;
    }

    let Some(state) = normalize_state(payload.state.as_deref(), payload.event_type.as_deref())
    else {
        return;
    };
    let permission_lifecycle_event =
        normalize_permission_lifecycle_event(&agent, payload.event_type.as_deref());
    let tool_permission_correlation = permission_lifecycle_event
        .and_then(|_| parse_tool_permission_correlation(payload.payload.as_ref(), created_at));
    let event_id = payload
        .event_id
        .unwrap_or_else(|| format!("{agent}:{}:{state}:{created_at}", payload.session_id));
    let session_name = payload
        .session_name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| payload.session_id.clone());
    let event_type = normalize_event_type(state, payload.event_type.as_deref()).map(str::to_string);
    let agent_session_id = normalize_provider_session_id(payload.provider_session_id.as_deref());
    let (revision, status_changed, completion_candidate, duration_ms) = {
        let Ok(mut map) = guards.lock() else { return };
        if !map.contains_key(&payload.session_id) && map.len() >= MAX_STATUS_GUARDS {
            if let Some(stale_key) = map.keys().next().cloned() {
                map.remove(&stale_key);
            }
        }
        let guard = map.entry(payload.session_id.clone()).or_default();
        if !guard_event_is_fresh(guard, &event_id, created_at) {
            return;
        }

        if task_lifecycle_event == Some(ClaudeTaskLifecycleEvent::Stop)
            && is_child_stop(
                &guard.task_coordinator,
                actor_fingerprint.as_deref(),
                created_at,
            )
        {
            return;
        }

        if supports_correlated_permissions(&agent) {
            if let Some(hook_event) = permission_lifecycle_event {
                if !prepare_permission_lifecycle_event(
                    guard,
                    hook_event,
                    tool_permission_correlation,
                ) {
                    return;
                }
            } else if should_suppress_uncorrelated_running(guard, state) {
                // Generic busy/working events are not proof that the permission
                // which produced the visible attention item was answered. This
                // matters for concurrent subagents and for OpenCode, whose
                // session can remain globally busy while one tool is blocked.
                return;
            }
        }
        let previous_state = guard.last_state.clone();
        let Some(result) =
            accept_guard_event(guard, &event_id, state, event_type.as_deref(), created_at)
        else {
            return;
        };
        if should_begin_task_generation(
            &guard.task_coordinator,
            state,
            previous_state.as_deref(),
            permission_lifecycle_event,
        ) {
            begin_task_generation(&mut guard.task_coordinator, created_at);
        } else if state != "completed" {
            invalidate_task_completion(&mut guard.task_coordinator);
        }
        let completion_candidate = if state == "completed" {
            completion_candidate_if_safe(&guard.task_coordinator, actor_fingerprint.as_deref())
        } else {
            None
        };
        let duration_ms = completion_candidate
            .and_then(|_| task_duration_ms(&guard.task_coordinator, created_at));
        (result.0, result.1, completion_candidate, duration_ms)
    };

    if state == "completed" && completion_candidate.is_none() {
        info!(
            "suppressing unverified Claude task completion for Termflow session {}",
            payload.session_id
        );
        return;
    }

    // Provider hook payloads can contain prompts, commands, environment data,
    // or credentials. Attention events persist locally, so use a positive
    // allowlist and never forward the raw provider payload.
    let mut metadata = sanitized_metadata(payload.payload.as_ref());
    if let (Some(duration), Some(object)) = (duration_ms, metadata.as_object_mut()) {
        object.insert("durationMs".into(), json!(duration));
        object.insert("durationSec".into(), json!((duration as f64) / 1000.0));
    }

    let event_id = completion_candidate
        .map(|candidate| {
            format!(
                "task-complete:{}:{}",
                payload.session_id, candidate.generation
            )
        })
        .unwrap_or(event_id);
    let update = AgentStatusUpdate {
        event_id: event_id.clone(),
        revision,
        session_id: payload.session_id.clone(),
        project_path: payload.project_path,
        session_name,
        agent,
        state: state.to_string(),
        event_type,
        created_at,
        duration_ms,
        agent_session_id,
        metadata,
    };

    if state == "completed" {
        let app = app.clone();
        let manager = manager.clone();
        let Some(candidate) = completion_candidate else {
            return;
        };
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(COMPLETION_QUIET_MS));
            let can_finalize = guards.lock().ok().and_then(|mut map| {
                let guard = map.get_mut(&update.session_id)?;
                claim_task_completion(&mut guard.task_coordinator, candidate)
                    .then_some(guard.revision == revision)
            }) == Some(true);
            if can_finalize {
                if let Ok(Some(review)) =
                    manager.complete_active_turn(&update.session_id, "provider_event")
                {
                    let _ = app.emit("checkpoint-review-ready", review);
                }
                emit_status_and_attention(&app, &update);
            }
        });
        return;
    }

    if status_changed {
        let _ = app.emit("agent-status", &update);
    }
    if should_emit_attention_event(state, update.event_type.as_deref()) {
        emit_attention_event(app, &update);
    }
}

fn emit_status_and_attention(app: &AppHandle, update: &AgentStatusUpdate) {
    let _ = app.emit("agent-status", update);
    emit_attention_event(app, update);
}

fn emit_attention_event(app: &AppHandle, update: &AgentStatusUpdate) {
    let (event_type, title, severity) = match update.event_type.as_deref() {
        Some("assistant_complete") => (
            SessionEventType::AssistantComplete,
            format!("{} 已完成本轮响应", agent_label(&update.agent)),
            SessionEventSeverity::Info,
        ),
        Some("permission_request") => (
            SessionEventType::PermissionRequest,
            format!("{} 正在等待你的授权", agent_label(&update.agent)),
            SessionEventSeverity::Warning,
        ),
        Some("waiting_input") => (
            SessionEventType::WaitingInput,
            format!("{} 正在等待你的操作", agent_label(&update.agent)),
            SessionEventSeverity::Warning,
        ),
        Some("hook_error") => (
            SessionEventType::HookError,
            format!("{} 状态连接发生错误", agent_label(&update.agent)),
            SessionEventSeverity::Error,
        ),
        _ => (
            SessionEventType::ProcessError,
            format!("{} 会话发生错误", agent_label(&update.agent)),
            SessionEventSeverity::Error,
        ),
    };
    emit_session_event(
        app,
        &SessionEvent {
            id: update.event_id.clone(),
            revision: Some(update.revision),
            session_id: update.session_id.clone(),
            project_path: update.project_path.clone(),
            session_name: update.session_name.clone(),
            event_type,
            title,
            body: update.session_name.clone(),
            severity,
            source: format!("{}_hook", update.agent),
            requires_attention: true,
            actionable: true,
            dedupe_key: Some(update.event_id.clone()),
            created_at: update.created_at,
            metadata: update.metadata.clone(),
        },
    );
}

fn normalize_state(state: Option<&str>, event_type: Option<&str>) -> Option<&'static str> {
    match state.unwrap_or_default().to_ascii_lowercase().as_str() {
        "working" | "running" | "busy" => return Some("running"),
        "waiting" | "blocked" => return Some("waiting"),
        "done" | "completed" | "idle" => return Some("completed"),
        "error" | "failed" => return Some("error"),
        _ => {}
    }
    match event_type.unwrap_or_default().to_ascii_lowercase().as_str() {
        "assistant_complete" => Some("completed"),
        "permission_request" | "session_start" | "waiting_input" => Some("waiting"),
        "tool_blocked"
        | "working"
        | "user_prompt_submit"
        | "pre_tool_use"
        | "permission_replied"
        | "permission_denied"
        | "post_tool_use"
        | "post_tool_use_failure" => Some("running"),
        "process_error" | "hook_error" => Some("error"),
        _ => None,
    }
}

fn normalize_claude_task_lifecycle_event(
    agent: &str,
    event_type: Option<&str>,
) -> Option<ClaudeTaskLifecycleEvent> {
    if agent != "claude" {
        return None;
    }
    let normalized = event_type?
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    match normalized.as_str() {
        "userpromptsubmit" => Some(ClaudeTaskLifecycleEvent::UserPromptSubmit),
        "subagentstart" => Some(ClaudeTaskLifecycleEvent::SubagentStart),
        "subagentstop" => Some(ClaudeTaskLifecycleEvent::SubagentStop),
        "assistantcomplete" | "stop" => Some(ClaudeTaskLifecycleEvent::Stop),
        _ => None,
    }
}

fn parse_actor_fingerprint(payload: Option<&serde_json::Value>) -> Option<String> {
    let payload = payload?.as_object()?;
    if !payload
        .get("hasExplicitActor")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    payload
        .get("actorFingerprint")
        .and_then(serde_json::Value::as_str)
        .filter(|value| is_safe_digest(value))
        .map(str::to_string)
}

fn begin_task_generation(coordinator: &mut TaskCompletionCoordinator, created_at: i64) {
    coordinator.generation = coordinator.generation.wrapping_add(1);
    coordinator.generation_started_at = created_at;
    coordinator.active_subagents.clear();
    coordinator.recently_stopped_subagents.clear();
    coordinator.subagent_seen = false;
    coordinator.unverifiable_subagent_seen = false;
    coordinator.activity_epoch = coordinator.activity_epoch.wrapping_add(1);
}

/// 通知计时以 Hook 生命周期为准。终端输入只是提问进入智能体的其中一条路径：
/// 拖放、语音和恢复的会话都会绕过它，因此不能作为唯一事实来源。
fn should_begin_task_generation(
    coordinator: &TaskCompletionCoordinator,
    state: &str,
    previous_state: Option<&str>,
    permission_event: Option<PermissionLifecycleEvent>,
) -> bool {
    if state != "running" {
        return false;
    }

    if permission_event == Some(PermissionLifecycleEvent::UserPromptSubmit) {
        return true;
    }

    coordinator.generation == 0 || matches!(previous_state, Some("completed" | "error"))
}

fn task_duration_ms(coordinator: &TaskCompletionCoordinator, completed_at: i64) -> Option<i64> {
    (coordinator.generation > 0 && coordinator.generation_started_at > 0)
        .then(|| (completed_at - coordinator.generation_started_at).max(0))
}

fn invalidate_task_completion(coordinator: &mut TaskCompletionCoordinator) {
    coordinator.activity_epoch = coordinator.activity_epoch.wrapping_add(1);
}

fn update_subagent_lifecycle(
    guards: &StatusGuards,
    session_id: &str,
    event: ClaudeTaskLifecycleEvent,
    actor_fingerprint: Option<&str>,
    created_at: i64,
) {
    let Ok(mut map) = guards.lock() else { return };
    let guard = map.entry(session_id.to_string()).or_default();
    let coordinator = &mut guard.task_coordinator;
    if created_at < coordinator.generation_started_at {
        return;
    }
    coordinator.subagent_seen = true;
    let Some(actor_fingerprint) = actor_fingerprint else {
        coordinator.unverifiable_subagent_seen = true;
        invalidate_task_completion(coordinator);
        info!("received Claude subagent lifecycle event without a verifiable actor identity");
        return;
    };
    prune_recent_subagents(coordinator, created_at);
    match event {
        ClaudeTaskLifecycleEvent::SubagentStart => {
            coordinator
                .active_subagents
                .insert(actor_fingerprint.to_string());
            coordinator
                .recently_stopped_subagents
                .remove(actor_fingerprint);
        }
        ClaudeTaskLifecycleEvent::SubagentStop => {
            coordinator.active_subagents.remove(actor_fingerprint);
            coordinator
                .recently_stopped_subagents
                .insert(actor_fingerprint.to_string(), created_at);
        }
        _ => return,
    }
    invalidate_task_completion(coordinator);
}

fn prune_recent_subagents(coordinator: &mut TaskCompletionCoordinator, created_at: i64) {
    const RECENT_SUBAGENT_MS: i64 = 15_000;
    coordinator
        .recently_stopped_subagents
        .retain(|_, stopped_at| created_at.saturating_sub(*stopped_at) <= RECENT_SUBAGENT_MS);
}

fn is_child_stop(
    coordinator: &TaskCompletionCoordinator,
    actor_fingerprint: Option<&str>,
    created_at: i64,
) -> bool {
    let Some(actor_fingerprint) = actor_fingerprint else {
        return false;
    };
    coordinator.active_subagents.contains(actor_fingerprint)
        || coordinator
            .recently_stopped_subagents
            .get(actor_fingerprint)
            .is_some_and(|stopped_at| created_at.saturating_sub(*stopped_at) <= 15_000)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CompletionCandidate {
    generation: u64,
    activity_epoch: u64,
}

fn completion_candidate_if_safe(
    coordinator: &TaskCompletionCoordinator,
    actor_fingerprint: Option<&str>,
) -> Option<CompletionCandidate> {
    if coordinator.generation == 0
        || coordinator.completion_emitted_generation == Some(coordinator.generation)
        || !coordinator.active_subagents.is_empty()
        || coordinator.unverifiable_subagent_seen
    {
        return None;
    }
    if coordinator.subagent_seen && actor_fingerprint.is_none() {
        return None;
    }
    Some(CompletionCandidate {
        generation: coordinator.generation,
        activity_epoch: coordinator.activity_epoch,
    })
}

fn claim_task_completion(
    coordinator: &mut TaskCompletionCoordinator,
    candidate: CompletionCandidate,
) -> bool {
    if coordinator.generation != candidate.generation
        || coordinator.activity_epoch != candidate.activity_epoch
        || coordinator.completion_emitted_generation == Some(candidate.generation)
        || !coordinator.active_subagents.is_empty()
        || coordinator.unverifiable_subagent_seen
    {
        return false;
    }
    coordinator.completion_emitted_generation = Some(candidate.generation);
    true
}

fn supports_correlated_permissions(agent: &str) -> bool {
    matches!(agent, "claude" | "codex" | "opencode" | "qoder")
}

fn normalize_permission_lifecycle_event(
    agent: &str,
    event_type: Option<&str>,
) -> Option<PermissionLifecycleEvent> {
    if !supports_correlated_permissions(agent) {
        return None;
    }
    let normalized = event_type?
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    match normalized.as_str() {
        "userpromptsubmit" => Some(PermissionLifecycleEvent::UserPromptSubmit),
        "pretooluse" | "toolblocked" => Some(PermissionLifecycleEvent::PreToolUse),
        "permissionrequest" => Some(PermissionLifecycleEvent::PermissionRequest),
        "permissionreplied" => Some(PermissionLifecycleEvent::PermissionReplied),
        "permissiondenied" => Some(PermissionLifecycleEvent::PermissionDenied),
        "posttooluse" => Some(PermissionLifecycleEvent::PostToolUse),
        "posttoolusefailure" => Some(PermissionLifecycleEvent::PostToolUseFailure),
        "assistantcomplete" | "stop" => Some(PermissionLifecycleEvent::Stop),
        _ => None,
    }
}

fn parse_tool_permission_correlation(
    payload: Option<&serde_json::Value>,
    created_at: i64,
) -> Option<ToolPermissionCorrelation> {
    let payload = payload?.as_object()?;
    let actor_fingerprint = payload.get("actorFingerprint")?.as_str()?;
    if !is_safe_digest(actor_fingerprint) {
        return None;
    }
    let tool_fingerprint = payload
        .get("toolFingerprint")
        .and_then(serde_json::Value::as_str)
        .filter(|value| is_safe_digest(value))
        .map(str::to_string);
    let permission_fingerprint = payload
        .get("permissionFingerprint")
        .and_then(serde_json::Value::as_str)
        .filter(|value| is_safe_digest(value))
        .map(str::to_string);
    let tool_use_id = payload
        .get("toolUseId")
        .and_then(serde_json::Value::as_str)
        .filter(|value| {
            (1..=256).contains(&value.len())
                && value.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
                })
        })
        .map(str::to_string);
    Some(ToolPermissionCorrelation {
        tool_use_id,
        tool_fingerprint,
        permission_fingerprint,
        actor_fingerprint: actor_fingerprint.to_string(),
        has_explicit_actor: payload
            .get("hasExplicitActor")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        created_at,
    })
}

fn is_safe_digest(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit())
}

fn correlations_match_permission(
    pending: &ToolPermissionCorrelation,
    candidate: &ToolPermissionCorrelation,
) -> bool {
    if candidate.created_at < pending.created_at {
        return false;
    }

    if let (Some(pending_permission), Some(candidate_permission)) = (
        pending.permission_fingerprint.as_deref(),
        candidate.permission_fingerprint.as_deref(),
    ) {
        return pending_permission == candidate_permission;
    }

    if let (Some(pending_tool_use_id), Some(candidate_tool_use_id)) = (
        pending.tool_use_id.as_deref(),
        candidate.tool_use_id.as_deref(),
    ) {
        let fingerprints_do_not_conflict = pending
            .tool_fingerprint
            .as_ref()
            .zip(candidate.tool_fingerprint.as_ref())
            .map_or(true, |(pending, candidate)| pending == candidate);
        return pending_tool_use_id == candidate_tool_use_id && fingerprints_do_not_conflict;
    }

    pending
        .tool_fingerprint
        .as_ref()
        .zip(candidate.tool_fingerprint.as_ref())
        .is_some_and(|(pending, candidate)| pending == candidate)
        && pending.has_explicit_actor
        && candidate.has_explicit_actor
        && pending.actor_fingerprint == candidate.actor_fingerprint
}

fn prepare_permission_lifecycle_event(
    guard: &mut SessionStatusGuard,
    event: PermissionLifecycleEvent,
    correlation: Option<ToolPermissionCorrelation>,
) -> bool {
    let waiting_for_permission = guard.last_state.as_deref() == Some("waiting")
        && guard.last_event_type.as_deref() == Some("permission_request");
    match event {
        PermissionLifecycleEvent::UserPromptSubmit | PermissionLifecycleEvent::Stop => {
            guard.last_pre_tool = None;
            guard.pending_permission = None;
            guard.permission_pending = false;
            true
        }
        PermissionLifecycleEvent::PreToolUse => {
            let resumes_permission = guard
                .pending_permission
                .as_ref()
                .zip(correlation.as_ref())
                .is_some_and(|(pending, candidate)| {
                    correlations_match_permission(pending, candidate)
                });
            guard.last_pre_tool = correlation;
            if waiting_for_permission && !resumes_permission {
                return false;
            }
            if resumes_permission {
                guard.pending_permission = None;
                guard.permission_pending = false;
                guard.last_pre_tool = None;
            }
            true
        }
        PermissionLifecycleEvent::PermissionRequest => {
            let mut pending = correlation;
            if let (Some(previous), Some(pending)) =
                (guard.last_pre_tool.as_ref(), pending.as_mut())
            {
                if pending.created_at >= previous.created_at
                    && pending.tool_fingerprint.is_some()
                    && pending.tool_fingerprint == previous.tool_fingerprint
                    && pending.actor_fingerprint == previous.actor_fingerprint
                    && pending.tool_use_id.is_none()
                {
                    pending.tool_use_id.clone_from(&previous.tool_use_id);
                }
            }
            guard.pending_permission = pending;
            guard.permission_pending = true;
            true
        }
        PermissionLifecycleEvent::PermissionReplied => {
            let resumes_permission = guard
                .pending_permission
                .as_ref()
                .zip(correlation.as_ref())
                .is_some_and(|(pending, candidate)| {
                    correlations_match_permission(pending, candidate)
                });
            if waiting_for_permission && !resumes_permission {
                return false;
            }
            if resumes_permission {
                guard.pending_permission = None;
                guard.permission_pending = false;
            }
            true
        }
        PermissionLifecycleEvent::PermissionDenied => {
            let correlation_conflicts = guard
                .pending_permission
                .as_ref()
                .zip(correlation.as_ref())
                .is_some_and(|(pending, candidate)| {
                    !correlations_match_permission(pending, candidate)
                });
            if waiting_for_permission && correlation_conflicts {
                return false;
            }
            guard.last_pre_tool = None;
            guard.pending_permission = None;
            guard.permission_pending = false;
            true
        }
        PermissionLifecycleEvent::PostToolUse | PermissionLifecycleEvent::PostToolUseFailure => {
            let resumes_permission = guard
                .pending_permission
                .as_ref()
                .zip(correlation.as_ref())
                .is_some_and(|(pending, candidate)| {
                    correlations_match_permission(pending, candidate)
                });
            if waiting_for_permission && !resumes_permission {
                return false;
            }
            if resumes_permission {
                guard.pending_permission = None;
                guard.permission_pending = false;
            }
            if guard
                .last_pre_tool
                .as_ref()
                .zip(correlation.as_ref())
                .is_some_and(|(previous, candidate)| {
                    correlations_match_permission(previous, candidate)
                })
            {
                guard.last_pre_tool = None;
            }
            true
        }
    }
}

fn should_suppress_uncorrelated_running(guard: &SessionStatusGuard, state: &str) -> bool {
    state == "running"
        && guard.last_state.as_deref() == Some("waiting")
        && guard.last_event_type.as_deref() == Some("permission_request")
        && guard.permission_pending
}

fn guard_event_is_fresh(guard: &SessionStatusGuard, event_id: &str, created_at: i64) -> bool {
    guard.last_event_id.as_deref() != Some(event_id) && created_at >= guard.last_created_at
}

fn accept_guard_event(
    guard: &mut SessionStatusGuard,
    event_id: &str,
    state: &str,
    event_type: Option<&str>,
    created_at: i64,
) -> Option<(u64, bool)> {
    if guard.last_event_id.as_deref() == Some(event_id) || created_at < guard.last_created_at {
        return None;
    }
    let status_changed = guard.last_state.as_deref() != Some(state);
    let event_type_changed = guard.last_event_type.as_deref() != event_type &&
        // A generic waiting event must not downgrade an already-known
        // permission request within the same waiting state.
        !(state == "waiting"
            && guard.last_event_type.as_deref() == Some("permission_request")
            && event_type == Some("waiting_input"));
    if !status_changed && !event_type_changed {
        return None;
    }
    guard.last_event_id = Some(event_id.to_string());
    guard.last_state = Some(state.to_string());
    guard.last_event_type = event_type.map(str::to_string);
    guard.last_created_at = created_at;
    guard.revision = guard.revision.wrapping_add(1);
    Some((guard.revision, status_changed))
}

fn sanitized_metadata(_payload: Option<&serde_json::Value>) -> serde_json::Value {
    // This is intentionally a positive allowlist. Provider payload schemas are
    // not stable and commonly contain prompts, commands, paths, and environment
    // values. Safe Termflow-owned fields such as duration are added later.
    json!({})
}

fn normalize_event_type(state: &str, event_type: Option<&str>) -> Option<&'static str> {
    let normalized = event_type
        .unwrap_or_default()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    match normalized.as_str() {
        "assistantcomplete" | "stop" => Some("assistant_complete"),
        "sessionstart" => Some("session_start"),
        "permissionrequest" | "permissionasked" => Some("permission_request"),
        "permissiondenied" => Some("permission_denied"),
        "waitinginput" | "questionasked" => Some("waiting_input"),
        "processerror" | "sessionerror" => Some("process_error"),
        "hookerror" => Some("hook_error"),
        _ => match state {
            "completed" => Some("assistant_complete"),
            "waiting" => Some("waiting_input"),
            "error" => Some("process_error"),
            _ => None,
        },
    }
}

fn should_emit_attention_event(state: &str, event_type: Option<&str>) -> bool {
    (state == "waiting" || state == "error")
        && event_type.is_some()
        && event_type != Some("session_start")
}

fn normalize_agent(agent: Option<&str>) -> Option<String> {
    match agent?.to_ascii_lowercase().as_str() {
        "claude" => Some("claude"),
        "codex" => Some("codex"),
        "qoder" => Some("qoder"),
        "antigravity" => Some("antigravity"),
        "opencode" => Some("opencode"),
        _ => None,
    }
    .map(str::to_string)
}

fn agent_label(agent: &str) -> &'static str {
    match agent {
        "codex" => "Codex",
        "qoder" => "Qoder CLI",
        "antigravity" => "Antigravity CLI",
        "opencode" => "OpenCode",
        _ => "Claude Code",
    }
}

fn normalize_provider_session_id(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    if (8..=128).contains(&value.len())
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        Some(value.to_string())
    } else {
        None
    }
}

fn notify_ingest_failure(app: &AppHandle, message: &str) {
    emit_session_event(
        app,
        &SessionEvent {
            id: format!("hook-ingest-fail:{}", now_ms()),
            revision: None,
            session_id: "__system__".to_string(),
            project_path: String::new(),
            session_name: "Termflow 系统".to_string(),
            event_type: SessionEventType::HookError,
            title: "Hook 接收服务启动失败".to_string(),
            body: message.to_string(),
            severity: SessionEventSeverity::Error,
            source: "hook_ingest".to_string(),
            requires_attention: true,
            actionable: false,
            dedupe_key: Some("hook-ingest-fail".to_string()),
            created_at: now_ms(),
            metadata: json!({ "kind": "ingest_startup_failure" }),
        },
    );
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::{
        accept_guard_event, agent_label, begin_task_generation, claim_task_completion,
        completion_candidate_if_safe, is_child_stop, normalize_agent,
        normalize_claude_task_lifecycle_event, normalize_event_type,
        normalize_permission_lifecycle_event, normalize_provider_session_id, normalize_state,
        parse_actor_fingerprint, parse_tool_permission_correlation,
        prepare_permission_lifecycle_event, sanitized_metadata, should_begin_task_generation,
        should_emit_attention_event, should_suppress_uncorrelated_running, task_duration_ms,
        update_subagent_lifecycle, ClaudeTaskLifecycleEvent, PermissionLifecycleEvent,
        SessionStatusGuard, StatusGuards, TaskCompletionCoordinator, ToolPermissionCorrelation,
    };
    use serde_json::json;

    #[test]
    fn normalizes_claude_subagent_lifecycle_events() {
        assert_eq!(
            normalize_claude_task_lifecycle_event("claude", Some("SubagentStart")),
            Some(ClaudeTaskLifecycleEvent::SubagentStart)
        );
        assert_eq!(
            normalize_claude_task_lifecycle_event("claude", Some("SubagentStop")),
            Some(ClaudeTaskLifecycleEvent::SubagentStop)
        );
        assert_eq!(
            normalize_claude_task_lifecycle_event("codex", Some("SubagentStop")),
            None
        );
    }

    #[test]
    fn accepts_only_explicit_safe_actor_fingerprints() {
        let digest = "a".repeat(64);
        assert_eq!(
            parse_actor_fingerprint(Some(&json!({
                "actorFingerprint": digest,
                "hasExplicitActor": true
            })))
            .as_deref(),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
        assert!(parse_actor_fingerprint(Some(&json!({
            "actorFingerprint": "not-a-digest",
            "hasExplicitActor": true
        })))
        .is_none());
        assert!(parse_actor_fingerprint(Some(&json!({
            "actorFingerprint": "a".repeat(64),
            "hasExplicitActor": false
        })))
        .is_none());
    }

    #[test]
    fn subagent_completion_requires_a_verified_root_stop() {
        let mut coordinator = TaskCompletionCoordinator::default();
        begin_task_generation(&mut coordinator, 100);
        coordinator.subagent_seen = true;
        coordinator.active_subagents.insert("child".to_string());

        assert!(completion_candidate_if_safe(&coordinator, Some("root")).is_none());
        coordinator.active_subagents.remove("child");
        assert!(completion_candidate_if_safe(&coordinator, None).is_none());
        let candidate = completion_candidate_if_safe(&coordinator, Some("root")).unwrap();
        assert_eq!(candidate.generation, 1);
        assert!(claim_task_completion(&mut coordinator, candidate));
        assert!(!claim_task_completion(&mut coordinator, candidate));
    }

    #[test]
    fn a_new_prompt_invalidates_a_previous_completion_candidate() {
        let mut coordinator = TaskCompletionCoordinator::default();
        begin_task_generation(&mut coordinator, 100);
        let candidate = completion_candidate_if_safe(&coordinator, None).unwrap();
        begin_task_generation(&mut coordinator, 200);

        assert!(!claim_task_completion(&mut coordinator, candidate));
        assert_eq!(coordinator.generation, 2);
    }

    #[test]
    fn tracks_completion_duration_from_hook_lifecycle() {
        let mut coordinator = TaskCompletionCoordinator::default();
        begin_task_generation(&mut coordinator, 1_000);

        assert_eq!(task_duration_ms(&coordinator, 2_500), Some(1_500));
        assert!(!should_begin_task_generation(
            &coordinator,
            "running",
            Some("waiting"),
            Some(PermissionLifecycleEvent::PermissionReplied),
        ));
    }

    #[test]
    fn starts_a_hook_lifecycle_for_a_new_running_agent() {
        let coordinator = TaskCompletionCoordinator::default();

        assert!(should_begin_task_generation(
            &coordinator,
            "running",
            Some("waiting"),
            None,
        ));
    }

    #[test]
    fn child_stops_do_not_complete_the_root_task() {
        let mut coordinator = TaskCompletionCoordinator::default();
        begin_task_generation(&mut coordinator, 100);
        coordinator.active_subagents.insert("child".to_string());

        assert!(is_child_stop(&coordinator, Some("child"), 101));
        coordinator.active_subagents.remove("child");
        coordinator
            .recently_stopped_subagents
            .insert("child".to_string(), 102);
        assert!(is_child_stop(&coordinator, Some("child"), 103));
        assert!(!is_child_stop(&coordinator, Some("root"), 103));
    }

    #[test]
    fn anonymous_subagent_lifecycle_suppresses_completion() {
        let guards: StatusGuards =
            std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
        update_subagent_lifecycle(
            &guards,
            "session",
            ClaudeTaskLifecycleEvent::SubagentStart,
            None,
            100,
        );
        let guard = guards.lock().unwrap();
        assert!(guard["session"].task_coordinator.unverifiable_subagent_seen);
    }
    #[test]
    fn normalizes_native_and_legacy_states() {
        assert_eq!(normalize_state(Some("working"), None), Some("running"));
        assert_eq!(normalize_state(Some("idle"), None), Some("completed"));
        assert_eq!(
            normalize_state(None, Some("permission_request")),
            Some("waiting")
        );
        assert_eq!(
            normalize_state(None, Some("assistant_complete")),
            Some("completed")
        );
        assert_eq!(
            normalize_state(None, Some("session_start")),
            Some("waiting")
        );
        assert_eq!(
            normalize_state(None, Some("post_tool_use_failure")),
            Some("running")
        );
        assert_eq!(
            normalize_state(None, Some("permission_denied")),
            Some("running")
        );
    }

    #[test]
    fn preserves_attention_event_semantics() {
        assert_eq!(
            normalize_event_type("waiting", Some("PermissionRequest")),
            Some("permission_request")
        );
        assert_eq!(
            normalize_event_type("waiting", Some("question.asked")),
            Some("waiting_input")
        );
        assert_eq!(
            normalize_event_type("error", Some("session.error")),
            Some("process_error")
        );
        assert_eq!(
            normalize_event_type("waiting", Some("session_start")),
            Some("session_start")
        );
        assert_eq!(
            normalize_event_type("running", Some("PermissionDenied")),
            Some("permission_denied")
        );
        assert_eq!(normalize_event_type("running", Some("PreToolUse")), None);
    }

    #[test]
    fn qoder_session_start_is_idle_without_an_attention_event() {
        let event_type = normalize_event_type("waiting", Some("SessionStart"));

        assert_eq!(event_type, Some("session_start"));
        assert!(!should_emit_attention_event("waiting", event_type));
        assert!(should_emit_attention_event(
            "waiting",
            Some("permission_request")
        ));
        assert!(should_emit_attention_event("error", Some("process_error")));
    }

    #[test]
    fn rejects_unknown_agent_ids() {
        assert_eq!(normalize_agent(Some("claude")).as_deref(), Some("claude"));
        assert_eq!(normalize_agent(Some("qoder")).as_deref(), Some("qoder"));
        assert_eq!(
            normalize_agent(Some("antigravity")).as_deref(),
            Some("antigravity")
        );
        assert_eq!(normalize_agent(Some("gemini")), None);
        assert_eq!(normalize_agent(Some("unknown")), None);
        assert_eq!(normalize_agent(None), None);
        assert_eq!(agent_label("qoder"), "Qoder CLI");
    }

    #[test]
    fn accepts_only_safe_provider_session_ids() {
        assert_eq!(
            normalize_provider_session_id(Some("9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890")).as_deref(),
            Some("9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890")
        );
        assert_eq!(normalize_provider_session_id(Some("bad/id")), None);
        assert_eq!(normalize_provider_session_id(Some("short")), None);
    }

    #[test]
    fn guard_rejects_duplicates_and_out_of_order_events() {
        let mut guard = SessionStatusGuard::default();
        assert_eq!(
            accept_guard_event(&mut guard, "e1", "running", None, 100),
            Some((1, true))
        );
        assert_eq!(
            accept_guard_event(&mut guard, "e1", "running", None, 100),
            None
        );
        assert_eq!(
            accept_guard_event(&mut guard, "older", "waiting", Some("waiting_input"), 99,),
            None
        );
    }

    #[test]
    fn guard_allows_permission_upgrade_without_repeating_status() {
        let mut guard = SessionStatusGuard::default();
        assert_eq!(
            accept_guard_event(&mut guard, "wait", "waiting", Some("waiting_input"), 100,),
            Some((1, true))
        );
        assert_eq!(
            accept_guard_event(
                &mut guard,
                "permission",
                "waiting",
                Some("permission_request"),
                101,
            ),
            Some((2, false))
        );
        assert_eq!(
            accept_guard_event(
                &mut guard,
                "generic-waiting",
                "waiting",
                Some("waiting_input"),
                102,
            ),
            None
        );
    }

    fn tool_correlation(
        tool_use_id: Option<&str>,
        tool_fingerprint: Option<&str>,
        permission_fingerprint: Option<&str>,
        actor_fingerprint: &str,
        has_explicit_actor: bool,
        created_at: i64,
    ) -> ToolPermissionCorrelation {
        ToolPermissionCorrelation {
            tool_use_id: tool_use_id.map(str::to_string),
            tool_fingerprint: tool_fingerprint.map(str::to_string),
            permission_fingerprint: permission_fingerprint.map(str::to_string),
            actor_fingerprint: actor_fingerprint.to_string(),
            has_explicit_actor,
            created_at,
        }
    }

    #[test]
    fn claude_permission_resumes_only_for_the_matching_tool_use() {
        let mut guard = SessionStatusGuard::default();
        let pre_tool =
            tool_correlation(Some("toolu-approved"), Some("a"), None, "main", false, 100);
        assert!(prepare_permission_lifecycle_event(
            &mut guard,
            PermissionLifecycleEvent::PreToolUse,
            Some(pre_tool)
        ));
        assert_eq!(
            accept_guard_event(&mut guard, "pre", "running", None, 100),
            Some((1, true))
        );

        let permission = tool_correlation(None, Some("a"), None, "main", false, 110);
        assert!(prepare_permission_lifecycle_event(
            &mut guard,
            PermissionLifecycleEvent::PermissionRequest,
            Some(permission)
        ));
        assert_eq!(
            accept_guard_event(
                &mut guard,
                "permission",
                "waiting",
                Some("permission_request"),
                110,
            ),
            Some((2, true))
        );
        assert_eq!(
            guard
                .pending_permission
                .as_ref()
                .and_then(|pending| pending.tool_use_id.as_deref()),
            Some("toolu-approved")
        );
        assert!(guard.permission_pending);

        let unrelated = tool_correlation(Some("toolu-other"), Some("b"), None, "other", true, 120);
        assert!(!prepare_permission_lifecycle_event(
            &mut guard,
            PermissionLifecycleEvent::PostToolUse,
            Some(unrelated)
        ));
        assert_eq!(guard.last_state.as_deref(), Some("waiting"));

        let approved =
            tool_correlation(Some("toolu-approved"), Some("a"), None, "main", false, 130);
        assert!(prepare_permission_lifecycle_event(
            &mut guard,
            PermissionLifecycleEvent::PostToolUse,
            Some(approved)
        ));
        assert_eq!(
            accept_guard_event(&mut guard, "post", "running", None, 130),
            Some((3, true))
        );
        assert!(guard.pending_permission.is_none());
        assert!(!guard.permission_pending);
    }

    #[test]
    fn claude_permission_can_resume_for_the_same_explicit_actor() {
        let mut guard = SessionStatusGuard {
            last_state: Some("waiting".to_string()),
            last_event_type: Some("permission_request".to_string()),
            pending_permission: Some(tool_correlation(
                None,
                Some("same"),
                None,
                "actor",
                true,
                100,
            )),
            permission_pending: true,
            ..SessionStatusGuard::default()
        };
        let resumed = tool_correlation(Some("toolu-late"), Some("same"), None, "actor", true, 110);

        assert!(prepare_permission_lifecycle_event(
            &mut guard,
            PermissionLifecycleEvent::PreToolUse,
            Some(resumed)
        ));
        assert!(guard.pending_permission.is_none());
        assert!(!guard.permission_pending);
    }

    #[test]
    fn claude_permission_stays_visible_without_tool_or_actor_proof() {
        let mut guard = SessionStatusGuard {
            last_state: Some("waiting".to_string()),
            last_event_type: Some("permission_request".to_string()),
            pending_permission: Some(tool_correlation(
                None,
                Some("same"),
                None,
                "main",
                false,
                100,
            )),
            permission_pending: true,
            ..SessionStatusGuard::default()
        };
        let ambiguous = tool_correlation(
            Some("toolu-unknown"),
            Some("same"),
            None,
            "main",
            false,
            110,
        );

        assert!(!prepare_permission_lifecycle_event(
            &mut guard,
            PermissionLifecycleEvent::PostToolUse,
            Some(ambiguous)
        ));
        assert!(guard.pending_permission.is_some());
        assert!(guard.permission_pending);
    }

    #[test]
    fn opencode_permission_reply_requires_the_same_permission() {
        let mut guard = SessionStatusGuard {
            last_state: Some("waiting".to_string()),
            last_event_type: Some("permission_request".to_string()),
            pending_permission: Some(tool_correlation(
                Some("call-1"),
                None,
                Some("permission-a"),
                "session-a",
                true,
                100,
            )),
            permission_pending: true,
            ..SessionStatusGuard::default()
        };
        let unrelated = tool_correlation(None, None, Some("permission-b"), "session-b", true, 110);
        assert!(!prepare_permission_lifecycle_event(
            &mut guard,
            PermissionLifecycleEvent::PermissionReplied,
            Some(unrelated),
        ));
        assert!(guard.permission_pending);

        let matching = tool_correlation(None, None, Some("permission-a"), "session-a", true, 120);
        assert!(prepare_permission_lifecycle_event(
            &mut guard,
            PermissionLifecycleEvent::PermissionReplied,
            Some(matching),
        ));
        assert!(!guard.permission_pending);
    }

    #[test]
    fn qoder_permission_denied_clears_the_matching_pending_permission() {
        let mut guard = SessionStatusGuard {
            last_state: Some("waiting".to_string()),
            last_event_type: Some("permission_request".to_string()),
            pending_permission: Some(tool_correlation(
                Some("call-1"),
                Some("tool-a"),
                None,
                "session-a",
                true,
                100,
            )),
            permission_pending: true,
            ..SessionStatusGuard::default()
        };
        let denied = tool_correlation(Some("call-1"), Some("tool-a"), None, "session-a", true, 110);

        assert!(prepare_permission_lifecycle_event(
            &mut guard,
            PermissionLifecycleEvent::PermissionDenied,
            Some(denied),
        ));
        assert!(guard.pending_permission.is_none());
        assert!(!guard.permission_pending);
    }

    #[test]
    fn qoder_permission_denied_without_correlation_is_still_definitive() {
        let mut guard = SessionStatusGuard {
            last_state: Some("waiting".to_string()),
            last_event_type: Some("permission_request".to_string()),
            pending_permission: Some(tool_correlation(
                None,
                Some("tool-a"),
                None,
                "session-a",
                false,
                100,
            )),
            permission_pending: true,
            ..SessionStatusGuard::default()
        };

        assert!(prepare_permission_lifecycle_event(
            &mut guard,
            PermissionLifecycleEvent::PermissionDenied,
            None,
        ));
        assert!(guard.pending_permission.is_none());
        assert!(!guard.permission_pending);
    }

    #[test]
    fn generic_busy_event_cannot_clear_a_pending_permission() {
        let guard = SessionStatusGuard {
            last_state: Some("waiting".to_string()),
            last_event_type: Some("permission_request".to_string()),
            permission_pending: true,
            ..SessionStatusGuard::default()
        };
        assert!(should_suppress_uncorrelated_running(&guard, "running"));
        assert!(!should_suppress_uncorrelated_running(&guard, "completed"));
    }

    #[test]
    fn parses_only_safe_tool_permission_correlation_fields() {
        let digest = "a".repeat(64);
        let correlation = parse_tool_permission_correlation(
            Some(&json!({
                "toolUseId": "toolu_abc-123",
                "toolFingerprint": digest,
                "permissionFingerprint": "c".repeat(64),
                "actorFingerprint": "b".repeat(64),
                "hasExplicitActor": true,
                "command": "must not be read"
            })),
            123,
        )
        .unwrap();

        assert_eq!(correlation.tool_use_id.as_deref(), Some("toolu_abc-123"));
        assert_eq!(
            correlation.tool_fingerprint.as_deref().map(str::len),
            Some(64)
        );
        assert_eq!(
            correlation.permission_fingerprint.as_deref().map(str::len),
            Some(64)
        );
        assert_eq!(correlation.created_at, 123);
        assert!(correlation.has_explicit_actor);
        assert!(parse_tool_permission_correlation(
            Some(&json!({
                "toolFingerprint": "not-a-digest",
                "actorFingerprint": "not-a-digest"
            })),
            123,
        )
        .is_none());
    }

    #[test]
    fn normalizes_correlated_permission_lifecycle_events() {
        assert_eq!(
            normalize_permission_lifecycle_event("codex", Some("PreToolUse")),
            Some(PermissionLifecycleEvent::PreToolUse)
        );
        assert_eq!(
            normalize_permission_lifecycle_event("claude", Some("post_tool_use")),
            Some(PermissionLifecycleEvent::PostToolUse)
        );
        assert_eq!(
            normalize_permission_lifecycle_event("opencode", Some("permission_replied")),
            Some(PermissionLifecycleEvent::PermissionReplied)
        );
        assert_eq!(
            normalize_permission_lifecycle_event("qoder", Some("PostToolUseFailure")),
            Some(PermissionLifecycleEvent::PostToolUseFailure)
        );
        assert_eq!(
            normalize_permission_lifecycle_event("qoder", Some("PermissionDenied")),
            Some(PermissionLifecycleEvent::PermissionDenied)
        );
        assert_eq!(
            normalize_permission_lifecycle_event("antigravity", Some("PermissionRequest")),
            None
        );
    }

    #[test]
    fn metadata_does_not_persist_provider_payload() {
        let metadata = sanitized_metadata(Some(&json!({
            "stdin_raw": "secret prompt",
            "command": "dangerous command",
            "token": "credential"
        })));
        assert_eq!(metadata, json!({}));
    }
}
