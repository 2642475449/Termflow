use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    pub old_path: Option<String>,
    pub status_type: String,
    pub staged: bool,
    pub insertions: Option<usize>,
    pub deletions: Option<usize>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchInfo {
    pub branch_name: String,
    pub ahead: usize,
    pub behind: usize,
    pub is_detached: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResult {
    pub file_path: String,
    pub diff_text: String,
    pub is_binary: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffContentResult {
    pub file_path: String,
    pub original_content: String,
    pub modified_content: String,
    pub is_binary: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_kind: Option<String>,
    pub original_label: String,
    pub modified_label: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResult {
    pub commit_oid: String,
    pub message: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoInfo {
    pub is_repo: bool,
    pub branch_info: Option<GitBranchInfo>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRemoteResult {
    pub success: bool,
    pub message: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitGraphRef {
    pub name: String,
    pub kind: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitGraphCommit {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
    pub author_name: String,
    pub author_email: String,
    pub timestamp_ms: i64,
    pub parent_oids: Vec<String>,
    pub refs: Vec<GitGraphRef>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitGraphChangedFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitGraphCommitDetail {
    pub oid: String,
    pub body: String,
    pub changed_files: usize,
    pub insertions: usize,
    pub deletions: usize,
    pub files: Vec<GitGraphChangedFile>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchListItem {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub header: String,
    pub lines: Vec<GitDiffLine>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffLine {
    pub origin: char,
    pub content: String,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffHunkResult {
    pub file_path: String,
    pub hunks: Vec<GitDiffHunk>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitConflictDetail {
    pub file_path: String,
    pub has_conflict: bool,
    pub ours_content: Option<String>,
    pub theirs_content: Option<String>,
    pub base_content: Option<String>,
    pub merged_content: Option<String>,
}
