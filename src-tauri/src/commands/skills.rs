use crate::path_utils::{display_path, normalize_input_path};
use crate::qoder_config::{qoder_user_config_root, qoder_workspace_config_root};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::env;
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
    let roots = resolve_skill_roots(agent, scope, project_path.as_deref())?;
    let target_root = if next_enabled {
        roots.enabled_dir
    } else {
        roots.disabled_dir
    }
    .ok_or_else(|| "No skill directory is available for the current scope".to_string())?;
    fs::create_dir_all(&target_root).map_err(|error| error.to_string())?;
    let target_dir = target_root.join(&folder_name);
    if target_dir.exists() {
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
        source_dir,
        updated_at,
    })
}

fn fingerprint_skill_directory(skill_dir: &Path) -> Result<String, String> {
    fn collect_files(directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
        for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
            let path = entry.map_err(|error| error.to_string())?.path();
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
        digest.update(fs::read(&path).map_err(|error| error.to_string())?);
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
        SkillAgent::Claude => home.join(".claude"),
        SkillAgent::Codex => home.join(".agents"),
        SkillAgent::Qoder => qoder_user_config_root()?,
        SkillAgent::Antigravity => home.join(".gemini").join("config"),
        SkillAgent::Pi => home.join(".agents"),
        SkillAgent::Opencode => {
            if let Some(path) = env::var_os("OPENCODE_CONFIG_DIR").filter(|value| !value.is_empty())
            {
                PathBuf::from(path)
            } else if let Some(path) =
                env::var_os("XDG_CONFIG_HOME").filter(|value| !value.is_empty())
            {
                PathBuf::from(path).join("opencode")
            } else {
                home.join(".config").join("opencode")
            }
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
