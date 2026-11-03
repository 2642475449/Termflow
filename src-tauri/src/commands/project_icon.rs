use crate::database::{
    project_icons::{
        normalize_project_icon_path, project_icon_mime, LegacyProjectIcon, ProjectIconPreference,
        MAX_PROJECT_ICON_BYTES,
    },
    Database,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use regex::Regex;
use std::{collections::BTreeMap, fs::File, io::Read, path::Path, sync::Arc};
use tauri::{AppHandle, Emitter, State};

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
    let mime = project_icon_mime(bytes)?;
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

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectIconPreferenceUpdate {
    path: String,
    preference: ProjectIconPreference,
}

#[tauri::command]
pub async fn load_project_icon_preferences(
    database: State<'_, Arc<Database>>,
    legacy_projects: Vec<LegacyProjectIcon>,
) -> Result<BTreeMap<String, ProjectIconPreference>, String> {
    let database = database.inner().clone();
    super::run_background_task("加载项目图标设置", move || {
        database.load_project_icon_preferences(&legacy_projects)
    })
    .await
}

#[tauri::command]
pub async fn ensure_project_icon_preference(
    database: State<'_, Arc<Database>>,
    project_path: String,
) -> Result<ProjectIconPreference, String> {
    let database = database.inner().clone();
    super::run_background_task("初始化项目图标设置", move || {
        database.ensure_project_icon_preference(&project_path)
    })
    .await
}

#[tauri::command]
pub async fn save_project_icon_preference(
    database: State<'_, Arc<Database>>,
    app: AppHandle,
    project_path: String,
    preference: ProjectIconPreference,
) -> Result<ProjectIconPreference, String> {
    let database = database.inner().clone();
    super::run_background_task("保存项目图标设置", move || {
        let path = normalize_project_icon_path(&project_path)?;
        let preference = database.save_project_icon_preference(&path, preference)?;
        // 事件附带持久化修订号，较晚到达的旧事件不会覆盖新设置。
        if let Err(error) = app.emit(
            crate::events::PROJECT_ICON_PREFERENCE_UPDATED_EVENT,
            ProjectIconPreferenceUpdate {
                path,
                preference: preference.clone(),
            },
        ) {
            log::warn!("Failed to broadcast project icon preference: {error}");
        }
        Ok(preference)
    })
    .await
}

fn import_image(path: &str) -> Result<String, String> {
    let path = crate::path_utils::normalize_input_path(path);
    let file = File::open(path).map_err(|error| format!("读取图标图片失败: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("读取图标图片失败: {error}"))?;
    if !metadata.is_file() {
        return Err("请选择图片文件".into());
    }
    if metadata.len() > MAX_PROJECT_ICON_BYTES as u64 {
        return Err("图片超过 256KB，请压缩后再试".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_PROJECT_ICON_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取图标图片失败: {error}"))?;
    if bytes.len() > MAX_PROJECT_ICON_BYTES {
        return Err("图片超过 256KB，请压缩后再试".into());
    }
    image_url(&bytes).ok_or_else(|| "请选择 PNG、WebP、JPEG 或 ICO 图片".into())
}

#[tauri::command]
pub async fn import_project_icon(path: String) -> Result<String, String> {
    super::run_background_task("导入项目图标", move || import_image(&path)).await
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

    #[test]
    fn imports_selected_image_and_rejects_invalid_or_large_files() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("selected.png");
        fs::write(&path, PNG).expect("write");
        assert_eq!(
            import_image(&path.to_string_lossy()).expect("import"),
            image_url(PNG).expect("url")
        );
        fs::write(&path, b"not an image").expect("write invalid");
        assert!(import_image(&path.to_string_lossy()).is_err());
        fs::write(&path, vec![0; MAX_PROJECT_ICON_BYTES + 1]).expect("write large");
        assert!(import_image(&path.to_string_lossy()).is_err());
    }
}
