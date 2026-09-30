use super::utils::{open_repo, run_git_write};
use std::fs;
use std::path::Path;

/// 将工作树中的单个路径写入仓库根目录的 .gitignore。
#[tauri::command]
pub async fn git_add_to_gitignore(project_path: String, file_path: String) -> Result<bool, String> {
    let lock_path = project_path.clone();
    run_git_write(lock_path, "更新 .gitignore", move || {
        git_add_to_gitignore_sync(&project_path, &file_path)
    })
    .await
}

fn ignore_pattern(file_path: &str) -> Result<String, String> {
    let normalized = file_path.replace('\\', "/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.chars().any(|c| c.is_control() || c == ':')
        || normalized
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == ".." || part == ".git")
    {
        return Err("无效的 Git 文件路径".to_string());
    }

    let mut pattern = String::from("/");
    for ch in normalized.chars() {
        if matches!(ch, '*' | '?' | '[' | ']' | '\\' | ' ') {
            pattern.push('\\');
        }
        pattern.push(ch);
    }
    Ok(pattern)
}

fn git_add_to_gitignore_sync(project_path: &str, file_path: &str) -> Result<bool, String> {
    let pattern = ignore_pattern(file_path)?;
    let repo = open_repo(project_path)?;
    let root = repo
        .workdir()
        .ok_or_else(|| "裸仓库没有 .gitignore 工作目录".to_string())?;
    let tracked = repo
        .index()
        .map_err(|e| format!("读取 Git 索引失败: {e}"))?
        .get_path(Path::new(file_path), 0)
        .is_some();
    let ignore_file = root.join(".gitignore");
    let mut content = match fs::read_to_string(&ignore_file) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("读取 .gitignore 失败: {error}")),
    };
    if content.lines().any(|line| line.trim_end_matches('\r') == pattern) {
        return Ok(tracked);
    }

    let newline = if content.contains("\r\n") { "\r\n" } else { "\n" };
    if !content.is_empty() && !content.ends_with('\n') {
        content.push_str(newline);
    }
    content.push_str(&pattern);
    content.push_str(newline);
    fs::write(&ignore_file, content).map_err(|e| format!("写入 .gitignore 失败: {e}"))?;
    Ok(tracked)
}

#[cfg(test)]
mod tests {
    use super::{git_add_to_gitignore_sync, ignore_pattern};
    use git2::Repository;
    use std::fs;
    use std::path::Path;

    #[test]
    fn writes_root_anchored_rule_once_and_preserves_existing_content() {
        let fixture = tempfile::TempDir::new().unwrap();
        let repo = Repository::init(fixture.path()).unwrap();
        fs::write(fixture.path().join(".gitignore"), "node_modules/\r\n").unwrap();
        fs::create_dir_all(fixture.path().join("config")).unwrap();
        fs::write(fixture.path().join("config/application.yml"), "local").unwrap();
        let root = fixture.path().to_str().unwrap();
        assert!(!git_add_to_gitignore_sync(root, "config/application.yml").unwrap());
        assert!(!git_add_to_gitignore_sync(root, "config/application.yml").unwrap());
        assert_eq!(
            fs::read_to_string(fixture.path().join(".gitignore")).unwrap(),
            "node_modules/\r\n/config/application.yml\r\n"
        );
        assert!(repo
            .status_file(Path::new("config/application.yml"))
            .unwrap()
            .contains(git2::Status::IGNORED));
    }

    #[test]
    fn rejects_escape_paths_and_escapes_gitignore_metacharacters() {
        assert!(ignore_pattern("../outside.txt").is_err());
        assert!(ignore_pattern("C:\\outside.txt").is_err());
        assert!(ignore_pattern(".git/config").is_err());
        assert_eq!(ignore_pattern("a/[draft] *.txt").unwrap(), "/a/\\[draft\\]\\ \\*.txt");
    }

    #[test]
    fn reports_files_already_in_the_index_without_untracking_them() {
        let fixture = tempfile::TempDir::new().unwrap();
        let repo = Repository::init(fixture.path()).unwrap();
        fs::write(fixture.path().join("tracked.txt"), "keep").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("tracked.txt")).unwrap();
        index.write().unwrap();
        assert!(git_add_to_gitignore_sync(fixture.path().to_str().unwrap(), "tracked.txt").unwrap());
        assert!(repo.index().unwrap().get_path(Path::new("tracked.txt"), 0).is_some());
    }
}
