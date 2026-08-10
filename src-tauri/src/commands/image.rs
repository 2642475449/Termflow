use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
pub struct SavedImagePayload {
    pub path: String,
    pub file_name: String,
    pub size: usize,
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
