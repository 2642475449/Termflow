use crate::path_utils::{display_path, normalize_input_path};
use crate::qoder_config::{qoder_user_config_root, qoder_workspace_config_root};
use serde::{Deserialize, Serialize};
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
}

impl SkillAgent {
    const ALL: [Self; 5] = [
        Self::Claude,
        Self::Codex,
        Self::Qoder,
        Self::Antigravity,
        Self::Opencode,
    ];

    fn key(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Qoder => "qoder",
            Self::Antigravity => "antigravity",
            Self::Opencode => "opencode",
        }
    }

    fn effective_agents(self, scope: SkillScope) -> Vec<Self> {
        match (self, scope) {
            (Self::Claude, _) => vec![Self::Claude, Self::Opencode],
            (Self::Codex, SkillScope::Workspace) | (Self::Antigravity, SkillScope::Workspace) => {
                vec![Self::Codex, Self::Antigravity, Self::Opencode]
            }
            (Self::Codex, SkillScope::User) => vec![Self::Codex, Self::Opencode],
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
    pub has_name_conflict: bool,
    pub folder_name: String,
    pub file_path: String,
    pub source_dir: String,
    pub updated_at: Option<i64>,
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
            // Codex and Antigravity both natively consume workspace .agents/skills.
            // Scan that physical root once and expose both consumers through
            // effective_agents so the same Skill is never shown as a conflict
            // with itself.
            if !(agent == SkillAgent::Antigravity && scope == SkillScope::Workspace) {
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

    mark_name_conflicts(&mut skills);
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
        has_name_conflict: false,
        folder_name,
        file_path: display_path(&skill_dir.join("SKILL.md")),
        source_dir,
        updated_at,
    })
}

fn mark_name_conflicts(skills: &mut [SkillInfo]) {
    let mut counts: HashMap<(SkillScope, String), usize> = HashMap::new();
    for skill in skills.iter() {
        *counts
            .entry((skill.scope, skill.name.to_lowercase()))
            .or_default() += 1;
    }
    for skill in skills.iter_mut() {
        skill.has_name_conflict = counts
            .get(&(skill.scope, skill.name.to_lowercase()))
            .copied()
            .unwrap_or_default()
            > 1;
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
    }
}

fn agent_user_directory(agent: SkillAgent) -> Result<PathBuf, String> {
    let home = dirs_next::home_dir().ok_or("Unable to resolve the user home directory")?;
    Ok(match agent {
        SkillAgent::Claude => home.join(".claude"),
        SkillAgent::Codex => home.join(".agents"),
        SkillAgent::Qoder => qoder_user_config_root()?,
        SkillAgent::Antigravity => home.join(".gemini").join("config"),
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
                SkillAgent::Opencode
            ]
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

    #[test]
    fn duplicate_names_in_the_same_scope_are_marked_as_conflicts() {
        let make_skill = |agent: SkillAgent| SkillInfo {
            id: agent.key().to_string(),
            name: "Review".to_string(),
            description: String::new(),
            enabled: true,
            scope: SkillScope::Workspace,
            agent,
            effective_agents: agent.effective_agents(SkillScope::Workspace),
            has_name_conflict: false,
            folder_name: "review".to_string(),
            file_path: String::new(),
            source_dir: String::new(),
            updated_at: None,
        };
        let mut skills = vec![
            make_skill(SkillAgent::Claude),
            make_skill(SkillAgent::Codex),
        ];
        mark_name_conflicts(&mut skills);
        assert!(skills.iter().all(|skill| skill.has_name_conflict));
    }

    #[test]
    fn folder_names_cannot_escape_the_skill_root() {
        assert!(validate_folder_name("review-checklist").is_ok());
        assert!(validate_folder_name("../outside").is_err());
        assert!(validate_folder_name(r"..\outside").is_err());
    }
}
