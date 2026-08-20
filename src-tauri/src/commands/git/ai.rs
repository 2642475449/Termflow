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
fn build_commit_prompt(
    project_path: &str,
    repo: &git2::Repository,
    profile_instructions: &str,
) -> Result<String, String> {
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
    let staged_diff = run_git_text_command(
        project_path,
        &["diff", "--cached", "--no-ext-diff", "--unified=3"],
    )?;
    let unstaged_diff =
        run_git_text_command(project_path, &["diff", "--no-ext-diff", "--unified=3"])?;

    if status_text.trim().is_empty() {
        return Err("当前没有可用于生成提交信息的 Git 变更".to_string());
    }

    let profile_instructions = profile_instructions.trim();
    if profile_instructions.is_empty() {
        return Err("提交信息风格的生成规则不能为空".to_string());
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
        "你是一个资深 Git 提交信息助手。请根据下面仓库的改动生成一条可以直接使用的提交信息。\n\
        固定要求（优先级高于风格规则）：\n\
        1. 只输出最终提交信息，不要解释，不要代码块，不要额外前后缀\n\
        2. 不要编造变更概览中无法确认的功能、Issue 编号或测试结果\n\
        3. 优先概括源码和配置改动，弱化或忽略构建产物、二进制、bundle 等派生产物\n\
        4. 正文要点必须基于提供的文件路径和 diff，写明“哪里改了什么”。只有 diff 能直接证实时才说明用户行为、兼容性或性能影响；否则陈述可验证的实现事实\n\
        5. 按独立改动主题组织正文，不要为了凑条目拆分同一项改动，也不要机械罗列每个文件\n\
        6. 不要只写“优化”“调整”“重构”等空泛描述；不要声称测试已通过，除非输入明确提供了测试运行结果\n\
        7. 输入的 diff 可能因长度限制而截断；只描述能从输入确认的改动，不要臆测\n\n\
        当前选择的风格规则：\n{profile_instructions}\n\n\
        当前分支：\n{branch_name}\n\n\
        Git Status:\n{status}\n\n\
        Staged Summary:\n{staged}\n\n\
        Unstaged Summary:\n{unstaged}\n\n\
        Staged Diff:\n{staged_diff}\n\n\
        Unstaged Diff:\n{unstaged_diff}",
        branch_name = branch_name,
        profile_instructions = truncate_block(profile_instructions, 6000),
        status = truncate_block(&status_text, 4000),
        staged = truncate_block(&staged_summary, 4000),
        unstaged = truncate_block(&unstaged_summary, 4000),
        staged_diff = truncate_block(&staged_diff, 12000),
        unstaged_diff = truncate_block(&unstaged_diff, 12000),
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
    profile_instructions: String,
) -> Result<String, String> {
    let repo = open_repo(&project_path)?;
    let prompt = build_commit_prompt(&project_path, &repo, &profile_instructions)?;
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
    profile_instructions: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_generate_commit_message_sync(project_path, agent_id, profile_instructions)
    })
    .await
    .map_err(|e| format!("AI 提交信息后台任务失败: {}", e))?
}
