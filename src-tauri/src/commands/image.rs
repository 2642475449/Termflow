use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
pub struct SavedImagePayload {
    pub path: String,
    pub file_name: String,
    pub size: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePreviewPayload {
    pub data_url: String,
}

#[tauri::command]
pub fn save_clipboard_image(
    app: AppHandle,
    data_base64: String,
    mime_type: String,
) -> Result<SavedImagePayload, String> {
    let extension = extension_from_mime(&mime_type)?;
    let bytes = decode_base64(&data_base64)?;
    validate_image_size(bytes.len())?;

    let output_dir = ensure_image_cache_dir(&app)?;
    let file_name = generate_image_file_name(extension);
    let file_path = output_dir.join(&file_name);

    fs::write(&file_path, &bytes).map_err(|e| format!("保存图片失败: {}", e))?;

    Ok(SavedImagePayload {
        path: file_path.to_string_lossy().into_owned(),
        file_name,
        size: bytes.len(),
    })
}

/// Returns a browser-safe data URL for an image explicitly referenced in the
/// terminal.  The size limit keeps hover previews responsive and avoids
/// creating a large base64 string in the WebView.
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

fn extension_from_mime(mime_type: &str) -> Result<&'static str, String> {
    match mime_type {
        "image/png" => Ok("png"),
        "image/jpeg" => Ok("jpg"),
        "image/webp" => Ok("webp"),
        "image/gif" => Ok("gif"),
        other => Err(format!("暂不支持的图片格式: {}", other)),
    }
}

fn validate_image_size(size: usize) -> Result<(), String> {
    const MAX_IMAGE_SIZE_BYTES: usize = 10 * 1024 * 1024;
    if size > MAX_IMAGE_SIZE_BYTES {
        return Err("图片超过 10MB，请压缩后再试".into());
    }
    Ok(())
}

fn ensure_image_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("获取缓存目录失败: {}", e))?;
    let image_dir = base_dir.join("clipboard-images");
    fs::create_dir_all(&image_dir).map_err(|e| format!("创建图片缓存目录失败: {}", e))?;
    Ok(image_dir)
}

fn generate_image_file_name(extension: &str) -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let process_id = std::process::id();
    format!(
        "termflow_clipboard_{}_{}.{}",
        timestamp, process_id, extension
    )
}

fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    const INVALID_BASE64: &str = "无效的图片数据";

    let filtered: Vec<u8> = input
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();

    if filtered.is_empty() || filtered.len() % 4 != 0 {
        return Err(INVALID_BASE64.into());
    }

    let mut output = Vec::with_capacity(filtered.len() / 4 * 3);

    for chunk in filtered.chunks(4) {
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

        output.push((c0 << 2) | (c1 >> 4));
        if let Some(c2) = c2 {
            output.push(((c1 & 0b0000_1111) << 4) | (c2 >> 2));
            if let Some(c3) = c3 {
                output.push(((c2 & 0b0000_0011) << 6) | c3);
            }
        }
    }

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
