use crate::path_utils::{display_path, normalize_input_path};
use crate::qoder_config::{qoder_user_config_root, qoder_workspace_config_root};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Hash, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum SkillScope {
    Workspace,
    User,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum SkillAgent {
    Claude,
    Codex,
    Qoder,
    Antigravity,
    Opencode,
    Pi,
}

impl SkillAgent {
    const ALL: [Self; 6] = [
        Self::Claude,
        Self::Codex,
        Self::Qoder,
        Self::Antigravity,
        Self::Opencode,
        Self::Pi,
    ];

    fn key(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Qoder => "qoder",
            Self::Antigravity => "antigravity",
            Self::Opencode => "opencode",
            Self::Pi => "pi",
        }
    }

    fn effective_agents(self, scope: SkillScope) -> Vec<Self> {
        match (self, scope) {
            (Self::Claude, _) => vec![Self::Claude, Self::Opencode],
            (Self::Codex, SkillScope::Workspace)
            | (Self::Antigravity, SkillScope::Workspace)
            | (Self::Pi, SkillScope::Workspace) => {
                vec![Self::Codex, Self::Antigravity, Self::Opencode, Self::Pi]
            }
            (Self::Codex, SkillScope::User) | (Self::Pi, SkillScope::User) => {
                vec![Self::Codex, Self::Opencode, Self::Pi]
            }
            (Self::Qoder, _) => vec![Self::Qoder],
            (Self::Antigravity, SkillScope::User) => vec![Self::Antigravity],
            (Self::Opencode, _) => vec![Self::Opencode],
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub scope: SkillScope,
    pub agent: SkillAgent,
    pub effective_agents: Vec<SkillAgent>,
    pub conflict_status: SkillConflictStatus,
    pub conflict_agents: Vec<SkillAgent>,
    pub conflicting_paths: Vec<String>,
    pub content_fingerprint: String,
    pub folder_name: String,
    pub file_path: String,
    pub resolved_file_path: String,
    pub entry_is_link: bool,
    pub source_dir: String,
    pub updated_at: Option<i64>,
}

#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SkillConflictStatus {
    #[default]
    None,
    IdenticalCopy,
    DivergedCopy,
    RuntimeConflict,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SkillRootInfo {
    pub agent: SkillAgent,
    pub scope: SkillScope,
    pub enabled_dir: Option<String>,
    pub disabled_dir: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCatalog {
    pub skills: Vec<SkillInfo>,
    pub roots: Vec<SkillRootInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    pub skill: SkillInfo,
    pub content: String,
}

fn parse_skill_frontmatter(content: &str) -> (String, String) {
    let mut name = String::new();
    let mut description = String::new();
    if !content.starts_with("---") {
        return (name, description);
    }

    let Some(end_offset) = content[3..].find("\n---") else {
        return (name, description);
    };
    let frontmatter = &content[4..end_offset + 3];
    let lines = frontmatter.lines().collect::<Vec<_>>();
    let mut index = 0;
    while index < lines.len() {
        let trimmed = lines[index].trim();
        if let Some(value) = trimmed.strip_prefix("name:") {
            name = value
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_string();
        } else if let Some(value) = trimmed.strip_prefix("description:") {
            let value = value.trim();
            if matches!(value, "|" | ">" | "|-" | ">-") || value.is_empty() {
                let mut block = Vec::new();
                index += 1;
                while index < lines.len() {
                    let next = lines[index];
                    if next.starts_with(' ') || next.starts_with('\t') || next.trim().is_empty() {
                        if !next.trim().is_empty() {
                            block.push(next.trim().to_string());
                        }
                        index += 1;
                        continue;
                    }
                    index -= 1;
                    break;
                }
                description = block.join("\n");
            } else {
                description = value.trim_matches('"').trim_matches('\'').to_string();
            }
        }
        index += 1;
    }
    (name, description)
}

#[tauri::command]
pub fn list_skills(project_path: Option<String>) -> Result<SkillCatalog, String> {
    let mut skills = Vec::new();
    let mut root_infos = Vec::new();

    for agent in SkillAgent::ALL {
        for scope in [SkillScope::Workspace, SkillScope::User] {
            let roots = resolve_skill_roots(agent, scope, project_path.as_deref())?;
            // Codex, Antigravity, and Pi natively consume workspace .agents/skills.
            // Scan that physical root once and expose every consumer through
            // effective_agents so the same Skill is never shown as a conflict
            // with itself.
            let shares_canonical_agents_root = (agent == SkillAgent::Antigravity
                && scope == SkillScope::Workspace)
                || agent == SkillAgent::Pi;
            if !shares_canonical_agents_root {
                skills.extend(scan_scope_skills(agent, scope, &roots.enabled_dir, true)?);
                skills.extend(scan_scope_skills(agent, scope, &roots.disabled_dir, false)?);
            }
            root_infos.push(SkillRootInfo {
                agent,
                scope,
                enabled_dir: roots.enabled_dir.as_ref().map(|path| display_path(path)),
                disabled_dir: roots.disabled_dir.as_ref().map(|path| display_path(path)),
            });
        }
    }

    classify_skill_conflicts(&mut skills);
    skills.sort_by(|a, b| {
        a.scope
            .cmp(&b.scope)
            .then_with(|| a.agent.cmp(&b.agent))
            .then_with(|| b.enabled.cmp(&a.enabled))
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(SkillCatalog {
        skills,
        roots: root_infos,
    })
}

#[tauri::command]
pub fn get_skill_detail(
    agent: SkillAgent,
    scope: SkillScope,
    folder_name: String,
    enabled: bool,
    project_path: Option<String>,
) -> Result<SkillDetail, String> {
    let skill_dir =
        resolve_skill_dir(agent, scope, project_path.as_deref(), &folder_name, enabled)?;
    let skill_md = skill_dir.join("SKILL.md");
    if !skill_md.exists() {
        return Err(format!("Skill '{}' does not exist", folder_name));
    }
    let content = fs::read_to_string(&skill_md).map_err(|error| error.to_string())?;
    let skill = build_skill_info(agent, scope, enabled, &skill_dir, &content)?;
    Ok(SkillDetail { skill, content })
}

#[tauri::command]
pub fn set_skill_enabled(
    agent: SkillAgent,
    scope: SkillScope,
    folder_name: String,
    enabled: bool,
    next_enabled: bool,
    project_path: Option<String>,
) -> Result<SkillInfo, String> {
    if enabled == next_enabled {
        let skill_dir =
            resolve_skill_dir(agent, scope, project_path.as_deref(), &folder_name, enabled)?;
        let content =
            fs::read_to_string(skill_dir.join("SKILL.md")).map_err(|error| error.to_string())?;
        return build_skill_info(agent, scope, enabled, &skill_dir, &content);
    }

    let source_dir =
        resolve_skill_dir(agent, scope, project_path.as_deref(), &folder_name, enabled)?;
    if !source_dir.exists() {
        return Err(format!("Skill '{}' does not exist", folder_name));
    }
    // 保护真实源目录：禁用只移动入口，不能破坏其他智能体已建立的链接。
    let source_file = source_dir.join("SKILL.md");
    let resolved = fs::canonicalize(&source_file).map_err(|error| error.to_string())?;
    let source_display = display_path(&source_file);
    if !fs::symlink_metadata(&source_dir)
        .map_err(|error| error.to_string())?
        .file_type()
        .is_symlink()
    {
        let catalog = list_skills(project_path.clone())?;
        if catalog.skills.iter().any(|skill| {
            skill.file_path != source_display && skill.resolved_file_path == display_path(&resolved)
        }) {
            return Err(
                "Other skill entries link to this source; manage those entries first".into(),
            );
        }
    }
    let roots = resolve_skill_roots(agent, scope, project_path.as_deref())?;
    let target_root = if next_enabled {
        roots.enabled_dir
    } else {
        roots.disabled_dir
    }
    .ok_or_else(|| "No skill directory is available for the current scope".to_string())?;
    fs::create_dir_all(&target_root).map_err(|error| error.to_string())?;
    let target_dir = target_root.join(&folder_name);
    if fs::symlink_metadata(&target_dir).is_ok() {
        return Err(format!(
            "Target directory '{}' already exists",
            target_dir.display()
        ));
    }
    fs::rename(&source_dir, &target_dir).map_err(|error| error.to_string())?;
    let content =
        fs::read_to_string(target_dir.join("SKILL.md")).map_err(|error| error.to_string())?;
    build_skill_info(agent, scope, next_enabled, &target_dir, &content)
}

#[tauri::command]
pub fn create_skill(
    agent: SkillAgent,
    scope: SkillScope,
    name: String,
    description: Option<String>,
    project_path: Option<String>,
) -> Result<SkillInfo, String> {
    let display_name = name.trim();
    if display_name.is_empty() {
        return Err("Skill name cannot be empty".to_string());
    }

    let folder_name = slugify_folder_name(display_name);
    let roots = resolve_skill_roots(agent, scope, project_path.as_deref())?;
    let enabled_dir = roots
        .enabled_dir
        .ok_or_else(|| "No skill directory is available for the current scope".to_string())?;
    fs::create_dir_all(&enabled_dir).map_err(|error| error.to_string())?;
    let skill_dir = enabled_dir.join(&folder_name);
    if skill_dir.exists() {
        return Err(format!("Skill '{}' already exists", folder_name));
    }
    fs::create_dir_all(&skill_dir).map_err(|error| error.to_string())?;

    let description = description
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            "Describe when this skill should be used and what it accomplishes.".to_string()
        });
    let content = format!(
        "---\nname: {}\ndescription: |\n  {}\n---\n\n# {}\n\n## Purpose\n\n- Describe what this skill does.\n\n## When to use\n\n- Describe the situations that should trigger this skill.\n\n## Instructions\n\n- Add the workflow and constraints here.\n",
        folder_name,
        description.trim().replace('\n', "\n  "),
        display_name
    );
    fs::write(skill_dir.join("SKILL.md"), content.as_bytes()).map_err(|error| error.to_string())?;
    build_skill_info(agent, scope, true, &skill_dir, &content)
}

#[tauri::command]
pub fn ensure_skill_directory(
    agent: SkillAgent,
    scope: SkillScope,
    enabled: bool,
    project_path: Option<String>,
) -> Result<String, String> {
    let roots = resolve_skill_roots(agent, scope, project_path.as_deref())?;
    let directory = if enabled {
        roots.enabled_dir
    } else {
        roots.disabled_dir
    }
    .ok_or_else(|| "No skill directory is available for the current scope".to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(display_path(&directory))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallRequest {
    pub agents: Vec<SkillAgent>,
    pub scope: SkillScope,
    pub name: String,
    pub description: String,
    pub source_directory: Option<String>,
    pub project_path: Option<String>,
}

// 只写入选定的原生目录；共享目录只写一次，其他目录为明确标注的独立副本。
#[tauri::command]
pub fn install_skill(request: SkillInstallRequest) -> Result<Vec<SkillInfo>, String> {
    if request.agents.is_empty() {
        return Err("Select at least one agent".into());
    }
    let source = request
        .source_directory
        .as_deref()
        .map(normalize_input_path);
    let folder = if let Some(source) = &source {
        if !source.join("SKILL.md").is_file() {
            return Err("Select a skill directory containing SKILL.md".into());
        }
        source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Invalid source directory")?
            .to_string()
    } else {
        if request.name.trim().is_empty() {
            return Err("Skill name cannot be empty".into());
        }
        slugify_folder_name(request.name.trim())
    };
    validate_folder_name(&folder)?;
    let mut targets = Vec::new();
    for agent in request.agents {
        let root = resolve_skill_roots(agent, request.scope, request.project_path.as_deref())?
            .enabled_dir
            .ok_or("No skill directory is available for the current scope")?;
        if !targets
            .iter()
            .any(|(_, existing): &(SkillAgent, PathBuf)| *existing == root)
        {
            targets.push((agent, root));
        }
    }
    // 在任何写入前检查所有目标，避免重复安装造成半完成结果。
    for (_, root) in &targets {
        if let Some(source) = &source {
            // 解析最近的真实父目录，防止目标位于导入源内部造成递归复制。
            let mut existing = root.as_path();
            while !existing.exists() {
                existing = existing.parent().ok_or("Invalid target directory")?;
            }
            if normalize_input_path(&display_path(existing)).starts_with(source) {
                return Err("Import destination cannot be inside the source directory".into());
            }
        }
        if fs::symlink_metadata(root.join(&folder)).is_ok() {
            return Err(format!(
                "Target already exists: {}",
                root.join(&folder).display()
            ));
        }
    }
    let description = if request.description.trim().is_empty() {
        "Describe when this skill should be used and what it accomplishes."
    } else {
        request.description.trim()
    };
    let content = format!("---\nname: {}\ndescription: {}\n---\n\n# {}\n\n## Instructions\n\n- Add the workflow and constraints here.\n",
        folder, serde_json::to_string(description).map_err(|error| error.to_string())?, request.name.trim());
    let mut written = Vec::new();
    let result = (|| {
        for (agent, root) in &targets {
            fs::create_dir_all(root).map_err(|error| error.to_string())?;
            let target = root.join(&folder);
            fs::create_dir(&target).map_err(|error| error.to_string())?;
            written.push(target.clone());
            if let Some(source) = &source {
                copy_skill_files(source, &target, 0)?;
            } else {
                fs::write(target.join("SKILL.md"), &content).map_err(|error| error.to_string())?;
            }
            let content =
                fs::read_to_string(target.join("SKILL.md")).map_err(|error| error.to_string())?;
            // 在返回前验证目录可被技能扫描器完整读取。
            build_skill_info(*agent, request.scope, true, &target, &content)?;
        }
        targets
            .iter()
            .map(|(agent, root)| {
                let target = root.join(&folder);
                let content = fs::read_to_string(target.join("SKILL.md"))
                    .map_err(|error| error.to_string())?;
                build_skill_info(*agent, request.scope, true, &target, &content)
            })
            .collect::<Result<Vec<_>, String>>()
    })();
    if result.is_err() {
        // written 只含本次 create_dir 成功新建的目录，绝不删除预先存在的用户技能。
        for path in written.into_iter().rev() {
            if let Err(error) = fs::remove_dir_all(&path) {
                return Err(format!(
                    "{}; rollback failed for {}: {}",
                    result.err().unwrap_or_default(),
                    path.display(),
                    error
                ));
            }
        }
    }
    result
}

fn copy_skill_files(source: &Path, target: &Path, depth: usize) -> Result<(), String> {
    if depth > 32 {
        return Err("Skill directory is nested too deeply".into());
    }
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        if matches!(
            entry.file_name().to_str(),
            Some(".git" | "node_modules" | "target" | "__pycache__")
        ) {
            continue;
        }
        if kind.is_symlink() {
            return Err(format!(
                "Import does not follow resource symlinks: {}",
                path.display()
            ));
        }
        let destination = target.join(entry.file_name());
        if kind.is_dir() {
            fs::create_dir(&destination).map_err(|error| error.to_string())?;
            copy_skill_files(&path, &destination, depth + 1)?;
        } else if kind.is_file() {
            fs::copy(&path, &destination).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[derive(Clone, Debug)]
struct SkillRoots {
    enabled_dir: Option<PathBuf>,
    disabled_dir: Option<PathBuf>,
}

fn scan_scope_skills(
    agent: SkillAgent,
    scope: SkillScope,
    root: &Option<PathBuf>,
    enabled: bool,
) -> Result<Vec<SkillInfo>, String> {
    let Some(root) = root else {
        return Ok(Vec::new());
    };
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut skills = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if !path.is_dir() || !path.join("SKILL.md").exists() {
            continue;
        }
        let content =
            fs::read_to_string(path.join("SKILL.md")).map_err(|error| error.to_string())?;
        skills.push(build_skill_info(agent, scope, enabled, &path, &content)?);
    }
    Ok(skills)
}

fn build_skill_info(
    agent: SkillAgent,
    scope: SkillScope,
    enabled: bool,
    skill_dir: &Path,
    content: &str,
) -> Result<SkillInfo, String> {
    let (name, description) = parse_skill_frontmatter(content);
    let folder_name = skill_dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Invalid skill directory name".to_string())?
        .to_string();
    let display_name = if name.is_empty() {
        folder_name.clone()
    } else {
        name
    };
    let source_dir = skill_dir.parent().map(display_path).unwrap_or_default();
    let updated_at = fs::metadata(skill_dir.join("SKILL.md"))
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64);

    Ok(SkillInfo {
        id: format!("{}:{}:{}", agent.key(), scope_key(scope), folder_name),
        name: display_name,
        description,
        enabled,
        scope,
        agent,
        effective_agents: agent.effective_agents(scope),
        conflict_status: SkillConflictStatus::None,
        conflict_agents: Vec::new(),
        conflicting_paths: Vec::new(),
        content_fingerprint: fingerprint_skill_directory(skill_dir)?,
        folder_name,
        file_path: display_path(&skill_dir.join("SKILL.md")),
        resolved_file_path: display_path(
            &fs::canonicalize(skill_dir.join("SKILL.md")).map_err(|error| error.to_string())?,
        ),
        entry_is_link: fs::symlink_metadata(skill_dir)
            .map_err(|error| error.to_string())?
            .file_type()
            .is_symlink(),
        source_dir,
        updated_at,
    })
}

fn fingerprint_skill_directory(skill_dir: &Path) -> Result<String, String> {
    fn collect_files(directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
        for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
            let path = entry.map_err(|error| error.to_string())?.path();
            // 不递归跟随资源目录内的链接，避免循环和越界读取。
            if fs::symlink_metadata(&path)
                .map_err(|error| error.to_string())?
                .file_type()
                .is_symlink()
            {
                files.push(path);
                continue;
            }
            if path.is_dir() {
                let ignored = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        matches!(name, ".git" | "node_modules" | "target" | "__pycache__")
                    });
                if ignored {
                    continue;
                }
                collect_files(&path, files)?;
            } else if path.is_file() {
                if path.file_name().and_then(|name| name.to_str()) == Some(".DS_Store") {
                    continue;
                }
                files.push(path);
            }
        }
        Ok(())
    }

    let mut files = Vec::new();
    collect_files(skill_dir, &mut files)?;
    files.sort_by(|left, right| {
        left.strip_prefix(skill_dir)
            .unwrap_or(left)
            .cmp(right.strip_prefix(skill_dir).unwrap_or(right))
    });

    let mut digest = Sha256::new();
    for path in files {
        let relative = path
            .strip_prefix(skill_dir)
            .map_err(|error| error.to_string())?;
        digest.update(relative.to_string_lossy().replace('\\', "/").as_bytes());
        digest.update([0]);
        if fs::symlink_metadata(&path)
            .map_err(|error| error.to_string())?
            .file_type()
            .is_symlink()
        {
            digest.update(b"symlink\0");
            digest.update(
                fs::read_link(&path)
                    .map_err(|error| error.to_string())?
                    .to_string_lossy()
                    .as_bytes(),
            );
        } else {
            digest.update(fs::read(&path).map_err(|error| error.to_string())?);
        }
        digest.update([0]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn classify_skill_conflicts(skills: &mut [SkillInfo]) {
    let mut groups: HashMap<(SkillScope, String), Vec<usize>> = HashMap::new();
    for (index, skill) in skills.iter().enumerate() {
        groups
            .entry((skill.scope, skill.name.to_lowercase()))
            .or_default()
            .push(index);
    }

    for indexes in groups.into_values().filter(|indexes| indexes.len() > 1) {
        if indexes
            .iter()
            .all(|index| skills[*index].resolved_file_path == skills[indexes[0]].resolved_file_path)
        {
            continue;
        }
        let paths = indexes
            .iter()
            .map(|index| skills[*index].file_path.clone())
            .collect::<Vec<_>>();
        let identical = indexes.iter().skip(1).all(|index| {
            skills[*index].content_fingerprint == skills[indexes[0]].content_fingerprint
        });
        let mut affected_agents = Vec::new();
        if !identical {
            for (offset, left_index) in indexes.iter().enumerate() {
                for right_index in indexes.iter().skip(offset + 1) {
                    let left = &skills[*left_index];
                    let right = &skills[*right_index];
                    if !left.enabled
                        || !right.enabled
                        || left.content_fingerprint == right.content_fingerprint
                    {
                        continue;
                    }
                    for agent in left
                        .effective_agents
                        .iter()
                        .filter(|agent| right.effective_agents.contains(agent))
                    {
                        if !affected_agents.contains(agent) {
                            affected_agents.push(*agent);
                        }
                    }
                }
            }
            affected_agents.sort();
        }
        let status = if identical {
            SkillConflictStatus::IdenticalCopy
        } else if affected_agents.is_empty() {
            SkillConflictStatus::DivergedCopy
        } else {
            SkillConflictStatus::RuntimeConflict
        };
        for index in indexes {
            skills[index].conflict_status = status;
            skills[index].conflict_agents = affected_agents.clone();
            skills[index].conflicting_paths = paths.clone();
        }
    }
}

fn resolve_skill_roots(
    agent: SkillAgent,
    scope: SkillScope,
    project_path: Option<&str>,
) -> Result<SkillRoots, String> {
    let base = match scope {
        SkillScope::Workspace => {
            let Some(project_path) = project_path.filter(|path| !path.trim().is_empty()) else {
                return Ok(SkillRoots {
                    enabled_dir: None,
                    disabled_dir: None,
                });
            };
            let project_path = normalize_input_path(project_path);
            if agent == SkillAgent::Qoder {
                qoder_workspace_config_root(&project_path)?
            } else {
                project_path.join(agent_workspace_directory(agent))
            }
        }
        SkillScope::User => agent_user_directory(agent)?,
    };
    Ok(SkillRoots {
        enabled_dir: Some(base.join("skills")),
        disabled_dir: Some(base.join("skills-disabled")),
    })
}

fn agent_workspace_directory(agent: SkillAgent) -> &'static str {
    match agent {
        SkillAgent::Claude => ".claude",
        SkillAgent::Codex => ".agents",
        SkillAgent::Qoder => ".qoder",
        SkillAgent::Antigravity => ".agents",
        SkillAgent::Opencode => ".opencode",
        SkillAgent::Pi => ".agents",
    }
}

fn agent_user_directory(agent: SkillAgent) -> Result<PathBuf, String> {
    let home = dirs_next::home_dir().ok_or("Unable to resolve the user home directory")?;
    Ok(match agent {
        SkillAgent::Claude => crate::agent_paths::user_path(crate::agent_paths::AgentPath::Claude)?,
        SkillAgent::Codex => home.join(".agents"),
        SkillAgent::Qoder => qoder_user_config_root()?,
        SkillAgent::Antigravity => home.join(".gemini").join("config"),
        SkillAgent::Pi => home.join(".agents"),
        SkillAgent::Opencode => {
            crate::agent_paths::user_path(crate::agent_paths::AgentPath::OpenCode)?
        }
    })
}

fn resolve_skill_dir(
    agent: SkillAgent,
    scope: SkillScope,
    project_path: Option<&str>,
    folder_name: &str,
    enabled: bool,
) -> Result<PathBuf, String> {
    validate_folder_name(folder_name)?;
    let roots = resolve_skill_roots(agent, scope, project_path)?;
    let base = if enabled {
        roots.enabled_dir
    } else {
        roots.disabled_dir
    }
    .ok_or_else(|| "No skill directory is available for the current scope".to_string())?;
    Ok(base.join(folder_name))
}

fn validate_folder_name(folder_name: &str) -> Result<(), String> {
    let path = Path::new(folder_name);
    let is_single_component = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == folder_name);
    if folder_name.is_empty() || !is_single_component {
        return Err("Invalid skill directory name".to_string());
    }
    Ok(())
}

fn scope_key(scope: SkillScope) -> &'static str {
    match scope {
        SkillScope::Workspace => "workspace",
        SkillScope::User => "user",
    }
}

fn slugify_folder_name(input: &str) -> String {
    let mut output = String::new();
    let mut previous_dash = false;
    for character in input.chars() {
        let normalized = match character {
            'A'..='Z' => character.to_ascii_lowercase(),
            'a'..='z' | '0'..='9' => character,
            _ => '-',
        };
        if normalized == '-' {
            if !previous_dash && !output.is_empty() {
                output.push('-');
            }
            previous_dash = true;
        } else {
            output.push(normalized);
            previous_dash = false;
        }
    }
    let slug = output.trim_matches('-');
    if slug.is_empty() {
        "new-skill".to_string()
    } else {
        slug.chars().take(64).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn install_request(project: &Path) -> SkillInstallRequest {
        SkillInstallRequest {
            agents: vec![SkillAgent::Codex, SkillAgent::Claude],
            scope: SkillScope::Workspace,
            name: "Review Checklist".into(),
            description: "Review safely".into(),
            source_directory: None,
            project_path: Some(display_path(project)),
        }
    }

    #[test]
    fn multi_agent_install_deduplicates_shared_roots() {
        let project = tempfile::tempdir().expect("project");
        let mut request = install_request(project.path());
        request.agents = vec![SkillAgent::Codex, SkillAgent::Pi, SkillAgent::Antigravity];
        let installed = install_skill(request).expect("install");
        assert_eq!(installed.len(), 1);
        assert!(installed[0].effective_agents.contains(&SkillAgent::Pi));
        assert!(project
            .path()
            .join(".agents/skills/review-checklist/SKILL.md")
            .is_file());
    }

    #[test]
    fn import_preserves_resources_and_source_files() {
        let project = tempfile::tempdir().expect("project");
        let source = tempfile::tempdir().expect("source");
        let skill = source.path().join("review");
        fs::create_dir_all(skill.join("references")).expect("references");
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: review\ndescription: Review\n---\n",
        )
        .expect("skill");
        fs::write(skill.join("references/check.md"), "Check changes").expect("reference");
        let mut request = install_request(project.path());
        request.source_directory = Some(display_path(&skill));
        let installed = install_skill(request).expect("import");
        assert_eq!(installed.len(), 2);
        for directory in [".agents", ".claude"] {
            assert_eq!(
                fs::read_to_string(
                    project
                        .path()
                        .join(directory)
                        .join("skills/review/references/check.md")
                )
                .expect("copy"),
                "Check changes"
            );
        }
        assert!(skill.join("SKILL.md").is_file());
        assert_eq!(
            installed[0].content_fingerprint,
            installed[1].content_fingerprint
        );
        assert_ne!(
            installed[0].resolved_file_path,
            installed[1].resolved_file_path
        );
    }

    #[test]
    fn install_preflights_all_targets_without_overwriting_existing_skills() {
        let project = tempfile::tempdir().expect("project");
        let existing = project.path().join(".claude/skills/review-checklist");
        fs::create_dir_all(&existing).expect("existing");
        fs::write(existing.join("SKILL.md"), "Keep my skill").expect("content");
        assert!(install_skill(install_request(project.path())).is_err());
        assert!(!project
            .path()
            .join(".agents/skills/review-checklist")
            .exists());
        assert_eq!(
            fs::read_to_string(existing.join("SKILL.md")).expect("preserved"),
            "Keep my skill"
        );
    }

    #[test]
    fn failed_second_target_rolls_back_only_new_skill_directories() {
        let project = tempfile::tempdir().expect("project");
        fs::write(project.path().join(".claude"), "not a directory").expect("block target");
        assert!(install_skill(install_request(project.path())).is_err());
        assert!(!project
            .path()
            .join(".agents/skills/review-checklist")
            .exists());
        assert_eq!(
            fs::read_to_string(project.path().join(".claude")).expect("preserved"),
            "not a directory"
        );
    }

    #[test]
    fn import_rejects_recursive_destinations_and_missing_manifests() {
        let project = tempfile::tempdir().expect("project");
        let mut request = install_request(project.path());
        request.source_directory = Some(display_path(project.path()));
        assert!(install_skill(request).is_err());
        fs::write(project.path().join("SKILL.md"), "Skill").expect("manifest");
        let mut request = install_request(project.path());
        request.source_directory = Some(display_path(project.path()));
        assert!(install_skill(request)
            .expect_err("recursive import")
            .contains("inside the source"));
        assert!(!project.path().join(".agents").exists());
    }

    #[test]
    fn same_real_file_is_not_an_independent_copy_conflict() {
        let mut skills = vec![
            make_conflict_test_skill(SkillAgent::Claude, "same", true),
            make_conflict_test_skill(SkillAgent::Codex, "same", true),
        ];
        skills[1].resolved_file_path = skills[0].resolved_file_path.clone();
        classify_skill_conflicts(&mut skills);
        assert!(skills
            .iter()
            .all(|skill| skill.conflict_status == SkillConflictStatus::None));
    }

    #[test]
    fn compatibility_matches_agent_discovery_rules() {
        assert_eq!(
            SkillAgent::Claude.effective_agents(SkillScope::Workspace),
            vec![SkillAgent::Claude, SkillAgent::Opencode]
        );
        assert_eq!(
            SkillAgent::Codex.effective_agents(SkillScope::Workspace),
            vec![
                SkillAgent::Codex,
                SkillAgent::Antigravity,
                SkillAgent::Opencode,
                SkillAgent::Pi
            ]
        );
        assert_eq!(
            SkillAgent::Pi.effective_agents(SkillScope::User),
            vec![SkillAgent::Codex, SkillAgent::Opencode, SkillAgent::Pi]
        );
        assert_eq!(
            SkillAgent::Antigravity.effective_agents(SkillScope::User),
            vec![SkillAgent::Antigravity]
        );
        assert_eq!(
            SkillAgent::Qoder.effective_agents(SkillScope::Workspace),
            vec![SkillAgent::Qoder]
        );
        assert_eq!(
            SkillAgent::Qoder.effective_agents(SkillScope::User),
            vec![SkillAgent::Qoder]
        );
    }

    #[test]
    fn workspace_roots_are_agent_specific() {
        let project = Path::new("project");
        for (agent, directory) in [
            (SkillAgent::Claude, ".claude"),
            (SkillAgent::Codex, ".agents"),
            (SkillAgent::Qoder, ".qoder"),
            (SkillAgent::Antigravity, ".agents"),
            (SkillAgent::Opencode, ".opencode"),
            (SkillAgent::Pi, ".agents"),
        ] {
            let roots = resolve_skill_roots(agent, SkillScope::Workspace, Some("project")).unwrap();
            assert_eq!(
                roots.enabled_dir,
                Some(project.join(directory).join("skills"))
            );
        }
    }

    #[test]
    fn antigravity_global_skills_use_the_native_config_root() {
        let root = agent_user_directory(SkillAgent::Antigravity).unwrap();
        assert!(root.ends_with(Path::new(".gemini").join("config")));
    }

    #[test]
    fn qoder_global_skills_use_the_native_config_root() {
        let roots = resolve_skill_roots(SkillAgent::Qoder, SkillScope::User, None).unwrap();
        assert!(roots
            .enabled_dir
            .is_some_and(|path| path.ends_with(Path::new(".qoder-cn").join("skills"))));
        assert!(roots
            .disabled_dir
            .is_some_and(|path| path.ends_with(Path::new(".qoder-cn").join("skills-disabled"))));
    }

    fn make_conflict_test_skill(agent: SkillAgent, fingerprint: &str, enabled: bool) -> SkillInfo {
        SkillInfo {
            id: agent.key().to_string(),
            name: "Review".to_string(),
            description: String::new(),
            enabled,
            scope: SkillScope::Workspace,
            agent,
            effective_agents: agent.effective_agents(SkillScope::Workspace),
            conflict_status: SkillConflictStatus::None,
            conflict_agents: Vec::new(),
            conflicting_paths: Vec::new(),
            content_fingerprint: fingerprint.to_string(),
            folder_name: "review".to_string(),
            file_path: format!("{}/SKILL.md", agent.key()),
            resolved_file_path: format!("{}/SKILL.md", agent.key()),
            entry_is_link: false,
            source_dir: String::new(),
            updated_at: None,
        }
    }

    #[test]
    fn identical_skills_are_classified_as_copies() {
        let mut skills = vec![
            make_conflict_test_skill(SkillAgent::Claude, "same", true),
            make_conflict_test_skill(SkillAgent::Codex, "same", true),
        ];
        classify_skill_conflicts(&mut skills);
        assert!(skills
            .iter()
            .all(|skill| skill.conflict_status == SkillConflictStatus::IdenticalCopy));
        assert!(skills.iter().all(|skill| skill.conflict_agents.is_empty()));
    }

    #[test]
    fn diverged_skills_with_shared_consumers_are_runtime_conflicts() {
        let mut skills = vec![
            make_conflict_test_skill(SkillAgent::Claude, "left", true),
            make_conflict_test_skill(SkillAgent::Codex, "right", true),
        ];
        classify_skill_conflicts(&mut skills);
        assert!(skills
            .iter()
            .all(|skill| skill.conflict_status == SkillConflictStatus::RuntimeConflict));
        assert!(skills
            .iter()
            .all(|skill| skill.conflict_agents == vec![SkillAgent::Opencode]));
    }

    #[test]
    fn disabled_diverged_skills_do_not_create_runtime_conflicts() {
        let mut skills = vec![
            make_conflict_test_skill(SkillAgent::Claude, "left", true),
            make_conflict_test_skill(SkillAgent::Codex, "right", false),
        ];
        classify_skill_conflicts(&mut skills);
        assert!(skills
            .iter()
            .all(|skill| skill.conflict_status == SkillConflictStatus::DivergedCopy));
    }

    #[test]
    fn folder_names_cannot_escape_the_skill_root() {
        assert!(validate_folder_name("review-checklist").is_ok());
        assert!(validate_folder_name("../outside").is_err());
        assert!(validate_folder_name(r"..\outside").is_err());
    }
}
