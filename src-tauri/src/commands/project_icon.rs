use base64::{engine::general_purpose::STANDARD, Engine};
use regex::Regex;
use std::{fs::File, io::Read, path::Path};

const MAX_ICON_BYTES: u64 = 256 * 1024;
const STEMS: &[&str] = &[
    "favicon",
    "public/favicon",
    "app/favicon",
    "app/icon",
    "src/app/icon",
    "src/favicon",
    "assets/favicon",
    "assets/icon",
    "static/favicon",
    "logo",
    "public/logo",
    "public/icon",
    "src-tauri/icons/icon",
    "app-icon",
    "icon",
];

// 图标属于派生数据：每次启动重新发现，不向用户的项目写入配置。
fn read_bounded(root: &Path, relative: &str) -> Option<Vec<u8>> {
    let path = root.join(relative).canonicalize().ok()?;
    if !path.starts_with(root) {
        return None;
    }
    let file = File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > MAX_ICON_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_ICON_BYTES + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= MAX_ICON_BYTES).then_some(bytes)
}

fn image_url(bytes: &[u8]) -> Option<String> {
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"\x00\x00\x01\x00") {
        "image/x-icon"
    } else {
        return None;
    };
    Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

fn detect(root: &Path) -> Option<String> {
    let root = root.canonicalize().ok()?;
    if !root.is_dir() {
        return None;
    }
    for stem in STEMS {
        for extension in ["png", "webp", "ico", "jpg", "jpeg"] {
            if let Some(url) = read_bounded(&root, &format!("{stem}.{extension}"))
                .and_then(|bytes| image_url(&bytes))
            {
                return Some(url);
            }
        }
    }
    // 支持 HTML 显式声明的非标准文件名；拒绝 URL、越界路径及指向项目外的符号链接。
    let links = Regex::new(r"(?is)<link\b[^>]*>").ok()?;
    let attributes = Regex::new(r#"(?is)\b(rel|href)\s*=\s*["']([^"']*)["']"#).ok()?;
    for source in ["index.html", "public/index.html", "src/index.html"] {
        let Some(bytes) = read_bounded(&root, source) else {
            continue;
        };
        let html = String::from_utf8_lossy(&bytes);
        for link in links.find_iter(&html) {
            let mut rel = String::new();
            let mut href = String::new();
            for attr in attributes.captures_iter(link.as_str()) {
                match attr[1].to_ascii_lowercase().as_str() {
                    "rel" => rel = attr[2].to_ascii_lowercase(),
                    "href" => href = attr[2].to_owned(),
                    _ => {}
                }
            }
            if !rel
                .split_whitespace()
                .any(|part| matches!(part, "icon" | "apple-touch-icon"))
            {
                continue;
            }
            let href = href.trim().split(['?', '#']).next().unwrap_or("");
            if href.is_empty()
                || href.contains(':')
                || href.contains('\\')
                || href.starts_with("//")
                || href.split('/').any(|part| part == "..")
            {
                continue;
            }
            let relative = href.trim_start_matches('/');
            let mut candidates = Vec::new();
            if !href.starts_with('/') {
                if let Some(parent) = Path::new(source).parent() {
                    candidates.push(parent.join(relative).to_string_lossy().into_owned());
                }
            }
            candidates.extend([format!("public/{relative}"), relative.to_owned()]);
            for candidate in candidates {
                if let Some(url) =
                    read_bounded(&root, &candidate).and_then(|bytes| image_url(&bytes))
                {
                    return Some(url);
                }
            }
        }
    }
    None
}

#[tauri::command]
pub async fn detect_project_icon(project_path: String) -> Result<Option<String>, String> {
    super::run_background_task("读取项目图标", move || {
        Ok(detect(&crate::path_utils::normalize_input_path(
            &project_path,
        )))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n";

    #[test]
    fn finds_tauri_icon_and_prefers_public_logo() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::create_dir_all(dir.path().join("src-tauri/icons")).expect("mkdir");
        fs::write(dir.path().join("src-tauri/icons/icon.png"), PNG).expect("write");
        assert!(detect(dir.path()).is_some());
        fs::create_dir(dir.path().join("public")).expect("mkdir");
        fs::write(dir.path().join("public/logo.png"), [PNG, b"logo"].concat()).expect("write");
        assert_eq!(detect(dir.path()), image_url(&[PNG, b"logo"].concat()));
    }

    #[test]
    fn resolves_html_icon_with_query_and_reversed_attributes() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::create_dir_all(dir.path().join("public/brand")).expect("mkdir");
        fs::write(
            dir.path().join("index.html"),
            r#"<link href="/brand/mark.png?v=2" rel="shortcut icon">"#,
        )
        .expect("write");
        fs::write(dir.path().join("public/brand/mark.png"), PNG).expect("write");
        assert_eq!(detect(dir.path()), image_url(PNG));
    }

    #[test]
    fn skips_invalid_and_oversized_images_and_missing_projects() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::write(dir.path().join("favicon.png"), b"not an image").expect("write");
        fs::write(
            dir.path().join("logo.png"),
            vec![0; MAX_ICON_BYTES as usize + 1],
        )
        .expect("write");
        assert_eq!(detect(dir.path()), None);
        assert_eq!(detect(&dir.path().join("missing")), None);
    }

    #[test]
    fn rejects_parent_traversal_in_html() {
        let dir = tempfile::tempdir().expect("temp dir");
        fs::create_dir(dir.path().join("project")).expect("mkdir");
        fs::write(dir.path().join("outside.png"), PNG).expect("write");
        fs::write(
            dir.path().join("project/index.html"),
            r#"<link rel="icon" href="../outside.png">"#,
        )
        .expect("write");
        assert_eq!(detect(&dir.path().join("project")), None);
    }
}
