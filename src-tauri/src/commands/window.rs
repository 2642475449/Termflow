use crate::database::{Database, PersistentSettingsRecord};
use crate::pty::PtyManager;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{
    Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

const LAUNCHER_LABEL: &str = "launcher";
const VOICE_OVERLAY_LABEL: &str = "voice-overlay";
const VOICE_OVERLAY_ROUTE: &str = "index.html?overlay=voice";
const VOICE_WORKER_LABEL: &str = "voice-worker";
const VOICE_WORKER_ROUTE: &str = "index.html?worker=voice";
const VOICE_OVERLAY_WIDTH: u32 = 520;
const VOICE_OVERLAY_HEIGHT: u32 = 88;
const VOICE_OVERLAY_BOTTOM_MARGIN: i32 = 104;

#[derive(Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WindowMode {
    Launcher,
    Project,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WindowProjectContext {
    pub window_label: String,
    pub mode: WindowMode,
    pub project_path: Option<String>,
    pub project_name: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FocusSessionRequest {
    pub session_id: String,
    pub project_path: String,
}

pub struct WindowRegistry {
    contexts_by_label: Mutex<HashMap<String, WindowProjectContext>>,
    project_to_label: Mutex<HashMap<String, String>>,
}

pub struct VoiceOverlayState {
    owner_label: Mutex<Option<String>>,
}

impl VoiceOverlayState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            owner_label: Mutex::new(None),
        })
    }

    fn set_owner(&self, owner_label: &str) {
        *self.owner_label.lock() = Some(owner_label.to_string());
    }

    fn clear_owner_if_matches(&self, owner_label: &str) -> bool {
        let mut guard = self.owner_label.lock();
        if guard.as_deref() == Some(owner_label) {
            *guard = None;
            return true;
        }
        false
    }

    fn owner_matches(&self, owner_label: &str) -> bool {
        self.owner_label.lock().as_deref() == Some(owner_label)
    }
}

impl WindowRegistry {
    pub fn new() -> Arc<Self> {
        let registry = Arc::new(Self {
            contexts_by_label: Mutex::new(HashMap::new()),
            project_to_label: Mutex::new(HashMap::new()),
        });
        registry.set_launcher("main");
        registry
    }

    pub fn get_context(&self, window_label: &str) -> WindowProjectContext {
        self.contexts_by_label
            .lock()
            .get(window_label)
            .cloned()
            .unwrap_or_else(|| launcher_context(window_label))
    }

    pub fn get_label_by_project(&self, project_path: &str) -> Option<String> {
        self.project_to_label.lock().get(project_path).cloned()
    }

    pub fn get_launcher_label(&self) -> Option<String> {
        self.contexts_by_label
            .lock()
            .values()
            .find(|context| context.mode == WindowMode::Launcher)
            .map(|context| context.window_label.clone())
    }

    pub fn is_launcher(&self, window_label: &str) -> bool {
        self.get_context(window_label).mode == WindowMode::Launcher
    }

    pub fn has_project_windows(&self) -> bool {
        !self.project_to_label.lock().is_empty()
    }

    pub fn set_launcher(&self, window_label: &str) -> WindowProjectContext {
        let context = launcher_context(window_label);
        let mut contexts = self.contexts_by_label.lock();
        if let Some(previous) = contexts.insert(window_label.to_string(), context.clone()) {
            if let Some(project_path) = previous.project_path {
                self.project_to_label.lock().remove(&project_path);
            }
        }
        context
    }

    pub fn bind_project(
        &self,
        window_label: &str,
        project_path: String,
        project_name: String,
    ) -> WindowProjectContext {
        let context = WindowProjectContext {
            window_label: window_label.to_string(),
            mode: WindowMode::Project,
            project_path: Some(project_path.clone()),
            project_name: Some(project_name),
        };
        let mut contexts = self.contexts_by_label.lock();
        if let Some(previous) = contexts.insert(window_label.to_string(), context.clone()) {
            if let Some(previous_path) = previous.project_path {
                self.project_to_label.lock().remove(&previous_path);
            }
        }
        self.project_to_label
            .lock()
            .insert(project_path, window_label.to_string());
        context
    }

    pub fn release_window(&self, window_label: &str) -> Option<WindowProjectContext> {
        let context = self.contexts_by_label.lock().remove(window_label);
        if let Some(project_path) = context.as_ref().and_then(|item| item.project_path.clone()) {
            self.project_to_label.lock().remove(&project_path);
        }
        context
    }
}

pub fn cleanup_window_project_sessions(
    window_label: &str,
    registry: &WindowRegistry,
    manager: &PtyManager,
) {
    if let Some(context) = registry.release_window(window_label) {
        if let Some(project_path) = context.project_path {
            manager.close_project_sessions(&project_path);
        }
    }
}

pub fn show_or_create_launcher_window(
    app: &tauri::AppHandle,
    registry: &WindowRegistry,
    database: &Database,
) -> Result<(), String> {
    if let Some(existing_label) = registry.get_launcher_label() {
        if let Some(existing_window) = app.get_webview_window(&existing_label) {
            focus_window(&existing_window);
            return Ok(());
        }
        registry.release_window(&existing_label);
    }

    if let Some(existing_window) = app.get_webview_window(LAUNCHER_LABEL) {
        registry.set_launcher(LAUNCHER_LABEL);
        focus_window(&existing_window);
        return Ok(());
    }

    // Closing the last visible project leaves the hidden voice windows alive, so
    // opening Termflow again reaches this single-instance callback instead of a
    // fresh process startup. Restore the last project in that case. When another
    // project window is still open, keep the launcher behavior so users can open
    // an additional project.
    let context = if registry.has_project_windows() {
        registry.set_launcher(LAUNCHER_LABEL)
    } else {
        restored_window_context(registry, LAUNCHER_LABEL, database)
    };
    let launcher_window =
        match WebviewWindowBuilder::new(app, LAUNCHER_LABEL, WebviewUrl::App("index.html".into()))
            .title(window_title(&context))
            .inner_size(1024.0, 700.0)
            .min_inner_size(800.0, 600.0)
            .center()
            .resizable(true)
            .decorations(false)
            .build()
        {
            Ok(window) => window,
            Err(error) => {
                registry.release_window(LAUNCHER_LABEL);
                return Err(format!("创建启动页窗口失败: {error}"));
            }
        };

    let _ = app.emit_to(launcher_window.label(), "window-context-updated", &context);
    focus_window(&launcher_window);
    Ok(())
}

/// Resolves the single directory argument accepted by the desktop executable.
///
/// Explorer passes an absolute path for the context-menu verbs, while a direct
/// command-line invocation may use a path relative to its current directory.
/// Keeping this parsing and validation in Rust ensures all external activation
/// paths use the same canonical project identity as the in-app project picker.
pub fn resolve_project_path_from_launch_arguments(
    args: &[String],
    cwd: &str,
) -> Result<Option<String>, String> {
    if args.len() > 1 {
        return Err("Termflow 只支持一个项目目录参数".to_string());
    }

    let Some(path_argument) = args.first() else {
        return Ok(None);
    };

    let supplied_path = PathBuf::from(path_argument);
    let project_path = if supplied_path.is_absolute() {
        supplied_path
    } else {
        Path::new(cwd).join(supplied_path)
    };

    ensure_existing_project_directory(&project_path.to_string_lossy()).map(Some)
}

/// Opens a project requested outside the application, such as an Explorer
/// context-menu invocation. Existing project windows are focused; an available
/// launcher window is reused; otherwise the request opens in a new project
/// window so an active project is never replaced without an in-app decision.
pub fn open_project_from_external_request(
    app: &tauri::AppHandle,
    registry: &WindowRegistry,
    path: &str,
) -> Result<WindowProjectContext, String> {
    let project_path = ensure_existing_project_directory(path)?;
    let project_name = project_name_from_path(&project_path);

    if let Some(existing_label) = registry.get_label_by_project(&project_path) {
        if let Some(existing_window) = app.get_webview_window(&existing_label) {
            focus_window(&existing_window);
            return Ok(registry.get_context(&existing_label));
        }
        registry.release_window(&existing_label);
    }

    if let Some(launcher_label) = registry.get_launcher_label() {
        if let Some(launcher_window) = app.get_webview_window(&launcher_label) {
            let context = registry.bind_project(&launcher_label, project_path, project_name);
            let _ = launcher_window.set_title(&window_title(&context));
            let _ = app.emit_to(launcher_window.label(), "window-context-updated", &context);
            focus_window(&launcher_window);
            return Ok(context);
        }
        registry.release_window(&launcher_label);
    }

    let label = if registry.has_project_windows() || app.get_webview_window("main").is_some() {
        project_window_label(&project_path)
    } else {
        "main".to_string()
    };
    let context = registry.bind_project(&label, project_path, project_name);
    let project_window =
        match WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
            .title(window_title(&context))
            .inner_size(1024.0, 700.0)
            .min_inner_size(800.0, 600.0)
            .center()
            .resizable(true)
            .decorations(false)
            .build()
        {
            Ok(window) => window,
            Err(error) => {
                registry.release_window(&label);
                return Err(format!("创建项目窗口失败: {error}"));
            }
        };
    let _ = app.emit_to(project_window.label(), "window-context-updated", &context);
    focus_window(&project_window);
    Ok(context)
}

fn focus_window(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn should_reuse_launcher_window(window_label: &str, launched_from_launcher: bool) -> bool {
    launched_from_launcher && window_label == "main"
}

pub fn cleanup_voice_overlay_owner(
    app: &tauri::AppHandle,
    window_label: &str,
    overlay_state: &VoiceOverlayState,
) {
    if !overlay_state.clear_owner_if_matches(window_label) {
        return;
    }

    if let Some(overlay_window) = app.get_webview_window(VOICE_OVERLAY_LABEL) {
        let _ = overlay_window.hide();
    }
}

pub fn create_voice_overlay_window(app: &tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window(VOICE_OVERLAY_LABEL).is_some() {
        return Ok(());
    }

    let overlay_window = WebviewWindowBuilder::new(
        app,
        VOICE_OVERLAY_LABEL,
        WebviewUrl::App(VOICE_OVERLAY_ROUTE.into()),
    )
    .title("Termflow Voice Overlay")
    .inner_size(VOICE_OVERLAY_WIDTH as f64, VOICE_OVERLAY_HEIGHT as f64)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .focused(false)
    .focusable(false)
    .shadow(false)
    .build()
    .map_err(|e| format!("创建语音悬浮窗失败: {e}"))?;

    let _ = overlay_window.set_ignore_cursor_events(true);
    Ok(())
}

pub fn create_voice_worker_window(app: &tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window(VOICE_WORKER_LABEL).is_some() {
        return Ok(());
    }

    WebviewWindowBuilder::new(
        app,
        VOICE_WORKER_LABEL,
        WebviewUrl::App(VOICE_WORKER_ROUTE.into()),
    )
    .title("Termflow Voice Worker")
    .inner_size(320.0, 240.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .skip_taskbar(true)
    .visible(false)
    .focused(false)
    .focusable(false)
    .shadow(false)
    .build()
    .map_err(|e| format!("创建语音后台窗口失败: {e}"))?;

    Ok(())
}

pub fn restore_main_window_context_on_startup(
    app: &tauri::AppHandle,
    registry: &WindowRegistry,
    database: &Database,
    launch_project_path: Option<&str>,
) -> Result<(), String> {
    // An explicit launch target must take precedence over the user's restored
    // project. This is what makes `Termflow.exe <directory>` and Explorer's
    // context-menu verbs reliably open the requested project.
    let context = startup_main_window_context(registry, database, launch_project_path);

    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.set_title(&window_title(&context));
    }

    Ok(())
}

fn startup_main_window_context(
    registry: &WindowRegistry,
    database: &Database,
    launch_project_path: Option<&str>,
) -> WindowProjectContext {
    if let Some(path) = launch_project_path {
        match ensure_existing_project_directory(path) {
            Ok(project_path) => {
                let project_name = project_name_from_path(&project_path);
                return registry.bind_project("main", project_path, project_name);
            }
            Err(error) => {
                // The directory can disappear between process startup and this
                // setup hook. Fall back to the standard startup behavior rather
                // than preventing the application from opening at all.
                eprintln!("Ignoring unavailable launch project: {error}");
            }
        }
    }

    // Resolve the restored project before the webview loads so startup never
    // remains on an empty launcher when restoration is enabled.
    restored_window_context(registry, "main", database)
}

fn restored_window_context(
    registry: &WindowRegistry,
    window_label: &str,
    database: &Database,
) -> WindowProjectContext {
    let project_path = database
        .load_persistent_settings()
        .ok()
        .and_then(|settings| restorable_project_path(&settings));

    match project_path {
        Some(project_path) => {
            let project_name = project_name_from_path(&project_path);
            registry.bind_project(window_label, project_path, project_name)
        }
        None => registry.set_launcher(window_label),
    }
}

fn restorable_project_path(settings: &PersistentSettingsRecord) -> Option<String> {
    if !settings.startup_restore_last_project {
        return None;
    }

    settings
        .last_project_path
        .as_deref()
        .and_then(|path| ensure_existing_project_directory(path).ok())
}

#[tauri::command]
pub async fn open_project_window(
    path: String,
    disposition: String,
    app: tauri::AppHandle,
    window: WebviewWindow,
    registry: State<'_, Arc<WindowRegistry>>,
    manager: State<'_, Arc<PtyManager>>,
) -> Result<WindowProjectContext, String> {
    let project_path = ensure_existing_project_directory(&path)?;
    let project_name = project_name_from_path(&project_path);
    let launched_from_launcher = registry.is_launcher(window.label());
    let reuse_current_window = match disposition.as_str() {
        "current_window" => true,
        "new_window" => false,
        "auto" => should_reuse_launcher_window(window.label(), launched_from_launcher),
        _ => {
            return Err(format!(
                "Unsupported project open disposition: {disposition}"
            ))
        }
    };
    let close_secondary_launcher = launched_from_launcher && !reuse_current_window;

    if let Some(existing_label) = registry.get_label_by_project(&project_path) {
        if let Some(existing_window) = app.get_webview_window(&existing_label) {
            let _ = existing_window.show();
            let _ = existing_window.set_focus();
            if launched_from_launcher && existing_label != window.label() {
                let _ = window.close();
            }
            return Ok(registry.get_context(&existing_label));
        }
        registry.release_window(&existing_label);
    }

    if reuse_current_window {
        let previous_context = registry.get_context(window.label());
        if let Some(previous_project_path) = previous_context.project_path.as_deref() {
            if previous_project_path != project_path {
                manager.close_project_sessions(previous_project_path);
            }
        }
        let context = registry.bind_project(window.label(), project_path.clone(), project_name);
        let _ = window.set_title(&window_title(&context));
        let _ = app.emit_to(window.label(), "window-context-updated", &context);
        return Ok(context);
    }

    let label = project_window_label(&project_path);
    if let Some(existing_window) = app.get_webview_window(&label) {
        let _ = existing_window.show();
        let _ = existing_window.set_focus();
        if close_secondary_launcher {
            let _ = window.close();
        }
        return Ok(registry.get_context(&label));
    }

    let context = registry.bind_project(&label, project_path.clone(), project_name);
    let project_window =
        WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
            .title(window_title(&context))
            .inner_size(1024.0, 700.0)
            .min_inner_size(800.0, 600.0)
            .center()
            .resizable(true)
            .decorations(false)
            .build()
            .map_err(|e| format!("创建项目窗口失败: {}", e))?;
    let _ = app.emit_to(project_window.label(), "window-context-updated", &context);
    if close_secondary_launcher {
        let _ = window.close();
    }
    Ok(context)
}

#[tauri::command]
pub fn focus_existing_project_window(
    path: String,
    app: tauri::AppHandle,
    registry: State<'_, Arc<WindowRegistry>>,
) -> Result<bool, String> {
    let project_path = ensure_existing_project_directory(&path)?;
    let Some(window_label) = registry.get_label_by_project(&project_path) else {
        return Ok(false);
    };

    if let Some(existing_window) = app.get_webview_window(&window_label) {
        focus_window(&existing_window);
        return Ok(true);
    }

    registry.release_window(&window_label);
    Ok(false)
}

#[tauri::command]
pub fn get_existing_project_paths(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter_map(|path| ensure_existing_project_directory(&path).ok())
        .collect()
}

#[tauri::command]
pub fn get_window_project_context(
    window: WebviewWindow,
    registry: State<'_, Arc<WindowRegistry>>,
) -> WindowProjectContext {
    registry.get_context(window.label())
}

#[tauri::command]
pub fn release_window_project_context(
    window: WebviewWindow,
    registry: State<'_, Arc<WindowRegistry>>,
) {
    registry.release_window(window.label());
}

#[tauri::command]
pub fn close_project_sessions(
    project_path: String,
    manager: State<'_, Arc<PtyManager>>,
) -> Result<(), String> {
    let normalized = normalize_path(&project_path)?;
    manager.close_project_sessions(&normalized);
    Ok(())
}

#[tauri::command]
pub fn focus_project_window(
    project_path: String,
    session_id: String,
    app: tauri::AppHandle,
    registry: State<'_, Arc<WindowRegistry>>,
) -> Result<bool, String> {
    focus_project_window_internal(&app, &registry, &project_path, &session_id)
}

pub fn focus_project_window_internal(
    app: &tauri::AppHandle,
    registry: &WindowRegistry,
    project_path: &str,
    session_id: &str,
) -> Result<bool, String> {
    let normalized_path = normalize_path(&project_path)?;
    let Some(window_label) = registry.get_label_by_project(&normalized_path) else {
        return Ok(false);
    };
    let Some(project_window) = app.get_webview_window(&window_label) else {
        registry.release_window(&window_label);
        return Ok(false);
    };

    let _ = project_window.show();
    let _ = project_window.unminimize();
    let _ = project_window.set_focus();
    let _ = app.emit_to(
        project_window.label(),
        "focus-session-request",
        FocusSessionRequest {
            session_id: session_id.to_string(),
            project_path: normalized_path,
        },
    );
    Ok(true)
}

#[tauri::command]
pub fn ensure_voice_overlay_window(
    app: tauri::AppHandle,
    window: WebviewWindow,
    overlay_state: State<'_, Arc<VoiceOverlayState>>,
) -> Result<(), String> {
    let overlay_window = app
        .get_webview_window(VOICE_OVERLAY_LABEL)
        .ok_or_else(|| "语音悬浮窗未初始化".to_string())?;

    let (x, y) = voice_overlay_position(&app, &window)?;
    overlay_window
        .set_size(Size::Physical(PhysicalSize::new(
            VOICE_OVERLAY_WIDTH,
            VOICE_OVERLAY_HEIGHT,
        )))
        .map_err(|error| format!("Failed to size voice overlay: {error}"))?;
    overlay_window
        .set_position(Position::Physical(PhysicalPosition::new(x, y)))
        .map_err(|error| format!("Failed to position voice overlay: {error}"))?;
    overlay_window
        .set_always_on_top(true)
        .map_err(|error| format!("Failed to keep voice overlay on top: {error}"))?;
    overlay_window
        .set_ignore_cursor_events(true)
        .map_err(|error| format!("Failed to make voice overlay click-through: {error}"))?;
    overlay_window
        .show()
        .map_err(|error| format!("Failed to show voice overlay: {error}"))?;
    overlay_state.set_owner(window.label());
    Ok(())
}

#[tauri::command]
pub fn hide_voice_overlay_window(
    app: tauri::AppHandle,
    window: WebviewWindow,
    overlay_state: State<'_, Arc<VoiceOverlayState>>,
) {
    if !overlay_state.owner_matches(window.label()) {
        return;
    }

    overlay_state.clear_owner_if_matches(window.label());
    if let Some(overlay_window) = app.get_webview_window(VOICE_OVERLAY_LABEL) {
        let _ = overlay_window.hide();
    }
}

fn launcher_context(window_label: &str) -> WindowProjectContext {
    WindowProjectContext {
        window_label: window_label.to_string(),
        mode: WindowMode::Launcher,
        project_path: None,
        project_name: None,
    }
}

fn project_window_label(project_path: &str) -> String {
    let mut hasher = DefaultHasher::new();
    project_path.hash(&mut hasher);
    format!("project:{:x}", hasher.finish())
}

fn voice_overlay_position(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
) -> Result<(i32, i32), String> {
    let monitor = if window.label() == VOICE_WORKER_LABEL {
        app.primary_monitor()
            .map_err(|e| format!("获取主显示器信息失败: {e}"))?
            .or_else(|| window.current_monitor().ok().flatten())
    } else {
        window
            .current_monitor()
            .map_err(|e| format!("获取显示器信息失败: {e}"))?
    };

    let Some(monitor) = monitor else {
        return Err("未找到当前显示器".into());
    };

    // Position relative to the Windows work area rather than the full monitor.
    // The full monitor includes the taskbar, which can place the capsule under
    // or beyond system chrome on high-DPI and non-default taskbar layouts.
    let work_area = monitor.work_area();
    Ok(voice_overlay_position_in_work_area(
        work_area.position.x,
        work_area.position.y,
        work_area.size.width,
        work_area.size.height,
    ))
}

fn voice_overlay_position_in_work_area(
    work_x: i32,
    work_y: i32,
    work_width: u32,
    work_height: u32,
) -> (i32, i32) {
    let x = work_x + ((work_width as i32 - VOICE_OVERLAY_WIDTH as i32) / 2);
    let y = work_y + work_height as i32 - VOICE_OVERLAY_HEIGHT as i32 - VOICE_OVERLAY_BOTTOM_MARGIN;
    (x, y.max(work_y))
}

pub(crate) fn project_name_from_path(project_path: &str) -> String {
    project_path
        .split(['\\', '/'])
        .filter(|segment| !segment.is_empty())
        .next_back()
        .unwrap_or(project_path)
        .to_string()
}

pub(crate) fn normalize_path(path: &str) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("项目路径不能为空".to_string());
    }

    let input = path.trim();
    match fs::canonicalize(input) {
        Ok(canonical) => Ok(normalize_windows_verbatim_path(
            canonical.to_string_lossy().to_string(),
        )),
        Err(_) => Ok(input.to_string()),
    }
}

fn ensure_existing_project_directory(path: &str) -> Result<String, String> {
    let normalized = normalize_path(path)?;
    let metadata =
        fs::metadata(&normalized).map_err(|_| format!("项目目录不存在: {}", normalized))?;
    if !metadata.is_dir() {
        return Err(format!("项目路径不是目录: {}", normalized));
    }
    Ok(normalized)
}

#[cfg(target_os = "windows")]
pub(crate) fn normalize_windows_verbatim_path(path: String) -> String {
    if let Some(stripped) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", stripped)
    } else if let Some(stripped) = path.strip_prefix(r"\\?\") {
        stripped.to_string()
    } else {
        path
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn normalize_windows_verbatim_path(path: String) -> String {
    path
}

fn window_title(context: &WindowProjectContext) -> String {
    match context.project_name.as_deref() {
        Some(project_name) if context.mode == WindowMode::Project => project_name.to_string(),
        _ => "Termflow".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_project(name: &str) -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("termflow-window-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn project_name_from_path_uses_last_segment() {
        assert_eq!(project_name_from_path(r"D:\3.project\termflow"), "termflow");
        assert_eq!(project_name_from_path("/Users/test/MyPlan"), "MyPlan");
    }

    #[test]
    fn project_name_from_path_ignores_trailing_separator() {
        assert_eq!(
            project_name_from_path(r"D:\3.project\termflow\"),
            "termflow"
        );
        assert_eq!(project_name_from_path("/tmp/demo/"), "demo");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn normalize_windows_verbatim_path_strips_drive_prefix() {
        assert_eq!(
            normalize_windows_verbatim_path(r"\\?\D:\3.project\termflow".to_string()),
            r"D:\3.project\termflow"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn normalize_windows_verbatim_path_strips_unc_prefix() {
        assert_eq!(
            normalize_windows_verbatim_path(r"\\?\UNC\server\share\repo".to_string()),
            r"\\server\share\repo"
        );
    }

    #[test]
    fn window_title_uses_project_name_in_project_mode() {
        let context = WindowProjectContext {
            window_label: "project:1".to_string(),
            mode: WindowMode::Project,
            project_path: Some(r"D:\3.project\termflow".to_string()),
            project_name: Some("termflow".to_string()),
        };

        assert_eq!(window_title(&context), "termflow");
    }

    #[test]
    fn window_title_falls_back_for_launcher() {
        let context = WindowProjectContext {
            window_label: "main".to_string(),
            mode: WindowMode::Launcher,
            project_path: None,
            project_name: None,
        };

        assert_eq!(window_title(&context), "Termflow");
    }

    #[test]
    fn launcher_registry_tracks_at_most_one_launcher_context() {
        let registry = WindowRegistry::new();
        assert_eq!(registry.get_launcher_label().as_deref(), Some("main"));

        registry.bind_project(
            "main",
            "/workspace/renmin".to_string(),
            "renmin".to_string(),
        );
        assert!(registry.get_launcher_label().is_none());

        registry.set_launcher(LAUNCHER_LABEL);
        assert_eq!(
            registry.get_launcher_label().as_deref(),
            Some(LAUNCHER_LABEL)
        );
    }

    #[test]
    fn auto_disposition_only_reuses_the_main_launcher() {
        assert!(should_reuse_launcher_window("main", true));
        assert!(!should_reuse_launcher_window(LAUNCHER_LABEL, true));
        assert!(!should_reuse_launcher_window("main", false));
    }

    #[test]
    fn voice_overlay_is_centered_above_the_work_area_bottom() {
        assert_eq!(
            voice_overlay_position_in_work_area(0, 0, 1920, 1040),
            (700, 848)
        );
    }

    #[test]
    fn voice_overlay_position_supports_offset_monitors() {
        assert_eq!(
            voice_overlay_position_in_work_area(-1920, 40, 1920, 1040),
            (-1220, 888)
        );
    }

    #[test]
    fn single_instance_activation_restores_the_last_closed_project() {
        let project = temporary_project("restore-last-project");
        let database = Database::open_in_memory();
        let mut settings = PersistentSettingsRecord::default();
        settings.last_project_path = Some(project.to_string_lossy().into_owned());
        database.save_persistent_settings(&settings).unwrap();

        let registry = WindowRegistry::new();
        registry.bind_project(
            "main",
            project.to_string_lossy().into_owned(),
            "renmin".to_string(),
        );
        assert!(registry.has_project_windows());

        registry.release_window("main");
        assert!(!registry.has_project_windows());

        let context = restored_window_context(&registry, LAUNCHER_LABEL, &database);
        assert!(context.mode == WindowMode::Project);
        assert_eq!(
            context.project_name.as_deref(),
            project.file_name().and_then(|v| v.to_str())
        );
        let expected_project_path = normalize_path(project.to_str().unwrap()).unwrap();
        assert_eq!(
            context.project_path.as_deref(),
            Some(expected_project_path.as_str())
        );

        std::fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn startup_restore_respects_the_user_setting() {
        let project = temporary_project("restore-disabled");
        let database = Database::open_in_memory();
        let mut settings = PersistentSettingsRecord::default();
        settings.startup_restore_last_project = false;
        settings.last_project_path = Some(project.to_string_lossy().into_owned());
        database.save_persistent_settings(&settings).unwrap();

        let registry = WindowRegistry::new();
        let context = restored_window_context(&registry, "main", &database);
        assert!(context.mode == WindowMode::Launcher);
        assert!(context.project_path.is_none());

        std::fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn launch_arguments_resolve_absolute_and_relative_project_directories() {
        let workspace = temporary_project("launch-arguments");
        let project = workspace.join("project");
        std::fs::create_dir_all(&project).unwrap();

        let absolute_args = vec![project.to_string_lossy().into_owned()];
        let absolute = resolve_project_path_from_launch_arguments(&absolute_args, "").unwrap();
        assert_eq!(
            absolute.as_deref(),
            Some(normalize_path(project.to_str().unwrap()).unwrap().as_str())
        );

        let relative_args = vec!["project".to_string()];
        let relative =
            resolve_project_path_from_launch_arguments(&relative_args, workspace.to_str().unwrap())
                .unwrap();
        assert_eq!(relative, absolute);

        // The single-instance plugin includes the executable as args[0], so
        // callers must pass the remaining positional arguments to the parser.
        let secondary_instance_args = vec![
            "Termflow.exe".to_string(),
            project.to_string_lossy().into_owned(),
        ];
        assert_eq!(
            resolve_project_path_from_launch_arguments(&secondary_instance_args[1..], "").unwrap(),
            absolute
        );

        std::fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn launch_arguments_reject_files_and_allow_an_empty_argument_list() {
        let workspace = temporary_project("launch-file");
        let file = workspace.join("not-a-project.txt");
        std::fs::write(&file, "not a directory").unwrap();

        assert_eq!(
            resolve_project_path_from_launch_arguments(&[], workspace.to_str().unwrap()).unwrap(),
            None
        );
        let file_args = vec![file.to_string_lossy().into_owned()];
        assert!(resolve_project_path_from_launch_arguments(&file_args, "").is_err());
        assert!(resolve_project_path_from_launch_arguments(
            &["first".to_string(), "second".to_string()],
            workspace.to_str().unwrap(),
        )
        .is_err());

        std::fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn explicit_startup_project_takes_precedence_over_restored_project() {
        let restored_project = temporary_project("startup-restored");
        let requested_project = temporary_project("startup-requested");
        let database = Database::open_in_memory();
        let mut settings = PersistentSettingsRecord::default();
        settings.last_project_path = Some(restored_project.to_string_lossy().into_owned());
        database.save_persistent_settings(&settings).unwrap();

        let registry = WindowRegistry::new();
        let context = startup_main_window_context(
            &registry,
            &database,
            Some(requested_project.to_str().unwrap()),
        );

        assert!(context.mode == WindowMode::Project);
        assert_eq!(
            context.project_path.as_deref(),
            Some(
                normalize_path(requested_project.to_str().unwrap())
                    .unwrap()
                    .as_str()
            )
        );

        std::fs::remove_dir_all(restored_project).unwrap();
        std::fs::remove_dir_all(requested_project).unwrap();
    }

    #[test]
    fn window_registry_routes_each_project_to_its_own_window() {
        let registry = WindowRegistry::new();
        registry.bind_project(
            "project:alpha",
            "/workspace/alpha".to_string(),
            "alpha".to_string(),
        );
        registry.bind_project(
            "project:beta",
            "/workspace/beta".to_string(),
            "beta".to_string(),
        );

        assert_eq!(
            registry.get_label_by_project("/workspace/alpha").as_deref(),
            Some("project:alpha")
        );
        assert_eq!(
            registry.get_label_by_project("/workspace/beta").as_deref(),
            Some("project:beta")
        );
    }

    #[test]
    fn window_registry_removes_stale_project_routes_on_rebind_and_release() {
        let registry = WindowRegistry::new();
        registry.bind_project(
            "project:one",
            "/workspace/old".to_string(),
            "old".to_string(),
        );
        registry.bind_project(
            "project:one",
            "/workspace/new".to_string(),
            "new".to_string(),
        );

        assert!(registry.get_label_by_project("/workspace/old").is_none());
        assert_eq!(
            registry.get_label_by_project("/workspace/new").as_deref(),
            Some("project:one")
        );

        registry.release_window("project:one");
        assert!(registry.get_label_by_project("/workspace/new").is_none());
    }
}
