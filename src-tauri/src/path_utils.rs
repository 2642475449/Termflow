use std::fs;
use std::path::{Path, PathBuf};

pub fn normalize_input_path(path: &str) -> PathBuf {
    fs::canonicalize(path)
        .map(normalize_path_buf)
        .unwrap_or_else(|_| PathBuf::from(normalize_windows_verbatim_path(path.to_string())))
}

pub fn display_path(path: impl AsRef<Path>) -> String {
    normalize_windows_verbatim_path(path.as_ref().to_string_lossy().to_string())
}

pub fn normalize_path_buf(path: PathBuf) -> PathBuf {
    PathBuf::from(normalize_windows_verbatim_path(
        path.to_string_lossy().to_string(),
    ))
}

#[cfg(target_os = "windows")]
pub fn normalize_windows_verbatim_path(path: String) -> String {
    if let Some(stripped) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", stripped)
    } else if let Some(stripped) = path.strip_prefix(r"\\?\") {
        stripped.to_string()
    } else {
        path
    }
}

#[cfg(not(target_os = "windows"))]
pub fn normalize_windows_verbatim_path(path: String) -> String {
    path
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[cfg(target_os = "windows")]
    #[test]
    fn strips_windows_verbatim_drive_prefix() {
        assert_eq!(
            normalize_windows_verbatim_path(r"\\?\D:\3.project\termflow".to_string()),
            r"D:\3.project\termflow"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn strips_windows_unc_verbatim_prefix() {
        assert_eq!(
            normalize_windows_verbatim_path(r"\\?\UNC\server\share\folder".to_string()),
            r"\\server\share\folder"
        );
    }

    #[test]
    fn keeps_normal_display_path_unchanged() {
        let path = PathBuf::from("D:\\3.project\\termflow");
        assert_eq!(display_path(&path), path.to_string_lossy());
    }

    #[test]
    fn normalize_input_path_returns_original_for_missing_path() {
        let missing = "definitely-missing-path-for-tests";
        assert_eq!(normalize_input_path(missing), PathBuf::from(missing));
    }
}
