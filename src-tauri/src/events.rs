use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionEventType {
    SessionStarted,
    SessionResumed,
    AssistantComplete,
    WaitingInput,
    PermissionRequest,
    ToolBlocked,
    ProcessExit,
    ProcessError,
    HookError,
    HeartbeatTimeout,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionEventSeverity {
    Info,
    Success,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub id: String,
    pub revision: Option<u64>,
    pub session_id: String,
    pub project_path: String,
    pub session_name: String,
    pub event_type: SessionEventType,
    pub title: String,
    pub body: String,
    pub severity: SessionEventSeverity,
    pub source: String,
    pub requires_attention: bool,
    pub actionable: bool,
    pub dedupe_key: Option<String>,
    pub created_at: i64,
    pub metadata: Value,
}

pub fn emit_session_event(app: &AppHandle, event: &SessionEvent) {
    let _ = app.emit("session-event", event);
}
