use std::path::{Path, PathBuf};

const DEFAULT_QODER_CONFIG_DIR_NAME: &str = ".qoder-cn";
const DEFAULT_QODER_WORKSPACE_CONFIG_DIR_NAME: &str = ".qoder";

pub(crate) fn qoder_user_config_root() -> Result<PathBuf, String> {
    let home = dirs_next::home_dir().ok_or("Unable to resolve the user home directory")?;
    Ok(home.join(DEFAULT_QODER_CONFIG_DIR_NAME))
}

pub(crate) fn qoder_workspace_config_root(project_path: &Path) -> Result<PathBuf, String> {
    Ok(project_path.join(DEFAULT_QODER_WORKSPACE_CONFIG_DIR_NAME))
}

#[cfg(test)]
mod tests {
    use super::{qoder_workspace_config_root, DEFAULT_QODER_WORKSPACE_CONFIG_DIR_NAME};
    use std::path::Path;

    #[test]
    fn workspace_root_uses_qoder_directory() {
        assert_eq!(
            qoder_workspace_config_root(Path::new("project")).unwrap(),
            Path::new("project").join(DEFAULT_QODER_WORKSPACE_CONFIG_DIR_NAME),
        );
    }
}
