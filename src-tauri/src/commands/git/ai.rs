use crate::commands::agent_runner::{run_agent_text, AgentTextRunOptions};
use crate::path_utils::normalize_input_path;
use std::time::Duration;

use super::status::resolve_branch_info;
use super::utils::{open_repo, run_git_text_command};

/// AI 提交信息生成超时时间
const AI_COMMIT_TIMEOUT: Duration = Duration::from_secs(90);
const AI_COMMIT_CLAUDE_MAX_TURNS: u8 = 8;

#[cfg(test)]
#[test]
fn commit_message_generation_allows_eight_claude_turns_with_a_ninety_second_timeout() {
    assert_eq!(AI_COMMIT_CLAUDE_MAX_TURNS, 8);
    assert_eq!(AI_COMMIT_TIMEOUT, Duration::from_secs(90));
}

/// Build a provider-neutral prompt for generating a commit message.
fn build_commit_prompt(project_path: &str, repo: &git2::Repository) -> Result<String, String> {
    let branch_name = resolve_branch_info(repo)
        .map(|info| info.branch_name)
        .unwrap_or_else(|_| "HEAD".to_string());
    let status_text = run_git_text_command(project_path, &["status", "--short"])?;
    let staged_summary = run_git_text_command(
        project_path,
        &[
            "diff",
            "--cached",
            "--no-ext-diff",
            "--stat=160,120",
            "--summary",
        ],
    )?;
    let unstaged_summary = run_git_text_command(
        project_path,
        &["diff", "--no-ext-diff", "--stat=160,120", "--summary"],
    )?;

    if status_text.trim().is_empty() {
        return Err("当前没有可用于生成提交信息的 Git 变更".to_string());
    }

    let truncate_block = |text: &str, limit: usize| -> String {
        let trimmed = text.trim();
        if trimmed.chars().count() <= limit {
            trimmed.to_string()
        } else {
            let truncated: String = trimmed.chars().take(limit).collect();
            format!("{}\n...[truncated]", truncated)
        }
    };

    Ok(format!(
        "你是一个资深 Git 提交信息助手。请根据下面仓库的改动生成一条可以直接使用的完整提交信息。\n\
        要求：\n\
        1. 默认输出完整提交信息，而不是只输出标题\n\
        2. 第一行必须是 Conventional Commit 风格标题，格式尽量为 type(scope): summary\n\
        3. 标题简洁、准确、可读，尽量控制在 50 个字符以内\n\
        4. 标题后空一行，再输出 2-4 条正文要点\n\
        5. 正文每行使用 `- ` 开头，概括本次改动的关键点、结构变化或交互变化\n\
        6. 只输出最终提交信息，不要解释，不要代码块，不要额外前后缀\n\
        7. 默认使用中文，但如果改动明显是英文语境或英文约定，可输出英文\n\
        8. 优先概括源码和配置改动，弱化或忽略构建产物、二进制、bundle 等派生产物\n\
        9. 如果同时存在多类改动，提炼最主要的 2-4 个点，不要把所有文件逐一罗列\n\
        10. 输入中提供的是 Git 变更概览而非完整 patch，请优先根据文件分布、变更统计和状态信息概括提交意图\n\n\
        输出格式示例：\n\
        feat(git, sidebar): 添加 AI 生成提交信息功能\n\n\
        - 新增后端命令，调用默认智能体生成完整提交信息\n\
        - 在 Git 提交输入框加入 AI 生成入口与加载状态\n\
        - 优化侧边栏 Git 变更交互与右键操作\n\n\
        当前分支：\n{branch_name}\n\n\
        Git Status:\n{status}\n\n\
        Staged Summary:\n{staged}\n\n\
        Unstaged Summary:\n{unstaged}",
        branch_name = branch_name,
        status = truncate_block(&status_text, 4000),
        staged = truncate_block(&staged_summary, 4000),
        unstaged = truncate_block(&unstaged_summary, 4000),
    ))
}

/// Sanitize generated commit message.
fn sanitize_generated_commit_message(input: &str) -> Option<String> {
    let normalized = input.replace("\r\n", "\n");
    let trimmed = normalized
        .trim()
        .trim_matches(|c: char| c == '"' || c == '\'' || c == '`');
    if trimmed.is_empty() {
        return None;
    }

    let mut lines = Vec::new();
    let mut previous_blank = false;

    for raw_line in trimmed.lines() {
        let line = raw_line
            .trim()
            .trim_matches(|c: char| c == '"' || c == '\'' || c == '`');
        if line.is_empty() {
            if !lines.is_empty() && !previous_blank {
                lines.push(String::new());
            }
            previous_blank = true;
            continue;
        }

        if line.starts_with("```") {
            continue;
        }

        lines.push(line.to_string());
        previous_blank = false;
    }

    while matches!(lines.last(), Some(line) if line.is_empty()) {
        lines.pop();
    }

    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    }
}

/// Generate commit message using the explicitly selected agent (synchronous).
fn git_generate_commit_message_sync(
    project_path: String,
    agent_id: String,
) -> Result<String, String> {
    let repo = open_repo(&project_path)?;
    let prompt = build_commit_prompt(&project_path, &repo)?;
    let normalized_path = normalize_input_path(&project_path);
    let stdout = run_agent_text(
        &agent_id,
        &prompt,
        normalized_path.to_string_lossy().as_ref(),
        AI_COMMIT_TIMEOUT,
        AgentTextRunOptions {
            claude_max_turns: Some(AI_COMMIT_CLAUDE_MAX_TURNS),
        },
    )?;
    sanitize_generated_commit_message(&stdout)
        .ok_or_else(|| "智能体未返回有效的提交信息".to_string())
}

/// Generate commit message using the explicitly selected agent (async).
#[tauri::command]
pub async fn git_generate_commit_message(
    project_path: String,
    agent_id: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_generate_commit_message_sync(project_path, agent_id)
    })
    .await
    .map_err(|e| format!("AI 提交信息后台任务失败: {}", e))?
}
