use crate::remote_ssh::{RemoteConnectionInfo, RemoteHost, RemoteSshManager};
use serde_json::Value;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn connect_remote_host(
    host: RemoteHost,
    manager: State<'_, Arc<RemoteSshManager>>,
) -> Result<RemoteConnectionInfo, String> {
    manager.connect(host)
}

#[tauri::command]
pub fn get_remote_connection(
    host_id: String,
    manager: State<'_, Arc<RemoteSshManager>>,
) -> Result<RemoteConnectionInfo, String> {
    manager.connection(&host_id)
}

#[tauri::command]
pub async fn remote_auth_input(
    host_id: String,
    data: String,
    manager: State<'_, Arc<RemoteSshManager>>,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    super::run_background_task("remote_auth_input", move || {
        manager.auth_input(&host_id, &data)
    })
    .await
}

#[tauri::command]
pub async fn disconnect_remote_host(
    host_id: String,
    manager: State<'_, Arc<RemoteSshManager>>,
) -> Result<RemoteConnectionInfo, String> {
    let manager = manager.inner().clone();
    super::run_background_task("disconnect_remote_host", move || {
        manager.disconnect(&host_id)
    })
    .await
}

#[tauri::command]
pub async fn remote_request(
    host_id: String,
    method: String,
    params: Value,
    manager: State<'_, Arc<RemoteSshManager>>,
) -> Result<Value, String> {
    let manager = manager.inner().clone();
    super::run_background_task("remote_request", move || {
        manager.request(&host_id, &method, params)
    })
    .await
}
