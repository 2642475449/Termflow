mod claude_rate_limits;
mod claude_usage;
mod codex_rate_limits;
mod commands;
mod database;
mod events;
mod hook_ingest;
mod opencode_control;
mod path_utils;
mod pty;
mod qoder_config;

use claude_rate_limits::ClaudeRateLimitStore;
use commands::content_search::ContentSearchState;
use commands::git::GitWatcher;
use commands::voice_shortcut::VoiceShortcutState;
use commands::window::{VoiceOverlayState, WindowMode, WindowRegistry};
use database::Database;
use hook_ingest::{create_ingest_config, start_ingest_server};
use pty::PtyManager;
use std::sync::Arc;
use tauri::{Manager, WindowEvent};

pub fn run() {
    // 修复 H-07: create_ingest_config 现在返回 Result,失败时直接终止启动,
    // 避免在 TOCTOU 窗口期分配到端口但实际未 listen,造成静默失效。
    let (ingest_config_value, ingest_listener) =
        create_ingest_config().expect("无法初始化 hook ingest 服务");
    let ingest_config = Arc::new(ingest_config_value);
    let claude_rate_limits = Arc::new(ClaudeRateLimitStore::default());
    let pty_manager = PtyManager::new(ingest_config.clone());
    let window_registry = WindowRegistry::new();
    let voice_overlay_state = VoiceOverlayState::new();
    let voice_shortcut_state = VoiceShortcutState::new();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let registry = app.state::<Arc<WindowRegistry>>();
            let database = app.state::<Arc<Database>>();
            if let Err(error) = commands::window::show_or_create_launcher_window(
                app,
                registry.as_ref(),
                database.as_ref(),
            ) {
                eprintln!("Failed to open launcher for second app activation: {error}");
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    let state = app.state::<Arc<VoiceShortcutState>>();
                    commands::voice_shortcut::handle_voice_shortcut_event(
                        app,
                        &state,
                        shortcut,
                        event.state(),
                    );
                })
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(pty_manager.clone())
        .manage(ingest_config.clone())
        .manage(claude_rate_limits.clone())
        .manage(window_registry.clone())
        .manage(voice_overlay_state.clone())
        .manage(voice_shortcut_state.clone())
        .manage(ContentSearchState::default())
        .setup(move |app| {
            let git_watcher = GitWatcher::new(app.handle().clone());
            app.manage(Arc::new(git_watcher));
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Destroyed) {
                let registry = window.state::<Arc<WindowRegistry>>();
                let manager = window.state::<Arc<PtyManager>>();
                let voice_overlay_state = window.state::<Arc<VoiceOverlayState>>();
                let voice_shortcut_state = window.state::<Arc<VoiceShortcutState>>();
                let main_was_launcher =
                    window.label() == "main" && registry.is_launcher(window.label());
                let closing_context = registry.get_context(window.label());
                if closing_context.mode == WindowMode::Project {
                    if let Some(project_path) = closing_context.project_path.as_deref() {
                        let database = window.state::<Arc<Database>>();
                        if let Err(error) = database.save_last_project_path(project_path) {
                            eprintln!("Failed to remember last closed project: {error}");
                        }
                    }
                }
                commands::window::cleanup_window_project_sessions(
                    window.label(),
                    &registry,
                    &manager,
                );
                commands::window::cleanup_voice_overlay_owner(
                    &window.app_handle(),
                    window.label(),
                    &voice_overlay_state,
                );

                if window.label() == "main" {
                    commands::voice_shortcut::cleanup_voice_global_shortcut(
                        &window.app_handle(),
                        &voice_shortcut_state,
                    );
                }

                // 只有主窗口仍处于 launcher 模式时，才视为应用退出并清理全部会话。
                if main_was_launcher {
                    manager.cleanup_all();
                }
            }
        })
        .setup(move |app| {
            let database = Database::init(&app.handle())?;
            app.manage(database);
            let registry = app.state::<Arc<WindowRegistry>>();
            let database = app.state::<Arc<Database>>();
            commands::window::restore_main_window_context_on_startup(
                &app.handle(),
                &registry,
                &database,
            )?;
            start_ingest_server(
                app.handle().clone(),
                ingest_config.clone(),
                ingest_listener,
                pty_manager.clone(),
                claude_rate_limits.clone(),
            );
            commands::window::create_voice_overlay_window(&app.handle())?;
            commands::window::create_voice_worker_window(&app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::agents::inspect_agent_clis,
            commands::session::check_claude_ready,
            commands::session::get_claude_cli_info,
            commands::session::spawn_pty,
            commands::session::pty_input,
            commands::session::mark_session_prompt_submitted,
            commands::session::submit_agent_turn_input,
            commands::session::complete_agent_turn,
            commands::session::generate_session_title,
            commands::session::pty_resize,
            commands::session::close_pty,
            commands::session::cleanup_stale_sessions,
            commands::session::cleanup_session_process,
            commands::session::resolve_recent_codex_session_id,
            commands::session::is_session_active,
            commands::session::open_in_explorer,
            commands::session::open_in_associated_application,
            commands::file_tree::list_project_directory,
            commands::file_tree::resolve_project_link,
            commands::file_tree::search_project_entries,
            commands::file_tree::rename_project_entry,
            commands::file_tree::delete_project_entry,
            commands::file_tree::create_project_file,
            commands::file_tree::create_project_directory,
            commands::file_tree::read_project_file,
            commands::file_tree::read_project_image,
            commands::file_tree::read_project_pdf,
            commands::file_tree::write_project_file,
            commands::file_tree::inspect_project_file,
            commands::content_search::search_project_text,
            commands::content_search::cancel_content_search,
            commands::file_tree::copy_external_entry,
            commands::file_tree::copy_project_entries,
            commands::skills::list_skills,
            commands::skills::get_skill_detail,
            commands::skills::set_skill_enabled,
            commands::skills::create_skill,
            commands::skills::ensure_skill_directory,
            commands::command_library::list_commands,
            commands::command_library::get_command_detail,
            commands::command_library::create_command,
            commands::command_library::update_command,
            commands::command_library::delete_command,
            commands::command_library::ensure_command_store,
            commands::command_library::run_command_test,
            commands::agent_hooks::ensure_agent_status_hook,
            commands::claude_config::check_claude_hook_status,
            commands::claude_config::configure_claude_hook,
            commands::claude_config::list_claude_hooks,
            commands::claude_config::get_claude_hook_detail,
            commands::claude_config::delete_claude_hook,
            commands::claude_config::repair_claude_hooks,
            commands::claude_config::list_agent_hooks,
            commands::claude_config::get_agent_hook_detail,
            commands::claude_config::repair_agent_hooks,
            commands::claude_config::get_hook_ingest_config,
            commands::claude_config::get_claude_effort_info,
            commands::claude_config::get_claude_usage_overview,
            commands::agent_usage::get_agent_usage_overview,
            commands::agent_usage::get_agent_usage_storage_status,
            commands::agent_usage::clear_agent_usage_history,
            commands::agent_usage::rebuild_agent_usage_history,
            codex_rate_limits::get_codex_rate_limits,
            claude_rate_limits::get_claude_rate_limits,
            commands::claude_config::get_claude_md_detail,
            commands::claude_config::save_claude_md,
            commands::claude_config::set_claude_effort_setting,
            commands::claude_config::get_claude_theme,
            commands::claude_config::set_claude_theme,
            commands::settings::initialize_persistent_settings,
            commands::settings::get_persistent_settings,
            commands::settings::save_persistent_settings,
            commands::window::open_project_window,
            commands::window::focus_existing_project_window,
            commands::window::get_existing_project_paths,
            commands::window::get_window_project_context,
            commands::window::release_window_project_context,
            commands::window::close_project_sessions,
            commands::window::focus_project_window,
            commands::window::ensure_voice_overlay_window,
            commands::window::hide_voice_overlay_window,
            commands::notification::send_session_notification,
            commands::feishu::get_feishu_notification_config,
            commands::feishu::save_feishu_notification_credentials,
            commands::feishu::clear_feishu_notification_credentials,
            commands::feishu::send_feishu_notification,
            commands::image::save_clipboard_image,
            commands::system_input::send_text_to_focused_window,
            commands::voice::transcribe_audio,
            commands::voice_shortcut::configure_voice_global_shortcut,
            commands::voice_shortcut::is_voice_global_shortcut_registered,
            commands::git::git_repo_info,
            commands::git::git_clone_repository,
            commands::git::git_cancel_clone_task,
            commands::git::git_status,
            commands::git::git_branch_info,
            commands::git::git_graph_history,
            commands::git::git_graph_commit_detail,
            commands::git::git_graph_file_diff,
            commands::git::git_diff,
            commands::git::git_diff_content,
            commands::git::git_diff_hunks,
            commands::git::git_stage_hunk,
            commands::git::git_unstage_hunk,
            commands::git::checkpoint_list_turns,
            commands::git::checkpoint_file_diff,
            commands::git::checkpoint_file_hunks,
            commands::git::checkpoint_set_file_decision,
            commands::git::checkpoint_reject_file,
            commands::git::checkpoint_set_hunk_decision,
            commands::git::checkpoint_mark_reviewed,
            commands::git::checkpoint_restore_turn,
            commands::git::checkpoint_discard_turn,
            commands::git::git_commit,
            commands::git::git_discard_changes,
            commands::git::git_stage_files,
            commands::git::git_unstage_files,
            commands::git::git_commit_amend,
            commands::git::git_generate_commit_message,
            commands::git::git_fetch,
            commands::git::git_push,
            commands::git::git_pull,
            commands::git::git_pull_rebase,
            commands::git::git_list_branches,
            commands::git::git_create_branch,
            commands::git::git_switch_branch,
            commands::git::git_delete_branch,
            commands::git::git_merge_branch,
            commands::git::git_conflict_detail,
            commands::git::git_resolve_conflict,
            commands::git::git_abort_merge,
            commands::mcp_servers::list_mcp_servers,
            commands::mcp_servers::add_mcp_server,
            commands::mcp_servers::update_mcp_server,
            commands::mcp_servers::delete_mcp_server,
            commands::mcp_servers::test_mcp_server,
            commands::git::git_watch_start,
            commands::git::git_watch_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
