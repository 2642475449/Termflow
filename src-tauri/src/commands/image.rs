use crate::database::{
    clipboard::{IMAGE_RETENTION_MS, PENDING_IMAGE_TTL_MS},
    Database,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, Manager, State};

const MAX_IMAGE_SIZE_BYTES: usize = 10 * 1024 * 1024;
const MAX_CLIPBOARD_CACHE_BYTES: u64 = 500 * 1024 * 1024;
const CLIPBOARD_PASTE_DIRECTORY: &str = "terminal-paste-images";
static CLIPBOARD_PASTE_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
const RETIRED_CLIPBOARD_IMAGE_CACHE_DIRECTORIES: [&str; 2] =
    ["clipboard-images", "clipboard-images-v2"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePreviewPayload {
    pub data_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedClipboardImage {
    path: String,
    reference_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardCacheStatus {
    cache_path: String,
    total_bytes: u64,
    protected_bytes: u64,
    reclaimable_bytes: u64,
    legacy_bytes: u64,
    image_count: u64,
    limit_bytes: u64,
    retention_days: u64,
    pending_hours: u64,
}

fn cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join(CLIPBOARD_PASTE_DIRECTORY);
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    if fs::symlink_metadata(&root)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("图片缓存目录不能是符号链接".into());
    }
    Ok(root)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn managed_image_name(name: &str) -> bool {
    let Some((hash, extension)) = name.split_once('.') else {
        return false;
    };
    hash.len() == 64
        && hash.bytes().all(|c| c.is_ascii_hexdigit())
        && matches!(extension, "png" | "jpg" | "webp" | "gif")
}

fn managed_partial_name(name: &str) -> bool {
    name.strip_prefix("paste-")
        .and_then(|name| name.strip_suffix(".part"))
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|c| c.is_ascii_hexdigit()))
}

/// 仅处理本功能生成的平级文件，禁止跟随链接或递归删除。
fn remove_cache_file(root: &Path, name: &str) -> Result<(), String> {
    if !managed_image_name(name) && !managed_partial_name(name) {
        return Err("无效的图片缓存文件名".into());
    }
    let path = root.join(name);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            fs::remove_file(path).map_err(|e| e.to_string())
        }
        Ok(_) => Err("图片缓存条目不是普通文件".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn collect_cache(root: &Path, database: &Database, now: i64, manual: bool) -> Result<u64, String> {
    database.clipboard_expire_pending(now)?;
    let cutoff = if manual {
        now
    } else {
        now - IMAGE_RETENTION_MS
    };
    let mut freed = 0;
    for object in database.clipboard_objects(Some(cutoff))? {
        remove_cache_file(root, &object.file_name)?;
        database.clipboard_remove_object(&object.file_name)?;
        freed += object.size_bytes;
    }
    Ok(freed)
}

fn reconcile_cache(root: &Path, database: &Database) -> Result<(), String> {
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if !metadata.file_type().is_file() {
            continue;
        }
        if managed_partial_name(&name) {
            remove_cache_file(root, &name)?;
        } else if managed_image_name(&name) {
            // 升级前的图片没有会话账本，无法证明无人引用，保守保护。
            database.clipboard_adopt_legacy(&name, metadata.len())?;
        }
    }
    for object in database.clipboard_objects(None)? {
        if !managed_image_name(&object.file_name) {
            return Err("无效的图片缓存账本路径".into());
        }
        match fs::symlink_metadata(root.join(&object.file_name)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                database.clipboard_remove_object(&object.file_name)?
            }
            Err(error) => return Err(error.to_string()),
            _ => {}
        }
    }
    collect_cache(root, database, now_ms(), false)?;
    Ok(())
}

pub fn initialize_terminal_image_cache(
    app: &AppHandle,
    database: Arc<Database>,
) -> Result<(), String> {
    let root = cache_root(app)?;
    {
        let _guard = CLIPBOARD_PASTE_LOCK.lock();
        // 单实例应用启动时还没有粘贴任务，残留 .part 均来自上次异常退出。
        reconcile_cache(&root, &database)?;
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(60 * 60));
        let _guard = CLIPBOARD_PASTE_LOCK.lock();
        if let Err(error) = collect_cache(&root, &database, now_ms(), false) {
            log::warn!("Screenshot cache cleanup failed: {error}");
        }
    });
    Ok(())
}

fn cache_status(root: &Path, database: &Database) -> Result<ClipboardCacheStatus, String> {
    let totals = database.clipboard_totals()?;
    Ok(ClipboardCacheStatus {
        cache_path: root.to_string_lossy().into_owned(),
        total_bytes: totals.total,
        protected_bytes: totals.protected,
        reclaimable_bytes: totals.reclaimable,
        legacy_bytes: totals.legacy,
        image_count: totals.count,
        limit_bytes: MAX_CLIPBOARD_CACHE_BYTES,
        retention_days: (IMAGE_RETENTION_MS / 86_400_000) as u64,
        pending_hours: (PENDING_IMAGE_TTL_MS / 3_600_000) as u64,
    })
}

#[tauri::command]
pub async fn get_clipboard_cache_status(
    app: AppHandle,
    database: State<'_, Arc<Database>>,
) -> Result<ClipboardCacheStatus, String> {
    let root = cache_root(&app)?;
    cache_status(&root, &database)
}

#[tauri::command]
pub async fn cleanup_clipboard_cache(
    app: AppHandle,
    database: State<'_, Arc<Database>>,
) -> Result<ClipboardCacheStatus, String> {
    let root = cache_root(&app)?;
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = CLIPBOARD_PASTE_LOCK.lock();
        collect_cache(&root, &database, now_ms(), true)?;
        cache_status(&root, &database)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn retain_clipboard_image(
    database: State<'_, Arc<Database>>,
    session_id: String,
    reference_id: String,
) -> Result<(), String> {
    let _guard = CLIPBOARD_PASTE_LOCK.lock();
    database.clipboard_retain(&session_id, &reference_id)
}

#[tauri::command]
pub async fn sync_clipboard_sessions(
    database: State<'_, Arc<Database>>,
    present: Vec<String>,
    removed: Vec<String>,
) -> Result<(), String> {
    let _guard = CLIPBOARD_PASTE_LOCK.lock();
    database.clipboard_sync_sessions(&present, &removed, now_ms())
}

/// 图片先完整落盘并记录短期引用，再返回路径；插入前升级为会话保护。
#[tauri::command]
pub async fn save_terminal_clipboard_image(
    app: AppHandle,
    database: State<'_, Arc<Database>>,
    session_id: String,
    data_base64: String,
    mime_type: String,
) -> Result<SavedClipboardImage, String> {
    if session_id.is_empty() || session_id.len() > 256 {
        return Err("无效的会话标识".into());
    }
    let root = cache_root(&app)?;
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = decode_clipboard_image(&data_base64, &mime_type)?;
        let _guard = CLIPBOARD_PASTE_LOCK.lock();
        if !database.clipboard_session_available(&session_id)? {
            return Err("terminal.clipboardSessionChanged".into());
        }
        collect_cache(&root, &database, now_ms(), false)?;
        let used = database.clipboard_totals()?.total;
        let path =
            persist_clipboard_image(&root, &bytes, &mime_type, MAX_CLIPBOARD_CACHE_BYTES, used)?;
        let reference_id = format!("{:032x}", rand::random::<u128>());
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("无效的图片文件名")?;
        database.clipboard_register(
            &session_id,
            &reference_id,
            file_name,
            bytes.len() as u64,
            now_ms(),
        )?;
        Ok(SavedClipboardImage {
            path: path.to_string_lossy().into_owned(),
            reference_id,
        })
    })
    .await
    .map_err(|error| format!("保存剪贴板图片失败: {error}"))?
}

fn clipboard_image_extension(mime_type: &str) -> Result<&'static str, String> {
    match mime_type {
        "image/png" => Ok("png"),
        "image/jpeg" => Ok("jpg"),
        "image/webp" => Ok("webp"),
        "image/gif" => Ok("gif"),
        _ => Err("terminal.clipboardImageUnsupported".into()),
    }
}

fn decode_clipboard_image(encoded: &str, mime_type: &str) -> Result<Vec<u8>, String> {
    clipboard_image_extension(mime_type)?;
    if encoded.len() > MAX_IMAGE_SIZE_BYTES.div_ceil(3) * 4 {
        return Err("terminal.clipboardImageTooLarge".into());
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "terminal.clipboardImageInvalid")?;
    if bytes.len() > MAX_IMAGE_SIZE_BYTES {
        return Err("terminal.clipboardImageTooLarge".into());
    }
    let valid = match mime_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        _ => false,
    };
    if !valid {
        return Err("terminal.clipboardImageInvalid".into());
    }
    Ok(bytes)
}

fn persist_clipboard_image(
    root: &Path,
    bytes: &[u8],
    mime_type: &str,
    limit: u64,
    used: u64,
) -> Result<PathBuf, String> {
    let extension = clipboard_image_extension(mime_type)?;
    fs::create_dir_all(root).map_err(|error| format!("创建图片缓存失败: {error}"))?;
    let hash = format!("{:x}", Sha256::digest(bytes));
    let target = root.join(format!("{hash}.{extension}"));
    if let Ok(metadata) = fs::symlink_metadata(&target) {
        if !metadata.file_type().is_file() {
            return Err("图片缓存路径不是普通文件".into());
        }
        if fs::read(&target).map_err(|error| format!("读取图片缓存失败: {error}"))? == bytes
        {
            return Ok(target);
        }
        // 已有同名文件损坏时报告错误，避免覆盖正在被其他进程读取的文件。
        return Err("terminal.clipboardImageInvalid".into());
    }
    if used.saturating_add(bytes.len() as u64) > limit {
        return Err("terminal.clipboardCacheFull".into());
    }
    let staging = root.join(format!("paste-{:032x}.part", rand::random::<u128>()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staging)
        .map_err(|error| format!("创建图片文件失败: {error}"))?;
    let result = (|| {
        file.write_all(bytes)
            .map_err(|error| format!("写入图片失败: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("保存图片失败: {error}"))?;
        drop(file);
        fs::rename(&staging, &target).map_err(|error| format!("发布图片文件失败: {error}"))?;
        Ok(target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(staging);
    }
    result
}

/// Removes image cache directories used by the retired terminal clipboard
/// attachment feature. These paths are application-owned children of the
/// cache directory and are never resolved from user-provided input.
pub fn cleanup_retired_clipboard_image_cache(app: &AppHandle) -> Result<(), String> {
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("获取缓存目录失败: {error}"))?;

    for directory in RETIRED_CLIPBOARD_IMAGE_CACHE_DIRECTORIES {
        let path = cache_root.join(directory);
        if path.exists() {
            fs::remove_dir_all(&path)
                .map_err(|error| format!("删除已弃用的剪贴板图片缓存失败: {error}"))?;
        }
    }

    Ok(())
}

/// Returns a browser-safe data URL for an image explicitly referenced in the
/// terminal.
#[tauri::command]
pub fn read_image_preview(path: String) -> Result<ImagePreviewPayload, String> {
    let image_path =
        PathBuf::from(path.trim_matches(|character| character == '"' || character == '\''));
    if !image_path.is_file() {
        return Err("图片文件不存在".into());
    }

    let mime_type =
        image_mime_type(&image_path).ok_or_else(|| "目标文件不是受支持的图片".to_string())?;
    let metadata =
        fs::metadata(&image_path).map_err(|error| format!("读取图片元数据失败: {error}"))?;
    validate_image_size(metadata.len() as usize)?;
    let bytes = fs::read(&image_path).map_err(|error| format!("读取图片失败: {error}"))?;

    Ok(ImagePreviewPayload {
        data_url: format!("data:{mime_type};base64,{}", encode_base64(&bytes)),
    })
}

fn validate_image_size(size: usize) -> Result<(), String> {
    if size == 0 {
        return Err("图片数据为空".into());
    }
    if size > MAX_IMAGE_SIZE_BYTES {
        return Err("图片超过 10MB，请压缩后再试".into());
    }
    Ok(())
}

fn image_mime_type(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        output.push(TABLE[(chunk[0] >> 2) as usize] as char);
        output.push(
            TABLE[(((chunk[0] & 0b0000_0011) << 4) | (chunk.get(1).copied().unwrap_or(0) >> 4))
                as usize] as char,
        );
        output.push(if chunk.len() > 1 {
            TABLE[(((chunk[1] & 0b0000_1111) << 2) | (chunk.get(2).copied().unwrap_or(0) >> 6))
                as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(chunk[2] & 0b0011_1111) as usize] as char
        } else {
            '='
        });
    }
    output
}

#[cfg(test)]
mod tests {
    use super::{
        collect_cache, decode_clipboard_image, encode_base64, image_mime_type, now_ms,
        persist_clipboard_image, reconcile_cache, remove_cache_file, IMAGE_RETENTION_MS,
    };
    use crate::database::Database;
    use std::path::Path;

    #[test]
    fn identifies_supported_image_extensions_case_insensitively() {
        assert_eq!(image_mime_type(Path::new("preview.PNG")), Some("image/png"));
        assert_eq!(image_mime_type(Path::new("preview.txt")), None);
    }

    #[test]
    fn encodes_base64_with_padding() {
        assert_eq!(encode_base64(b"a"), "YQ==");
        assert_eq!(encode_base64(b"abc"), "YWJj");
    }

    #[test]
    fn cleanup_respects_retention_and_preserves_referenced_images(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let root = tempfile::tempdir()?;
        let database = Database::open_in_memory();
        let kept = persist_clipboard_image(root.path(), b"GIF89a-kept", "image/gif", 100, 0)?;
        let unused = persist_clipboard_image(root.path(), b"GIF89a-unused", "image/gif", 100, 11)?;
        let kept_name = kept
            .file_name()
            .ok_or("missing filename")?
            .to_str()
            .ok_or("invalid filename")?;
        let unused_name = unused
            .file_name()
            .ok_or("missing filename")?
            .to_str()
            .ok_or("invalid filename")?;
        database.clipboard_register("kept", "ref1", kept_name, 11, 0)?;
        database.clipboard_register("deleted", "ref2", unused_name, 13, 0)?;
        database.clipboard_retain("kept", "ref1")?;
        database.clipboard_retain("deleted", "ref2")?;
        database.clipboard_sync_sessions(&[], &["deleted".into()], 10)?;
        assert_eq!(
            collect_cache(root.path(), &database, IMAGE_RETENTION_MS + 9, false)?,
            0
        );
        assert!(unused.exists());
        assert_eq!(
            collect_cache(root.path(), &database, IMAGE_RETENTION_MS + 10, false)?,
            13
        );
        assert!(!unused.exists());
        assert!(kept.exists());
        assert_eq!(database.clipboard_totals()?.total, 11);
        assert_eq!(
            collect_cache(root.path(), &database, IMAGE_RETENTION_MS * 2, true)?,
            0
        );
        Ok(())
    }

    #[test]
    fn manual_cleanup_only_removes_unreferenced_files_and_rejects_unsafe_paths(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let root = tempfile::tempdir()?;
        let database = Database::open_in_memory();
        let path = persist_clipboard_image(root.path(), b"GIF89a", "image/gif", 100, 0)?;
        let name = path
            .file_name()
            .ok_or("missing filename")?
            .to_str()
            .ok_or("invalid filename")?;
        database.clipboard_register("deleted", "ref", name, 6, 0)?;
        database.clipboard_retain("deleted", "ref")?;
        database.clipboard_sync_sessions(&[], &["deleted".into()], 1)?;
        assert_eq!(collect_cache(root.path(), &database, 2, true)?, 6);
        assert!(!path.exists());
        assert!(remove_cache_file(root.path(), "../outside.png").is_err());
        let directory_name = format!("{}.png", "a".repeat(64));
        std::fs::create_dir(root.path().join(&directory_name))?;
        assert!(remove_cache_file(root.path(), &directory_name).is_err());
        assert!(root.path().join(directory_name).is_dir());
        Ok(())
    }

    #[test]
    fn startup_recovers_partial_files_and_keeps_unknown_legacy_images(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let root = tempfile::tempdir()?;
        let database = Database::open_in_memory();
        let legacy = persist_clipboard_image(root.path(), b"GIF89a", "image/gif", 100, 0)?;
        let partial = root.path().join(format!("paste-{}.part", "a".repeat(32)));
        let unrelated = root.path().join("notes.part");
        std::fs::write(&partial, b"partial")?;
        std::fs::write(&unrelated, b"keep")?;
        reconcile_cache(root.path(), &database)?;
        assert!(!partial.exists());
        assert!(unrelated.exists());
        assert_eq!(database.clipboard_totals()?.legacy, 6);
        assert_eq!(collect_cache(root.path(), &database, now_ms(), true)?, 0);
        assert!(legacy.exists());
        Ok(())
    }

    #[test]
    fn rejects_malformed_or_mismatched_clipboard_images() {
        assert!(decode_clipboard_image("not base64", "image/png").is_err());
        assert!(decode_clipboard_image(&encode_base64(b"text"), "image/png").is_err());
        assert!(decode_clipboard_image(&encode_base64(b"GIF89a"), "image/jpeg").is_err());
        assert!(decode_clipboard_image(&encode_base64(b"<svg/>"), "image/svg+xml").is_err());
        assert!(decode_clipboard_image(&encode_base64(b"\x89PNG\r\n\x1a\n"), "image/png").is_ok());
    }

    #[test]
    fn reuses_complete_images_even_at_cache_limit() -> Result<(), Box<dyn std::error::Error>> {
        let root = tempfile::tempdir()?;
        let bytes = b"\x89PNG\r\n\x1a\n";
        let path = persist_clipboard_image(root.path(), bytes, "image/png", 8, 0)?;
        assert_eq!(std::fs::read(&path)?, bytes);
        assert_eq!(
            persist_clipboard_image(root.path(), bytes, "image/png", 8, 8)?,
            path
        );
        assert_eq!(std::fs::read_dir(root.path())?.count(), 1);
        assert_eq!(
            persist_clipboard_image(root.path(), b"GIF89a", "image/gif", 8, 8),
            Err("terminal.clipboardCacheFull".into())
        );
        assert!(path.exists());
        Ok(())
    }

    #[test]
    fn reports_corrupt_cache_files_without_returning_their_path(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let root = tempfile::tempdir()?;
        let bytes = b"GIF89a";
        let path = persist_clipboard_image(root.path(), bytes, "image/gif", 100, 0)?;
        std::fs::write(path, b"broken")?;
        assert_eq!(
            persist_clipboard_image(root.path(), bytes, "image/gif", 100, 6),
            Err("terminal.clipboardImageInvalid".into())
        );
        Ok(())
    }
}
