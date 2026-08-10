use parking_lot::Mutex;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub struct VoiceShortcutState {
    active_shortcut: Mutex<Option<Shortcut>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceShortcutStatusPayload {
    pub registered: bool,
    pub shortcut: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceShortcutTriggerPayload {
    pub action: &'static str,
}

impl VoiceShortcutState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            active_shortcut: Mutex::new(None),
        })
    }

    fn take_active_shortcut(&self) -> Option<Shortcut> {
        self.active_shortcut.lock().take()
    }

    fn set_active_shortcut(&self, shortcut: Shortcut) {
        *self.active_shortcut.lock() = Some(shortcut);
    }

    fn current_shortcut(&self) -> Option<Shortcut> {
        self.active_shortcut.lock().clone()
    }
}

#[tauri::command]
pub fn configure_voice_global_shortcut(
    app: AppHandle,
    state: State<'_, Arc<VoiceShortcutState>>,
    accelerator: Option<String>,
    enabled: bool,
) -> Result<bool, String> {
    unregister_existing_shortcut(&app, &state)?;

    if !enabled {
        emit_status(&app, false, None, None);
        return Ok(false);
    }

    let Some(accelerator) = accelerator.map(|value| value.trim().to_string()) else {
        emit_status(&app, false, None, None);
        return Ok(false);
    };

    if accelerator.is_empty() {
        emit_status(&app, false, None, None);
        return Ok(false);
    }

    let shortcut = accelerator
        .parse::<Shortcut>()
        .map_err(|err| format!("语音快捷键格式无效: {err}"))?;

    app.global_shortcut()
        .register(shortcut.clone())
        .map_err(|err| {
            let message = format!("语音快捷键 {accelerator} 注册失败: {err}");
            emit_status(
                &app,
                false,
                Some(accelerator.clone()),
                Some(message.clone()),
            );
            message
        })?;

    state.set_active_shortcut(shortcut);
    emit_status(&app, true, Some(accelerator), None);
    Ok(true)
}

#[tauri::command]
pub fn is_voice_global_shortcut_registered(state: State<'_, Arc<VoiceShortcutState>>) -> bool {
    state.current_shortcut().is_some()
}

pub fn handle_voice_shortcut_event(
    app: &AppHandle,
    state: &VoiceShortcutState,
    shortcut: &Shortcut,
    event: ShortcutState,
) {
    let Some(active_shortcut) = state.current_shortcut() else {
        return;
    };

    if &active_shortcut != shortcut {
        return;
    }

    let action = match event {
        ShortcutState::Pressed => "press",
        ShortcutState::Released => "release",
    };

    let _ = app.emit(
        "voice-global-shortcut-trigger",
        VoiceShortcutTriggerPayload { action },
    );
}

pub fn cleanup_voice_global_shortcut(app: &AppHandle, state: &VoiceShortcutState) {
    let _ = unregister_existing_shortcut(app, state);
    emit_status(app, false, None, None);
}

fn unregister_existing_shortcut(app: &AppHandle, state: &VoiceShortcutState) -> Result<(), String> {
    if let Some(existing) = state.take_active_shortcut() {
        app.global_shortcut()
            .unregister(existing)
            .map_err(|err| format!("注销旧的语音快捷键失败: {err}"))?;
    }
    Ok(())
}

fn emit_status(
    app: &AppHandle,
    registered: bool,
    shortcut: Option<String>,
    error_message: Option<String>,
) {
    let _ = app.emit(
        "voice-global-shortcut-state",
        VoiceShortcutStatusPayload {
            registered,
            shortcut,
            error_message,
        },
    );
}
