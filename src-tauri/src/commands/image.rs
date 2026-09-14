use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const MAX_IMAGE_SIZE_BYTES: usize = 10 * 1024 * 1024;
const RETIRED_CLIPBOARD_IMAGE_CACHE_DIRECTORIES: [&str; 2] =
    ["clipboard-images", "clipboard-images-v2"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePreviewPayload {
    pub data_url: String,
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
    use super::{encode_base64, image_mime_type};
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
}
