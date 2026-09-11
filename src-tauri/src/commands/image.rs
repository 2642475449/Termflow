use crate::database::{ClipboardAttachmentRecord, ClipboardStorageTotals, Database};
use parking_lot::Mutex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

const MAX_IMAGE_SIZE_BYTES: usize = 10 * 1024 * 1024;
const MAX_ENCODED_IMAGE_SIZE_BYTES: usize = MAX_IMAGE_SIZE_BYTES.div_ceil(3) * 4;
const CLIPBOARD_IMAGE_SOFT_TARGET_BYTES: u64 = 100 * 1024 * 1024;
const CLIPBOARD_IMAGE_HARD_LIMIT_BYTES: u64 = 500 * 1024 * 1024;
const CLIPBOARD_IMAGE_RETENTION_MS: i64 = 3 * 24 * 60 * 60 * 1000;
const IMAGE_CACHE_DIRECTORY: &str = "clipboard-images-v2";
const LEGACY_IMAGE_CACHE_DIRECTORY: &str = "clipboard-images";

/// Serializes content publication, reference changes and cache collection in
/// this application process. SQLite coordinates metadata, while this lock
/// also covers the file-system portion that cannot join its transaction.
#[derive(Default)]
pub struct ClipboardImageCacheState {
    operation_lock: Mutex<()>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePreviewPayload {
    pub data_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardImageStorageStatus {
    pub cache_root: String,
    pub protected_bytes: u64,
    pub reclaimable_bytes: u64,
    pub legacy_bytes: u64,
    pub soft_target_bytes: u64,
    pub hard_limit_bytes: u64,
}

#[tauri::command]
pub fn save_clipboard_image(
    app: AppHandle,
    database: State<'_, Arc<Database>>,
    cache_state: State<'_, Arc<ClipboardImageCacheState>>,
    session_id: String,
    data_base64: String,
    mime_type: String,
) -> Result<ClipboardAttachmentRecord, String> {
    let session_id = validate_session_id(&session_id)?;
    let _operation = cache_state.operation_lock.lock();
    let extension = extension_from_mime(&mime_type)?;
    let bytes = decode_base64(&data_base64)?;
    validate_image_size(bytes.len())?;
    validate_image_signature(&bytes, &mime_type)?;

    let content_hash = format!("{:x}", Sha256::digest(&bytes));
    let cache_root = ensure_image_cache_dir(&app)?;
    let existing = database.get_clipboard_content_object(&content_hash)?;
    if existing.is_none() {
        let _ = cleanup_clipboard_image_cache_inner(&app, database.inner().as_ref())?;
        let status = storage_status(&app, database.inner().as_ref())?;
        let used_bytes = status
            .protected_bytes
            .saturating_add(status.reclaimable_bytes)
            .saturating_add(status.legacy_bytes);
        if used_bytes.saturating_add(bytes.len() as u64) > CLIPBOARD_IMAGE_HARD_LIMIT_BYTES {
            return Err("剪贴板图片缓存已达到 500 MiB 上限；请先清理历史附件后再试".to_string());
        }
    }

    let relative_path = existing
        .as_ref()
        .map(|object| object.relative_path.clone())
        .unwrap_or_else(|| format!("objects/{content_hash}.{extension}"));
    let file_path = resolve_managed_cache_path(&cache_root, &relative_path)?;
    let file_created = publish_content_object(&file_path, &bytes, &content_hash)?;
    let attachment_id = format!("attachment-{}-{:032x}", now_ms(), rand::random::<u128>(),);

    let record = database.attach_clipboard_image(
        &attachment_id,
        session_id,
        &content_hash,
        &relative_path,
        &mime_type,
        bytes.len() as u64,
        now_ms(),
    );
    let record = match record {
        Ok(record) => record,
        Err(error) => {
            if file_created {
                let _ = remove_managed_cache_file(&cache_root, &relative_path);
            }
            return Err(error);
        }
    };
    hydrate_attachment_record(record, &cache_root)
}

#[tauri::command]
pub fn list_clipboard_attachments(
    app: AppHandle,
    database: State<'_, Arc<Database>>,
    session_id: String,
) -> Result<Vec<ClipboardAttachmentRecord>, String> {
    let session_id = validate_session_id(&session_id)?;
    let cache_root = ensure_image_cache_dir(&app)?;
    // A previous process may have written some PTY bytes just before it exited.
    // Do not retry or silently return such an item to ready; make the user
    // inspect the terminal before taking another action.
    database.recover_interrupted_clipboard_attachment_operations(session_id, now_ms())?;
    database
        .list_clipboard_attachments(session_id)?
        .into_iter()
        .map(|record| hydrate_or_mark_missing(record, &cache_root, database.inner().as_ref()))
        .collect()
}

#[tauri::command]
pub fn set_clipboard_attachment_status(
    app: AppHandle,
    database: State<'_, Arc<Database>>,
    cache_state: State<'_, Arc<ClipboardImageCacheState>>,
    session_id: String,
    attachment_id: String,
    status: String,
) -> Result<ClipboardAttachmentRecord, String> {
    let session_id = validate_session_id(&session_id)?;
    validate_attachment_id(&attachment_id)?;
    validate_attachment_status(&status)?;
    let _operation = cache_state.operation_lock.lock();
    let record =
        database.set_clipboard_attachment_status(session_id, &attachment_id, &status, now_ms())?;
    let cache_root = ensure_image_cache_dir(&app)?;
    hydrate_or_mark_missing(record, &cache_root, database.inner().as_ref())
}

#[tauri::command]
pub fn release_clipboard_attachment(
    app: AppHandle,
    database: State<'_, Arc<Database>>,
    cache_state: State<'_, Arc<ClipboardImageCacheState>>,
    session_id: String,
    attachment_id: String,
) -> Result<ClipboardImageStorageStatus, String> {
    let session_id = validate_session_id(&session_id)?;
    validate_attachment_id(&attachment_id)?;
    let _operation = cache_state.operation_lock.lock();
    database.release_clipboard_attachment(session_id, &attachment_id, now_ms())?;
    cleanup_clipboard_image_cache_inner(&app, database.inner().as_ref())
}

#[tauri::command]
pub fn release_clipboard_session_attachments(
    app: AppHandle,
    database: State<'_, Arc<Database>>,
    cache_state: State<'_, Arc<ClipboardImageCacheState>>,
    session_id: String,
) -> Result<ClipboardImageStorageStatus, String> {
    let session_id = validate_session_id(&session_id)?;
    let _operation = cache_state.operation_lock.lock();
    database.release_clipboard_session_attachments(session_id, now_ms())?;
    cleanup_clipboard_image_cache_inner(&app, database.inner().as_ref())
}

#[tauri::command]
pub fn read_clipboard_attachment_preview(
    app: AppHandle,
    database: State<'_, Arc<Database>>,
    session_id: String,
    attachment_id: String,
) -> Result<ImagePreviewPayload, String> {
    let session_id = validate_session_id(&session_id)?;
    validate_attachment_id(&attachment_id)?;
    let cache_root = ensure_image_cache_dir(&app)?;
    let record = database.get_clipboard_attachment(session_id, &attachment_id)?;
    let record = hydrate_or_mark_missing(record, &cache_root, database.inner().as_ref())?;
    if !record.available || record.status == "failed" {
        return Err("图片文件已不可用，请重新粘贴图片".to_string());
    }
    let path = PathBuf::from(record.path);
    let bytes = fs::read(&path).map_err(|error| format!("读取图片失败: {error}"))?;
    validate_image_size(bytes.len())?;
    validate_image_signature(&bytes, &record.mime_type)?;
    Ok(ImagePreviewPayload {
        data_url: format!("data:{};base64,{}", record.mime_type, encode_base64(&bytes)),
    })
}

#[tauri::command]
pub fn get_clipboard_image_storage_status(
    app: AppHandle,
    database: State<'_, Arc<Database>>,
) -> Result<ClipboardImageStorageStatus, String> {
    storage_status(&app, database.inner().as_ref())
}

#[tauri::command]
pub fn cleanup_clipboard_image_cache(
    app: AppHandle,
    database: State<'_, Arc<Database>>,
    cache_state: State<'_, Arc<ClipboardImageCacheState>>,
) -> Result<ClipboardImageStorageStatus, String> {
    let _operation = cache_state.operation_lock.lock();
    cleanup_clipboard_image_cache_inner(&app, database.inner().as_ref())
}

/// Called once after the database is initialized. It never touches the legacy
/// cache because absolute paths from earlier terminal history may still refer
/// to those files.
pub fn reconcile_clipboard_image_cache(app: &AppHandle, database: &Database) -> Result<(), String> {
    let cache_root = ensure_image_cache_dir(app)?;
    let objects = database.list_clipboard_content_objects()?;
    let known_paths = objects
        .iter()
        .map(|object| object.relative_path.replace('\\', "/"))
        .collect::<HashSet<_>>();

    for object in &objects {
        let available = resolve_managed_cache_path(&cache_root, &object.relative_path)
            .ok()
            .is_some_and(|path| is_regular_managed_file(&cache_root, &path));
        if !available {
            database.mark_clipboard_content_missing(&object.content_hash, now_ms())?;
        }
    }

    let objects_dir = cache_root.join("objects");
    if !objects_dir.is_dir() {
        return Ok(());
    }
    for entry in
        fs::read_dir(&objects_dir).map_err(|error| format!("读取图片对象目录失败: {error}"))?
    {
        let entry = entry.map_err(|error| format!("读取图片对象条目失败: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取图片对象类型失败: {error}"))?;
        if !file_type.is_file() && !file_type.is_symlink() {
            continue;
        }
        let relative_path = format!("objects/{}", entry.file_name().to_string_lossy());
        if !known_paths.contains(&relative_path) {
            let _ = remove_managed_cache_file(&cache_root, &relative_path);
        }
    }
    Ok(())
}

/// Returns a browser-safe data URL for an image explicitly referenced in the
/// terminal. This legacy command intentionally remains path-based for normal
/// terminal file links; clipboard attachment previews use the scoped command
/// above instead.
#[tauri::command]
pub fn read_image_preview(path: String) -> Result<ImagePreviewPayload, String> {
    let image_path =
        PathBuf::from(path.trim_matches(|character| character == '\"' || character == '\''));
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

fn cleanup_clipboard_image_cache_inner(
    app: &AppHandle,
    database: &Database,
) -> Result<ClipboardImageStorageStatus, String> {
    let cache_root = ensure_image_cache_dir(app)?;
    let totals = database.clipboard_storage_totals()?;
    let legacy_bytes = legacy_cache_size(app)?;
    let mut managed_bytes = totals
        .protected_bytes
        .saturating_add(totals.reclaimable_bytes);
    let mut total_bytes = managed_bytes.saturating_add(legacy_bytes);
    let expiry_cutoff = now_ms().saturating_sub(CLIPBOARD_IMAGE_RETENTION_MS);

    for object in database.list_clipboard_gc_candidates()? {
        let is_expired = object
            .unreferenced_at_ms
            .is_some_and(|value| value <= expiry_cutoff);
        if !is_expired && total_bytes <= CLIPBOARD_IMAGE_SOFT_TARGET_BYTES {
            continue;
        }

        // Delete only after resolving the database relative path underneath the
        // controlled cache root. A malformed row can never target user files.
        remove_managed_cache_file(&cache_root, &object.relative_path)?;
        if database.delete_clipboard_content_object_if_unreferenced(&object.content_hash)? {
            managed_bytes = managed_bytes.saturating_sub(object.size_bytes);
            total_bytes = managed_bytes.saturating_add(legacy_bytes);
        }
    }

    storage_status_from_totals(
        &cache_root,
        database.clipboard_storage_totals()?,
        legacy_bytes,
    )
}

fn storage_status(
    app: &AppHandle,
    database: &Database,
) -> Result<ClipboardImageStorageStatus, String> {
    let cache_root = ensure_image_cache_dir(app)?;
    storage_status_from_totals(
        &cache_root,
        database.clipboard_storage_totals()?,
        legacy_cache_size(app)?,
    )
}

fn storage_status_from_totals(
    cache_root: &Path,
    totals: ClipboardStorageTotals,
    legacy_bytes: u64,
) -> Result<ClipboardImageStorageStatus, String> {
    Ok(ClipboardImageStorageStatus {
        cache_root: cache_root.to_string_lossy().into_owned(),
        protected_bytes: totals.protected_bytes,
        reclaimable_bytes: totals.reclaimable_bytes,
        legacy_bytes,
        soft_target_bytes: CLIPBOARD_IMAGE_SOFT_TARGET_BYTES,
        hard_limit_bytes: CLIPBOARD_IMAGE_HARD_LIMIT_BYTES,
    })
}

fn hydrate_or_mark_missing(
    record: ClipboardAttachmentRecord,
    cache_root: &Path,
    database: &Database,
) -> Result<ClipboardAttachmentRecord, String> {
    let mut hydrated = hydrate_attachment_record(record, cache_root)?;
    if !hydrated.available && hydrated.status != "released" {
        database.mark_clipboard_content_missing(&hydrated.content_hash, now_ms())?;
        hydrated.status = "failed".to_string();
    }
    Ok(hydrated)
}

fn hydrate_attachment_record(
    mut record: ClipboardAttachmentRecord,
    cache_root: &Path,
) -> Result<ClipboardAttachmentRecord, String> {
    let path = resolve_managed_cache_path(cache_root, &record.path)?;
    record.available = is_regular_managed_file(cache_root, &path);
    record.path = path.to_string_lossy().into_owned();
    Ok(record)
}

fn validate_session_id(session_id: &str) -> Result<&str, String> {
    let session_id = session_id.trim();
    if session_id.is_empty() || session_id.len() > 256 {
        return Err("无效的会话标识".to_string());
    }
    Ok(session_id)
}

fn validate_attachment_id(attachment_id: &str) -> Result<(), String> {
    if attachment_id.trim().is_empty() || attachment_id.len() > 256 {
        return Err("无效的附件标识".to_string());
    }
    Ok(())
}

fn validate_attachment_status(status: &str) -> Result<(), String> {
    match status {
        "ready" | "inserting" | "sending" | "inserted" | "delivered" | "failed"
        | "deliveryUnknown" => Ok(()),
        _ => Err("无效的附件状态".to_string()),
    }
}

fn extension_from_mime(mime_type: &str) -> Result<&'static str, String> {
    match mime_type {
        "image/png" => Ok("png"),
        "image/jpeg" => Ok("jpg"),
        "image/webp" => Ok("webp"),
        "image/gif" => Ok("gif"),
        other => Err(format!("暂不支持的图片格式: {other}")),
    }
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

fn validate_image_signature(bytes: &[u8], mime_type: &str) -> Result<(), String> {
    let matches_mime = match mime_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]) && bytes.ends_with(&[0xff, 0xd9]),
        "image/webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        _ => false,
    };
    if matches_mime {
        Ok(())
    } else {
        Err("图片内容与声明的格式不一致".to_string())
    }
}

fn ensure_image_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("获取缓存目录失败: {error}"))?;
    let image_dir = base_dir.join(IMAGE_CACHE_DIRECTORY);
    fs::create_dir_all(image_dir.join("objects"))
        .map_err(|error| format!("创建图片缓存目录失败: {error}"))?;
    Ok(image_dir)
}

fn resolve_managed_cache_path(cache_root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative_path.is_empty()
        || relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("无效的剪贴板缓存路径".to_string());
    }
    let path = cache_root.join(relative);
    if !path.starts_with(cache_root) {
        return Err("剪贴板缓存路径超出受控目录".to_string());
    }
    Ok(path)
}

fn publish_content_object(
    destination: &Path,
    bytes: &[u8],
    expected_hash: &str,
) -> Result<bool, String> {
    if destination.exists() {
        verify_existing_content_object(destination, expected_hash)?;
        return Ok(false);
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "无效的图片缓存目标路径".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建图片对象目录失败: {error}"))?;
    let temp_path = parent.join(format!(
        ".{}.{}.tmp",
        destination
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("clipboard-image"),
        rand::random::<u128>(),
    ));
    let result = (|| -> Result<bool, String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|error| format!("创建图片临时文件失败: {error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("写入图片临时文件失败: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("同步图片临时文件失败: {error}"))?;

        // hard_link is an atomic no-replace publication on the same volume.
        // It prevents a second writer from overwriting a completed object.
        match fs::hard_link(&temp_path, destination) {
            Ok(()) => Ok(true),
            Err(_) if destination.exists() => {
                verify_existing_content_object(destination, expected_hash)?;
                Ok(false)
            }
            Err(error) => Err(format!("发布图片对象失败: {error}")),
        }
    })();
    let _ = fs::remove_file(&temp_path);
    result
}

fn verify_existing_content_object(path: &Path, expected_hash: &str) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("读取已存在图片对象失败: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err("图片对象路径不是常规文件".to_string());
    }
    validate_image_size(metadata.len() as usize)?;
    let bytes = fs::read(path).map_err(|error| format!("读取已存在图片对象失败: {error}"))?;
    if format!("{:x}", Sha256::digest(&bytes)) != expected_hash {
        return Err("剪贴板图片缓存对象校验失败".to_string());
    }
    Ok(())
}

fn is_regular_managed_file(cache_root: &Path, path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return false;
    }
    let Ok(canonical_root) = cache_root.canonicalize() else {
        return false;
    };
    let Ok(canonical_path) = path.canonicalize() else {
        return false;
    };
    canonical_path.starts_with(canonical_root)
}

fn remove_managed_cache_file(cache_root: &Path, relative_path: &str) -> Result<(), String> {
    let path = resolve_managed_cache_path(cache_root, relative_path)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("读取待清理图片失败: {error}")),
    };
    if metadata.file_type().is_symlink() {
        fs::remove_file(&path).map_err(|error| format!("删除图片链接失败: {error}"))?;
        return Ok(());
    }
    if !metadata.file_type().is_file() || !is_regular_managed_file(cache_root, &path) {
        return Err("拒绝清理受控目录外的图片路径".to_string());
    }
    fs::remove_file(&path).map_err(|error| format!("删除图片缓存失败: {error}"))
}

fn legacy_cache_size(app: &AppHandle) -> Result<u64, String> {
    let base_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("获取缓存目录失败: {error}"))?;
    directory_size_without_links(&base_dir.join(LEGACY_IMAGE_CACHE_DIRECTORY))
}

fn directory_size_without_links(path: &Path) -> Result<u64, String> {
    if !path.exists() {
        return Ok(0);
    }
    let mut total = 0_u64;
    let mut directories = vec![path.to_path_buf()];
    while let Some(directory) = directories.pop() {
        for entry in
            fs::read_dir(&directory).map_err(|error| format!("读取旧图片缓存失败: {error}"))?
        {
            let entry = entry.map_err(|error| format!("读取旧图片缓存条目失败: {error}"))?;
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|error| format!("读取旧图片缓存元数据失败: {error}"))?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                directories.push(entry.path());
            } else if metadata.is_file() {
                total = total.saturating_add(metadata.len());
            }
        }
    }
    Ok(total)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    const INVALID_BASE64: &str = "无效的图片数据";
    if input.len() > MAX_ENCODED_IMAGE_SIZE_BYTES.saturating_add(8 * 1024) {
        return Err("图片超过 10MB，请压缩后再试".into());
    }
    let mut filtered = Vec::with_capacity(input.len().min(MAX_ENCODED_IMAGE_SIZE_BYTES));
    for byte in input.bytes() {
        if byte.is_ascii_whitespace() {
            continue;
        }
        filtered.push(byte);
        if filtered.len() > MAX_ENCODED_IMAGE_SIZE_BYTES {
            return Err("图片超过 10MB，请压缩后再试".into());
        }
    }
    if filtered.is_empty() || filtered.len() % 4 != 0 {
        return Err(INVALID_BASE64.into());
    }

    let mut output = Vec::with_capacity(filtered.len() / 4 * 3);
    let chunk_count = filtered.len() / 4;
    for (index, chunk) in filtered.chunks_exact(4).enumerate() {
        let c0 = decode_base64_char(chunk[0]).ok_or_else(|| INVALID_BASE64.to_string())?;
        let c1 = decode_base64_char(chunk[1]).ok_or_else(|| INVALID_BASE64.to_string())?;
        let c2 = if chunk[2] == b'=' {
            None
        } else {
            Some(decode_base64_char(chunk[2]).ok_or_else(|| INVALID_BASE64.to_string())?)
        };
        let c3 = if chunk[3] == b'=' {
            None
        } else {
            Some(decode_base64_char(chunk[3]).ok_or_else(|| INVALID_BASE64.to_string())?)
        };
        let is_last = index + 1 == chunk_count;
        if (!is_last && (c2.is_none() || c3.is_none())) || (c2.is_none() && c3.is_some()) {
            return Err(INVALID_BASE64.into());
        }

        output.push((c0 << 2) | (c1 >> 4));
        if let Some(c2) = c2 {
            output.push(((c1 & 0b0000_1111) << 4) | (c2 >> 2));
            if let Some(c3) = c3 {
                output.push(((c2 & 0b0000_0011) << 6) | c3);
            }
        }
    }
    validate_image_size(output.len())?;
    Ok(output)
}

fn decode_base64_char(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
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
    use super::{decode_base64, validate_image_signature};

    #[test]
    fn decodes_valid_base64_and_rejects_invalid_padding() {
        assert_eq!(decode_base64("YWJj").unwrap(), b"abc");
        assert!(decode_base64("YW=J").is_err());
        assert!(decode_base64("YQ==YQ==").is_err());
    }

    #[test]
    fn verifies_declared_image_format_against_file_signature() {
        assert!(validate_image_signature(b"\x89PNG\r\n\x1a\nrest", "image/png").is_ok());
        assert!(validate_image_signature(b"GIF89arest", "image/png").is_err());
    }
}
