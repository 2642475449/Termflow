use std::fmt;

/// Git 操作错误类型
#[derive(Debug)]
pub enum GitError {
    /// Git2 库错误
    Git2(git2::Error),
    /// IO 错误
    Io(std::io::Error),
    /// 自定义错误消息
    Custom(String),
}

impl fmt::Display for GitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GitError::Git2(err) => write!(f, "Git 错误: {}", err),
            GitError::Io(err) => write!(f, "IO 错误: {}", err),
            GitError::Custom(msg) => write!(f, "{}", msg),
        }
    }
}

impl std::error::Error for GitError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            GitError::Git2(err) => Some(err),
            GitError::Io(err) => Some(err),
            GitError::Custom(_) => None,
        }
    }
}

impl From<git2::Error> for GitError {
    fn from(err: git2::Error) -> Self {
        GitError::Git2(err)
    }
}

impl From<std::io::Error> for GitError {
    fn from(err: std::io::Error) -> Self {
        GitError::Io(err)
    }
}

impl From<String> for GitError {
    fn from(msg: String) -> Self {
        GitError::Custom(msg)
    }
}

impl From<&str> for GitError {
    fn from(msg: &str) -> Self {
        GitError::Custom(msg.to_string())
    }
}

/// 将 GitError 转换为 Tauri 命令返回的 String 错误
impl From<GitError> for String {
    fn from(err: GitError) -> Self {
        err.to_string()
    }
}
