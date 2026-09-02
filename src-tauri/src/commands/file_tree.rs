use crate::path_utils::{display_path, normalize_input_path};
use serde::Serialize;
use std::cmp::Ordering;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_EDITABLE_TEXT_FILE_BYTES: u64 = 1024 * 1024;
const MAX_PREVIEWABLE_PDF_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PREVIEWABLE_OFFICE_FILE_BYTES: u64 = 64 * 1024 * 1024;
const PREVIEWABLE_OFFICE_EXTENSIONS: [&str; 16] = [
    "doc", "docx", "dot", "dotx", "rtf", "odt", "xls", "xlsx", "xlsm", "xlsb", "ods", "csv", "ppt",
    "pptx", "ppsx", "odp",
];

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeEntry {
    pub name: String,
    pub path: String,
    pub kind: FileTreeEntryKind,
    pub has_children: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileTreeEntryKind {
    File,
    Directory,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeListing {
    pub root_path: String,
    pub directory_path: String,
    pub entries: Vec<FileTreeEntry>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLinkTarget {
    pub path: String,
    pub kind: FileTreeEntryKind,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileContent {
    pub path: String,
    pub name: String,
    pub content: String,
    pub kind: ProjectFileKind,
    pub read_only: bool,
    pub size_bytes: u64,
    pub large_file: bool,
    pub modified_at_ms: Option<u64>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProjectFileKind {
    Text,
    Image,
    Pdf,
    Binary,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileStatus {
    pub path: String,
    pub name: String,
    pub kind: ProjectFileKind,
    pub read_only: bool,
    pub size_bytes: u64,
    pub large_file: bool,
    pub modified_at_ms: Option<u64>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectImagePayload {
    pub path: String,
    pub name: String,
    pub mime_type: String,
    pub data_url: String,
    pub size_bytes: u64,
}

#[tauri::command]
pub fn list_project_directory(
    project_path: String,
    directory_path: Option<String>,
) -> Result<FileTreeListing, String> {
    let root_path = normalize_input_path(&project_path);
    if !root_path.exists() {
        return Err("项目目录不存在".to_string());
    }

    let target_path = resolve_target_path(&root_path, directory_path.as_deref())?;
    if !target_path.is_dir() {
        return Err("目标路径不是文件夹".to_string());
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(&target_path).map_err(|e| format!("读取目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
        let path = entry.path();
        let metadata = entry
            .metadata()
            .map_err(|e| format!("读取文件元数据失败: {}", e))?;
        let kind = if metadata.is_dir() {
            FileTreeEntryKind::Directory
        } else {
            FileTreeEntryKind::File
        };

        let has_children = matches!(kind, FileTreeEntryKind::Directory)
            && directory_has_children(&path).unwrap_or(false);

        entries.push(FileTreeEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: display_path(&path),
            kind,
            has_children,
        });
    }

    entries.sort_by(compare_entries);

    Ok(FileTreeListing {
        root_path: display_path(&root_path),
        directory_path: display_path(&target_path),
        entries,
    })
}

/// Resolves a terminal file-link candidate without reading the target directory
/// or file contents. The result is deliberately restricted to the active
/// project root so arbitrary terminal text cannot expose external paths.
#[tauri::command]
pub fn resolve_project_link(
    project_path: String,
    path: String,
) -> Result<ProjectLinkTarget, String> {
    let root_path = normalize_input_path(&project_path);
    if !root_path.exists() {
        return Err("项目目录不存在".to_string());
    }

    let target_path = resolve_target_path(&root_path, Some(&path))?;
    let metadata =
        fs::metadata(&target_path).map_err(|_| "目标路径不存在或无法访问".to_string())?;
    let kind = if metadata.is_dir() {
        FileTreeEntryKind::Directory
    } else if metadata.is_file() {
        FileTreeEntryKind::File
    } else {
        return Err("目标路径不是文件或目录".to_string());
    };

    Ok(ProjectLinkTarget {
        path: display_path(&target_path),
        kind,
    })
}

#[tauri::command]
pub fn search_project_entries(
    project_path: String,
    query: String,
) -> Result<Vec<FileTreeEntry>, String> {
    let root_path = normalize_input_path(&project_path);
    if !root_path.exists() {
        return Err("项目目录不存在".to_string());
    }

    let keyword = query.trim().to_lowercase().replace('\\', "/");
    if keyword.is_empty() {
        return Ok(Vec::new());
    }

    let mut matches = Vec::new();
    collect_search_matches(&root_path, &root_path, &keyword, &mut matches)?;
    matches.sort_by(compare_search_matches);
    Ok(matches.into_iter().map(|result| result.entry).collect())
}

#[tauri::command]
pub fn rename_project_entry(
    project_path: String,
    path: String,
    new_name: String,
) -> Result<String, String> {
    let root_path = normalize_input_path(&project_path);
    if !root_path.exists() {
        return Err("项目目录不存在".to_string());
    }

    let target_path = resolve_entry_path(&root_path, &path)?;
    if !target_path.exists() {
        return Err("目标路径不存在".to_string());
    }

    let next_path = build_renamed_path(&target_path, &new_name)?;
    if next_path == target_path {
        return Ok(display_path(&target_path));
    }
    if next_path.exists() {
        return Err("同名文件或文件夹已存在".to_string());
    }

    fs::rename(&target_path, &next_path).map_err(|e| format!("重命名失败: {}", e))?;
    Ok(display_path(&next_path))
}

#[tauri::command]
pub async fn delete_project_entry(project_path: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_project_entry_blocking(project_path, path))
        .await
        .map_err(|error| format!("移动到回收站失败: {}", error))?
}

fn delete_project_entry_blocking(project_path: String, path: String) -> Result<(), String> {
    let root_path = normalize_input_path(&project_path);
    if !root_path.exists() {
        return Err("项目目录不存在".to_string());
    }

    let target_path = resolve_entry_path(&root_path, &path)?;
    if !target_path.exists() {
        return Err("目标路径不存在".to_string());
    }

    trash::delete(&target_path).map_err(|e| format!("移动到回收站失败: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn create_project_file(
    project_path: String,
    parent_path: String,
    name: String,
) -> Result<String, String> {
    let root_path = normalize_input_path(&project_path);
    if !root_path.exists() {
        return Err("项目目录不存在".to_string());
    }

    let target_directory = resolve_create_parent_path(&root_path, &parent_path)?;
    let next_path = build_child_path(&target_directory, &name)?;
    if next_path.exists() {
        return Err("同名文件或文件夹已存在".to_string());
    }

    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&next_path)
        .map_err(|e| format!("新建文件失败: {}", e))?;

    Ok(display_path(&next_path))
}

#[tauri::command]
pub fn create_project_directory(
    project_path: String,
    parent_path: String,
    name: String,
) -> Result<String, String> {
    let root_path = normalize_input_path(&project_path);
    if !root_path.exists() {
        return Err("项目目录不存在".to_string());
    }

    let target_directory = resolve_create_parent_path(&root_path, &parent_path)?;
    let next_path = build_child_path(&target_directory, &name)?;
    if next_path.exists() {
        return Err("同名文件或文件夹已存在".to_string());
    }

    fs::create_dir(&next_path).map_err(|e| format!("新建文件夹失败: {}", e))?;
    Ok(display_path(&next_path))
}

#[tauri::command]
pub fn read_project_file(project_path: String, path: String) -> Result<ProjectFileContent, String> {
    let root_path = normalize_input_path(&project_path);
    if !root_path.exists() {
        return Err("项目目录不存在".to_string());
    }

    let target_path = resolve_entry_path(&root_path, &path)?;
    if !target_path.exists() {
        return Err("目标路径不存在".to_string());
    }
    if !target_path.is_file() {
        return Err("目标路径不是文件".to_string());
    }

    let metadata = fs::metadata(&target_path).map_err(|e| format!("读取文件元数据失败: {}", e))?;
    let kind = detect_file_kind(&target_path)?;
    if kind != ProjectFileKind::Text {
        return Err("当前文件不是可内置编辑的文本文件".to_string());
    }
    let size_bytes = metadata.len();
    let large_file = size_bytes > MAX_EDITABLE_TEXT_FILE_BYTES;
    let content = fs::read_to_string(&target_path).map_err(|e| format!("读取文件失败: {}", e))?;

    Ok(ProjectFileContent {
        path: display_path(&target_path),
        name: target_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| display_path(&target_path)),
        content,
        kind,
        read_only: metadata.permissions().readonly() || large_file,
        size_bytes,
        large_file,
        modified_at_ms: metadata_modified_at_ms(&metadata),
    })
}

#[tauri::command]
pub fn read_project_image(
    project_path: String,
    path: String,
) -> Result<ProjectImagePayload, String> {
    let root_path = normalize_input_path(&project_path);
    if !root_path.exists() {
        return Err("项目目录不存在".to_string());
    }

    let target_path = resolve_entry_path(&root_path, &path)?;
    if !target_path.is_file() {
        return Err("目标路径不是文件".to_string());
    }
    if !matches_image_extension(&target_path) {
        return Err("目标文件不是受支持的图片".to_string());
    }

    let metadata = fs::metadata(&target_path).map_err(|e| format!("读取文件元数据失败: {}", e))?;
    let bytes = fs::read(&target_path).map_err(|e| format!("读取图片失败: {}", e))?;
    let mime_type = image_mime_type(&target_path)?;
    let data_url = format!("data:{};base64,{}", mime_type, encode_base64(&bytes));

    Ok(ProjectImagePayload {
        path: display_path(&target_path),
        name: target_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string(),
        mime_type: mime_type.to_string(),
        data_url,
        size_bytes: metadata.len(),
    })
}

#[tauri::command]
pub fn read_project_pdf(
    project_path: String,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let root_path = normalize_input_path(&project_path);
    if !root_path.exists() {
        return Err("项目目录不存在".to_string());
    }

    let target_path = resolve_entry_path(&root_path, &path)?;
    if !target_path.is_file() {
        return Err("目标路径不是文件".to_string());
    }

    let metadata = fs::metadata(&target_path).map_err(|e| format!("读取文件元数据失败: {}", e))?;
    if metadata.len() > MAX_PREVIEWABLE_PDF_FILE_BYTES {
        return Err("PDF 超过 64 MB，请使用系统默认应用打开".to_string());
    }

    let bytes = fs::read(&target_path).map_err(|e| format!("读取 PDF 失败: {}", e))?;
    if !matches_pdf_signature(&bytes) {
        return Err("文件内容不是有效的 PDF".to_string());
    }

    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn read_project_office_preview(
    project_path: String,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let root_path = normalize_input_path(&project_path);
    if !root_path.exists() {
        return Err("项目目录不存在".to_string());
    }

    let canonical_root =
        fs::canonicalize(&root_path).map_err(|e| format!("解析项目目录失败: {}", e))?;
    let target_path = resolve_entry_path(&root_path, &path)?;
    let target_path =
        fs::canonicalize(&target_path).map_err(|e| format!("解析 Office 文件路径失败: {}", e))?;
    if !target_path.starts_with(&canonical_root) {
        return Err("不允许通过链接访问项目目录之外的 Office 文件".to_string());
    }
    if !target_path.is_file() {
        return Err("目标路径不是文件".to_string());
    }
    if !is_previewable_office_file(&target_path) {
        return Err("当前文件不是受支持的 Office 预览格式".to_string());
    }

    let metadata = fs::metadata(&target_path).map_err(|e| format!("读取文件元数据失败: {}", e))?;
    if metadata.len() > MAX_PREVIEWABLE_OFFICE_FILE_BYTES {
        return Err("Office 文件超过 64 MB，请使用系统默认应用打开".to_string());
    }

    let bytes = fs::read(&target_path).map_err(|e| format!("读取 Office 文件失败: {}", e))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn write_project_file(
    project_path: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let root_path = normalize_input_path(&project_path);
    if !root_path.exists() {
        return Err("项目目录不存在".to_string());
    }

    let target_path = resolve_entry_path(&root_path, &path)?;
    if !target_path.exists() {
        return Err("目标路径不存在".to_string());
    }
    if !target_path.is_file() {
        return Err("目标路径不是文件".to_string());
    }

    let metadata = fs::metadata(&target_path).map_err(|e| format!("读取文件元数据失败: {}", e))?;
    if metadata.permissions().readonly() {
        return Err("当前文件为只读，无法保存".to_string());
    }

    fs::write(&target_path, content).map_err(|e| format!("保存文件失败: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn inspect_project_file(
    project_path: String,
    path: String,
) -> Result<ProjectFileStatus, String> {
    let root_path = normalize_input_path(&project_path);
    if !root_path.exists() {
        return Err("项目目录不存在".to_string());
    }

    let target_path = resolve_entry_path(&root_path, &path)?;
    if !target_path.exists() {
        return Err("目标路径不存在".to_string());
    }
    if !target_path.is_file() {
        return Err("目标路径不是文件".to_string());
    }

    let metadata = fs::metadata(&target_path).map_err(|e| format!("读取文件元数据失败: {}", e))?;

    Ok(ProjectFileStatus {
        path: display_path(&target_path),
        name: target_path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| display_path(&target_path)),
        kind: detect_file_kind(&target_path)?,
        read_only: metadata.permissions().readonly()
            || metadata.len() > MAX_EDITABLE_TEXT_FILE_BYTES,
        size_bytes: metadata.len(),
        large_file: metadata.len() > MAX_EDITABLE_TEXT_FILE_BYTES,
        modified_at_ms: metadata_modified_at_ms(&metadata),
    })
}

#[tauri::command]
pub fn copy_external_entry(
    project_path: String,
    source_paths: Vec<String>,
    destination_directory: String,
    new_name: Option<String>,
) -> Result<Vec<String>, String> {
    let root_path = normalize_input_path(&project_path);
    if !root_path.exists() {
        return Err("项目目录不存在".to_string());
    }

    let dest_dir = resolve_existing_directory_path(&destination_directory)?;

    let normalized_sources = source_paths
        .iter()
        .map(|path| normalize_input_path(path))
        .collect::<Vec<_>>();
    copy_entries_into_directory(&normalized_sources, &dest_dir, new_name.as_deref())
}

#[tauri::command]
pub fn copy_project_entries(
    project_path: String,
    source_paths: Vec<String>,
    destination_directory: String,
) -> Result<Vec<String>, String> {
    let root_path = normalize_input_path(&project_path);
    if !root_path.exists() {
        return Err("项目目录不存在".to_string());
    }

    let dest_dir = resolve_create_parent_path(&root_path, &destination_directory)?;
    let normalized_sources = source_paths
        .iter()
        .map(|path| resolve_entry_path(&root_path, path))
        .collect::<Result<Vec<_>, _>>()?;

    copy_entries_into_directory(&normalized_sources, &dest_dir, None)
}

fn build_unique_copy_path(
    dest_dir: &Path,
    file_name: &str,
    source_path: &Path,
) -> Result<PathBuf, String> {
    let mut target_path = dest_dir.join(file_name);
    if !target_path.exists() {
        return Ok(target_path);
    }

    let (stem, extension) = if source_path.is_dir() {
        (file_name.to_string(), String::new())
    } else {
        let path = Path::new(file_name);
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let ext = path
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        (stem, ext)
    };

    for attempt in 1..1000 {
        let new_name = format!("{} ({}){}", stem, attempt, extension);
        target_path = dest_dir.join(&new_name);
        if !target_path.exists() {
            return Ok(target_path);
        }
    }

    Err("无法生成唯一文件名".to_string())
}

fn copy_directory_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|e| format!("创建目录失败: {}", e))?;

    for entry in fs::read_dir(source).map_err(|e| format!("读取目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
        let entry_path = entry.path();
        let entry_name = entry.file_name();
        let target_path = destination.join(&entry_name);

        if entry_path.is_dir() {
            copy_directory_recursive(&entry_path, &target_path)?;
        } else {
            fs::copy(&entry_path, &target_path).map_err(|e| format!("复制文件失败: {}", e))?;
        }
    }

    Ok(())
}

fn copy_entries_into_directory(
    source_paths: &[PathBuf],
    dest_dir: &Path,
    single_target_name: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut copied_paths = Vec::new();
    let validated_single_target_name = match single_target_name {
        Some(name) if source_paths.len() == 1 => Some(validate_entry_name(name)?.to_string()),
        _ => None,
    };

    for source_path in source_paths {
        if !source_path.exists() {
            continue;
        }

        if source_path.is_dir() && dest_dir.starts_with(source_path) {
            return Err("不能复制文件夹到其自身或子目录".to_string());
        }

        let file_name = source_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if file_name.is_empty() {
            continue;
        }

        let target_path = if let Some(target_name) = validated_single_target_name.as_deref() {
            let explicit_target_path = dest_dir.join(target_name);
            if explicit_target_path.exists() {
                return Err("A file or folder with the same name already exists".to_string());
            }
            explicit_target_path
        } else {
            build_unique_copy_path(dest_dir, &file_name, source_path)?
        };

        if source_path.is_dir() {
            copy_directory_recursive(source_path, &target_path)?;
        } else {
            fs::copy(source_path, &target_path).map_err(|e| format!("复制文件失败: {}", e))?;
        }

        copied_paths.push(display_path(&target_path));
    }

    Ok(copied_paths)
}

fn resolve_target_path(root_path: &Path, requested: Option<&str>) -> Result<PathBuf, String> {
    let target = match requested {
        Some(path) if !path.trim().is_empty() => normalize_input_path(path.trim()),
        _ => root_path.to_path_buf(),
    };

    if !target.starts_with(root_path) {
        return Err("不允许访问项目目录之外的路径".to_string());
    }

    Ok(target)
}

fn resolve_entry_path(root_path: &Path, path: &str) -> Result<PathBuf, String> {
    let target = normalize_input_path(path.trim());
    if !target.starts_with(root_path) {
        return Err("不允许访问项目目录之外的路径".to_string());
    }
    if target == root_path {
        return Err("不允许修改项目根目录".to_string());
    }

    Ok(target)
}

fn resolve_create_parent_path(root_path: &Path, parent_path: &str) -> Result<PathBuf, String> {
    let target = normalize_input_path(parent_path.trim());
    if !target.starts_with(root_path) {
        return Err("不允许访问项目目录之外的路径".to_string());
    }
    if !target.exists() {
        return Err("目标文件夹不存在".to_string());
    }
    if !target.is_dir() {
        return Err("目标路径不是文件夹".to_string());
    }

    Ok(target)
}

fn resolve_existing_directory_path(directory_path: &str) -> Result<PathBuf, String> {
    let target = normalize_input_path(directory_path.trim());
    if !target.exists() {
        return Err("Destination directory does not exist".to_string());
    }
    if !target.is_dir() {
        return Err("Destination path is not a directory".to_string());
    }

    Ok(target)
}

fn validate_entry_name(name: &str) -> Result<&str, String> {
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() {
        return Err("名称不能为空".to_string());
    }
    if matches!(trimmed_name, "." | "..") {
        return Err("名称不能为 . 或 ..".to_string());
    }
    if trimmed_name.contains(['\\', '/']) {
        return Err("名称不能包含路径分隔符".to_string());
    }
    if trimmed_name.contains(['<', '>', ':', '"', '|', '?', '*']) {
        return Err("名称包含非法字符".to_string());
    }

    Ok(trimmed_name)
}

fn build_child_path(parent: &Path, name: &str) -> Result<PathBuf, String> {
    let trimmed_name = validate_entry_name(name)?;
    Ok(parent.join(trimmed_name))
}

fn build_renamed_path(path: &Path, new_name: &str) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "无法定位目标路径的父目录".to_string())?;

    build_child_path(parent, new_name)
}

fn directory_has_children(path: &Path) -> Result<bool, String> {
    let mut entries = fs::read_dir(path).map_err(|e| e.to_string())?;
    Ok(entries
        .next()
        .transpose()
        .map_err(|e| e.to_string())?
        .is_some())
}

fn metadata_modified_at_ms(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
}

fn detect_file_kind(path: &Path) -> Result<ProjectFileKind, String> {
    if matches_pdf_extension(path) {
        return Ok(ProjectFileKind::Pdf);
    }
    if matches_image_extension(path) {
        return Ok(ProjectFileKind::Image);
    }
    if matches_text_extension(path) {
        return Ok(ProjectFileKind::Text);
    }

    let mut file = fs::File::open(path).map_err(|e| format!("打开文件失败: {}", e))?;
    let mut buffer = [0u8; 8192];
    let read_size = file
        .read(&mut buffer)
        .map_err(|e| format!("读取文件样本失败: {}", e))?;
    let sample = &buffer[..read_size];

    if sample.is_empty() {
        return Ok(ProjectFileKind::Text);
    }
    if matches_pdf_signature(sample) {
        return Ok(ProjectFileKind::Pdf);
    }
    if sample.contains(&0) {
        return Ok(ProjectFileKind::Binary);
    }
    if std::str::from_utf8(sample).is_ok() {
        return Ok(ProjectFileKind::Text);
    }

    Ok(ProjectFileKind::Binary)
}

fn matches_pdf_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
}

fn is_previewable_office_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .is_some_and(|extension| PREVIEWABLE_OFFICE_EXTENSIONS.contains(&extension.as_str()))
}

fn matches_pdf_signature(bytes: &[u8]) -> bool {
    bytes.starts_with(b"%PDF-")
}

fn matches_image_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase()),
        Some(extension)
            if ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].contains(&extension.as_str())
    )
}

fn image_mime_type(path: &Path) -> Result<&'static str, String> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Ok("image/png"),
        Some("jpg") | Some("jpeg") => Ok("image/jpeg"),
        Some("gif") => Ok("image/gif"),
        Some("webp") => Ok("image/webp"),
        Some("svg") => Ok("image/svg+xml"),
        Some("bmp") => Ok("image/bmp"),
        Some("ico") => Ok("image/x-icon"),
        _ => Err("不支持的图片格式".to_string()),
    }
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);

    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);

        output.push(TABLE[(b0 >> 2) as usize] as char);
        output.push(TABLE[((b0 & 0b0000_0011) << 4 | (b1 >> 4)) as usize] as char);

        if chunk.len() > 1 {
            output.push(TABLE[((b1 & 0b0000_1111) << 2 | (b2 >> 6)) as usize] as char);
        } else {
            output.push('=');
        }

        if chunk.len() > 2 {
            output.push(TABLE[(b2 & 0b0011_1111) as usize] as char);
        } else {
            output.push('=');
        }
    }

    output
}

fn matches_text_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase()),
        Some(extension)
            if [
                "txt", "md", "json", "js", "jsx", "ts", "tsx", "rs", "css", "scss", "html", "htm",
                "xml", "yml", "yaml", "toml", "sh", "ps1", "bat", "env", "log", "csv", "sql", "py",
                "java", "go", "c", "cpp", "h", "hpp", "ini", "conf", "cfg", "lock"
            ]
            .contains(&extension.as_str())
    )
}

const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    ".git",
    ".svn",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "coverage",
    "__pycache__",
    ".cache",
    "vendor",
];
const MAX_SEARCH_RESULTS: usize = 200;

#[derive(Debug)]
struct ProjectEntrySearchMatch {
    entry: FileTreeEntry,
    score: usize,
    depth: usize,
}

fn fuzzy_match_score(value: &str, keyword: &str) -> Option<usize> {
    let mut keyword_chars = keyword.chars();
    let mut expected = keyword_chars.next()?;
    let mut score = 0;
    let mut previous_match = 0;

    for (index, character) in value.chars().enumerate() {
        if character != expected {
            continue;
        }
        score += index.saturating_sub(previous_match);
        previous_match = index + 1;
        match keyword_chars.next() {
            Some(next) => expected = next,
            None => return Some(score),
        }
    }

    None
}

fn project_entry_match_score(name: &str, relative_path: &str, keyword: &str) -> Option<usize> {
    let lower_name = name.to_lowercase();
    let lower_path = relative_path.to_lowercase().replace('\\', "/");

    if lower_name == keyword {
        return Some(0);
    }
    if lower_name.starts_with(keyword) {
        return Some(100 + lower_name.len().saturating_sub(keyword.len()));
    }
    if let Some(index) = lower_name.find(keyword) {
        return Some(200 + index);
    }
    if let Some(index) = lower_path.find(keyword) {
        return Some(300 + index);
    }
    if let Some(score) = fuzzy_match_score(&lower_name, keyword) {
        return Some(400 + score);
    }
    fuzzy_match_score(&lower_path, keyword).map(|score| 600 + score)
}

fn compare_search_matches(
    left: &ProjectEntrySearchMatch,
    right: &ProjectEntrySearchMatch,
) -> Ordering {
    left.score
        .cmp(&right.score)
        .then_with(|| left.depth.cmp(&right.depth))
        .then_with(|| compare_entries(&left.entry, &right.entry))
}

fn push_search_match(
    results: &mut Vec<ProjectEntrySearchMatch>,
    candidate: ProjectEntrySearchMatch,
) {
    if results.len() < MAX_SEARCH_RESULTS {
        results.push(candidate);
        return;
    }

    let Some((worst_index, worst)) = results
        .iter()
        .enumerate()
        .max_by(|(_, left), (_, right)| compare_search_matches(left, right))
    else {
        return;
    };

    if compare_search_matches(&candidate, worst).is_lt() {
        results[worst_index] = candidate;
    }
}

fn collect_search_matches(
    root_path: &Path,
    path: &Path,
    keyword: &str,
    results: &mut Vec<ProjectEntrySearchMatch>,
) -> Result<(), String> {
    for entry in fs::read_dir(path).map_err(|e| format!("读取目录失败: {}", e))? {
        let entry = entry.map_err(|e| format!("读取目录项失败: {}", e))?;
        let child_path = entry.path();
        let metadata = entry
            .metadata()
            .map_err(|e| format!("读取文件元数据失败: {}", e))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let kind = if metadata.is_dir() {
            FileTreeEntryKind::Directory
        } else {
            FileTreeEntryKind::File
        };

        let relative_path = child_path
            .strip_prefix(root_path)
            .unwrap_or(&child_path)
            .to_string_lossy()
            .replace('\\', "/");
        if let Some(score) = project_entry_match_score(&name, &relative_path, keyword) {
            push_search_match(
                results,
                ProjectEntrySearchMatch {
                    entry: FileTreeEntry {
                        name: name.clone(),
                        path: display_path(&child_path),
                        kind: kind.clone(),
                        has_children: matches!(kind, FileTreeEntryKind::Directory)
                            && directory_has_children(&child_path).unwrap_or(false),
                    },
                    score,
                    depth: relative_path.matches('/').count(),
                },
            );
        }

        if metadata.is_dir() {
            if IGNORED_DIRS.contains(&name.as_str()) {
                continue;
            }
            collect_search_matches(root_path, &child_path, keyword, results)?;
        }
    }

    Ok(())
}

fn compare_entries(left: &FileTreeEntry, right: &FileTreeEntry) -> Ordering {
    match (&left.kind, &right.kind) {
        (FileTreeEntryKind::Directory, FileTreeEntryKind::File) => Ordering::Less,
        (FileTreeEntryKind::File, FileTreeEntryKind::Directory) => Ordering::Greater,
        _ => left
            .name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.name.cmp(&right.name)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::{InvokeResponseBody, IpcResponse};

    #[test]
    fn compare_entries_keeps_directories_first() {
        let dir = FileTreeEntry {
            name: "src".to_string(),
            path: "D:/demo/src".to_string(),
            kind: FileTreeEntryKind::Directory,
            has_children: true,
        };
        let file = FileTreeEntry {
            name: "README.md".to_string(),
            path: "D:/demo/README.md".to_string(),
            kind: FileTreeEntryKind::File,
            has_children: false,
        };

        assert_eq!(compare_entries(&dir, &file), Ordering::Less);
    }

    #[test]
    fn compare_entries_sorts_case_insensitively() {
        let alpha = FileTreeEntry {
            name: "alpha".to_string(),
            path: "D:/demo/alpha".to_string(),
            kind: FileTreeEntryKind::Directory,
            has_children: false,
        };
        let beta = FileTreeEntry {
            name: "Beta".to_string(),
            path: "D:/demo/Beta".to_string(),
            kind: FileTreeEntryKind::Directory,
            has_children: false,
        };

        assert_eq!(compare_entries(&alpha, &beta), Ordering::Less);
    }

    #[test]
    fn project_entry_search_prefers_exact_and_prefix_matches() {
        let exact = project_entry_match_score("dist", "dist", "dist").unwrap();
        let prefix = project_entry_match_score("distance.ts", "src/distance.ts", "dist").unwrap();
        let contained =
            project_entry_match_score("redistribution.ts", "src/redistribution.ts", "dist")
                .unwrap();

        assert!(exact < prefix);
        assert!(prefix < contained);
    }

    #[test]
    fn project_entry_search_matches_paths_and_fuzzy_names() {
        assert!(
            project_entry_match_score("main.rs", "src-tauri/src/main.rs", "tauri/src").is_some()
        );
        assert!(project_entry_match_score(
            "TitleBarQuickSearch.tsx",
            "src/components/TitleBarQuickSearch.tsx",
            "tbqs"
        )
        .is_some());
    }

    #[test]
    fn resolve_target_path_rejects_paths_outside_root() {
        let root = PathBuf::from("D:/demo");
        let result = resolve_target_path(&root, Some("D:/other"));

        assert!(result.is_err());
    }

    #[test]
    fn resolve_project_link_accepts_existing_chinese_file_and_directory() {
        let root = std::env::temp_dir().join(format!("termflow-link-{}", std::process::id()));
        let directory = root.join("资料");
        let file = directory.join("更新记录.md");
        fs::create_dir_all(&directory).unwrap();
        fs::write(&file, "content").unwrap();

        let file_target = resolve_project_link(display_path(&root), display_path(&file)).unwrap();
        let directory_target =
            resolve_project_link(display_path(&root), display_path(&directory)).unwrap();

        assert_eq!(file_target.path, display_path(&file));
        assert_eq!(file_target.kind, FileTreeEntryKind::File);
        assert_eq!(directory_target.path, display_path(&directory));
        assert_eq!(directory_target.kind, FileTreeEntryKind::Directory);

        fs::remove_file(file).unwrap();
        fs::remove_dir(directory).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn resolve_project_link_rejects_missing_or_outside_paths() {
        let root = std::env::temp_dir().join(format!("termflow-link-root-{}", std::process::id()));
        let outside =
            std::env::temp_dir().join(format!("termflow-link-outside-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();

        assert!(
            resolve_project_link(display_path(&root), display_path(&root.join("missing.md")))
                .is_err()
        );
        assert!(resolve_project_link(display_path(&root), display_path(&outside)).is_err());

        fs::remove_dir(outside).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn resolve_entry_path_rejects_root_path() {
        let root = PathBuf::from("D:/demo");
        let result = resolve_entry_path(&root, "D:/demo");

        assert!(result.is_err());
    }

    #[test]
    fn build_renamed_path_rejects_separator() {
        let path = PathBuf::from("D:/demo/src/main.rs");
        let result = build_renamed_path(&path, "nested/name");

        assert!(result.is_err());
    }

    #[test]
    fn validate_entry_name_rejects_illegal_characters() {
        let result = validate_entry_name("bad:name");

        assert!(result.is_err());
    }

    #[test]
    fn build_child_path_joins_parent_and_name() {
        let parent = PathBuf::from("D:/demo/src");
        let result = build_child_path(&parent, "main.ts").unwrap();

        assert_eq!(result, PathBuf::from("D:/demo/src/main.ts"));
    }

    #[test]
    fn pdf_detection_accepts_case_insensitive_extension_and_signature() {
        assert!(matches_pdf_extension(Path::new("manual.PDF")));
        assert!(matches_pdf_signature(b"%PDF-1.7\n"));
    }

    #[test]
    fn pdf_signature_rejects_non_pdf_content() {
        assert!(!matches_pdf_signature(b"not a pdf"));
        assert!(!matches_pdf_signature(b"%PD"));
    }

    #[test]
    fn office_preview_detection_is_case_insensitive_and_restricted() {
        assert!(is_previewable_office_file(Path::new("合同.DOCX")));
        assert!(is_previewable_office_file(Path::new("数据.xlsx")));
        assert!(is_previewable_office_file(Path::new("汇报.pptx")));
        assert!(!is_previewable_office_file(Path::new("archive.zip")));
        assert!(!is_previewable_office_file(Path::new("tool.exe")));
    }

    #[test]
    fn read_project_office_preview_returns_raw_bytes() {
        let directory =
            std::env::temp_dir().join(format!("termflow-office-read-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let document_path = directory.join("sample.docx");
        let expected = b"PK\x03\x04minimal ooxml fixture";
        fs::write(&document_path, expected).unwrap();

        let response =
            read_project_office_preview(display_path(&directory), display_path(&document_path))
                .unwrap();
        let body = response.body().unwrap();
        assert!(matches!(body, InvokeResponseBody::Raw(bytes) if bytes == expected));

        fs::remove_file(document_path).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn read_project_pdf_returns_an_optimized_raw_response() {
        let directory =
            std::env::temp_dir().join(format!("termflow-pdf-read-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let pdf_path = directory.join("sample.pdf");
        let expected = b"%PDF-1.7\nminimal test payload";
        fs::write(&pdf_path, expected).unwrap();

        let response = read_project_pdf(display_path(&directory), display_path(&pdf_path)).unwrap();
        let body = response.body().unwrap();
        assert!(matches!(body, InvokeResponseBody::Raw(bytes) if bytes == expected));

        fs::remove_file(pdf_path).unwrap();
        fs::remove_dir(directory).unwrap();
    }
}
