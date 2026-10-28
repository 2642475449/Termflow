use super::skills::{build_skill_info, resolve_skill_dir, SkillAgent, SkillDetail, SkillScope};
use crate::path_utils::display_path;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;

static SAVE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SkillValidation {
    pub issues: Vec<String>,
    pub name: String,
    pub description: String,
}

// 按独占整行的分隔符读取，兼容 BOM、CRLF 和 YAML 块文本。
pub(super) fn skill_frontmatter(content: &str) -> Option<&str> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut lines = content.split_inclusive('\n');
    let first = lines.next()?;
    if first.trim_end_matches(['\r', '\n']) != "---" {
        return None;
    }
    let start = first.len();
    let mut offset = start;
    for line in lines {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return Some(&content[start..offset]);
        }
        offset += line.len();
    }
    None
}

pub(super) fn skill_metadata(content: &str) -> Option<(String, String)> {
    let value: serde_yaml::Value = serde_yaml::from_str(skill_frontmatter(content)?).ok()?;
    Some((
        value
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string(),
        value
            .get("description")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string(),
    ))
}

#[tauri::command]
pub fn validate_skill_content(content: String, folder_name: String) -> SkillValidation {
    let mut result = SkillValidation {
        issues: Vec::new(),
        name: String::new(),
        description: String::new(),
    };
    let Some(frontmatter) = skill_frontmatter(&content) else {
        result.issues.push("missingFrontmatter".into());
        return result;
    };
    let value = match serde_yaml::from_str::<serde_yaml::Value>(frontmatter) {
        Ok(value) if value.is_mapping() => value,
        _ => {
            result.issues.push("malformedYaml".into());
            return result;
        }
    };
    result.name = value
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .into();
    result.description = value
        .get("description")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .into();
    let name = result.name.as_str();
    if name.is_empty()
        || name.len() > 64
        || name.starts_with('-')
        || name.ends_with('-')
        || name.contains("--")
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        result.issues.push("invalidName".into());
    } else if name != folder_name {
        result.issues.push("nameMismatch".into());
    }
    if result.description.trim().is_empty() || result.description.chars().count() > 1024 {
        result.issues.push("invalidDescription".into());
    }
    result
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSaveRequest {
    pub agent: SkillAgent,
    pub scope: SkillScope,
    pub folder_name: String,
    pub enabled: bool,
    pub project_path: Option<String>,
    pub content: String,
    pub expected_content: String,
    pub expected_resolved_path: String,
}

#[tauri::command]
pub fn save_skill_content(request: SkillSaveRequest) -> Result<SkillDetail, String> {
    let _guard = SAVE_LOCK.lock();
    let validation = validate_skill_content(request.content.clone(), request.folder_name.clone());
    if !validation.issues.is_empty() {
        return Err("skill_validation_failed".into());
    }
    let directory = resolve_skill_dir(
        request.agent,
        request.scope,
        request.project_path.as_deref(),
        &request.folder_name,
        request.enabled,
    )?;
    let entry = directory.join("SKILL.md");
    let verify = || -> Result<std::path::PathBuf, String> {
        let resolved = fs::canonicalize(&entry).map_err(|_| "skill_path_changed".to_string())?;
        if display_path(&resolved) != request.expected_resolved_path {
            return Err("skill_path_changed".into());
        }
        let current = fs::read_to_string(&resolved).map_err(|error| error.to_string())?;
        if current != request.expected_content {
            return Err("skill_content_changed".into());
        }
        Ok(resolved)
    };
    let resolved = verify()?;
    // 写实际文件所在目录，保留目录链接和 SKILL.md 链接本身。
    let temporary =
        resolved.with_file_name(format!(".termflow-skill-{}.tmp", rand::random::<u64>()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(request.content.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        drop(file);
        fs::set_permissions(
            &temporary,
            fs::metadata(&resolved)
                .map_err(|error| error.to_string())?
                .permissions(),
        )
        .map_err(|error| error.to_string())?;
        // 再次检查，避免准备临时文件期间被外部编辑或切换了链接目标。
        verify()?;
        fs::rename(&temporary, &resolved).map_err(|error| error.to_string())?;
        let skill = build_skill_info(
            request.agent,
            request.scope,
            request.enabled,
            &directory,
            &request.content,
        )?;
        Ok(SkillDetail {
            skill,
            content: request.content,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::super::skills::get_skill_detail;
    use super::*;

    fn content(description: &str) -> String {
        format!(
            "---\nname: review\ndescription: {description}\n---\n\n# Review\n\nCheck changes.\n"
        )
    }

    fn setup() -> (tempfile::TempDir, SkillSaveRequest) {
        let project = tempfile::tempdir().expect("project");
        let directory = project.path().join(".agents/skills/review");
        fs::create_dir_all(&directory).expect("skill directory");
        fs::write(directory.join("SKILL.md"), content("Original")).expect("manifest");
        let detail = get_skill_detail(
            SkillAgent::Codex,
            SkillScope::Workspace,
            "review".into(),
            true,
            Some(display_path(project.path())),
        )
        .expect("detail");
        let request = SkillSaveRequest {
            agent: SkillAgent::Codex,
            scope: SkillScope::Workspace,
            folder_name: "review".into(),
            enabled: true,
            project_path: Some(display_path(project.path())),
            content: content("Updated"),
            expected_content: detail.content,
            expected_resolved_path: detail.skill.resolved_file_path,
        };
        (project, request)
    }

    #[test]
    fn validation_handles_yaml_blocks_quotes_crlf_and_extra_fields() {
        let input = "\u{feff}---\r\nname: review\r\ndescription: |\r\n  First line\r\n  Second line\r\nallowed-tools: Read\r\n---\r\n# Review";
        let validation = validate_skill_content(input.into(), "review".into());
        assert!(validation.issues.is_empty());
        assert_eq!(validation.description, "First line\nSecond line\n");
        assert!(
            validate_skill_content(content("\"Text: quoted\""), "review".into())
                .issues
                .is_empty()
        );
    }

    #[test]
    fn validation_rejects_invalid_metadata_and_duplicate_yaml_keys() {
        assert_eq!(
            validate_skill_content("# No metadata".into(), "review".into()).issues,
            vec!["missingFrontmatter"]
        );
        assert_eq!(
            validate_skill_content("---\nname: [broken\n---\n".into(), "review".into()).issues,
            vec!["malformedYaml"]
        );
        assert_eq!(
            validate_skill_content(
                "---\nname: review\nname: other\ndescription: test\n---\n".into(),
                "review".into()
            )
            .issues,
            vec!["malformedYaml"]
        );
        let validation = validate_skill_content(
            "---\nname: Bad Name\ndescription: 42\n---\n".into(),
            "review".into(),
        );
        assert_eq!(validation.issues, vec!["invalidName", "invalidDescription"]);
        assert_eq!(
            validate_skill_content(content("Okay"), "other".into()).issues,
            vec!["nameMismatch"]
        );
        assert_eq!(
            validate_skill_content(content(&"x".repeat(1025)), "review".into()).issues,
            vec!["invalidDescription"]
        );
    }

    #[test]
    fn save_updates_metadata_and_preserves_resources() {
        let (project, request) = setup();
        let resources = project.path().join(".agents/skills/review/check.txt");
        fs::write(&resources, "Keep resources").expect("resource");
        let detail = save_skill_content(request).expect("save");
        assert_eq!(detail.skill.description, "Updated");
        assert_eq!(
            fs::read_to_string(resources).expect("preserved"),
            "Keep resources"
        );
        assert_eq!(
            fs::read_to_string(project.path().join(".agents/skills/review/SKILL.md"))
                .expect("saved"),
            detail.content
        );
    }

    #[test]
    fn saves_do_not_update_independent_copies_or_overwrite_external_edits() {
        let (project, request) = setup();
        let copy = project.path().join(".claude/skills/review");
        fs::create_dir_all(&copy).expect("copy directory");
        fs::write(copy.join("SKILL.md"), &request.expected_content).expect("copy");
        save_skill_content(request).expect("save original");
        assert_eq!(
            fs::read_to_string(copy.join("SKILL.md")).expect("independent"),
            content("Original")
        );
        let (project, request) = setup();
        let path = project.path().join(".agents/skills/review/SKILL.md");
        fs::write(&path, content("External edit")).expect("external edit");
        assert_eq!(
            save_skill_content(request).err().as_deref(),
            Some("skill_content_changed")
        );
        assert_eq!(
            fs::read_to_string(path).expect("preserved"),
            content("External edit")
        );
    }

    #[test]
    fn generated_long_names_remain_valid_and_metadata_limits_are_inclusive() {
        let name = "a".repeat(64);
        let input = format!(
            "---\nname: {name}\ndescription: {}\n---\n",
            "文".repeat(1024)
        );
        assert!(validate_skill_content(input, name).issues.is_empty());
        let project = tempfile::tempdir().expect("project");
        let skill = super::super::skills::create_skill(
            SkillAgent::Codex,
            SkillScope::Workspace,
            format!("{} separator", "a".repeat(63)),
            Some("Test".into()),
            Some(display_path(project.path())),
        )
        .expect("create long name");
        let content = fs::read_to_string(skill.file_path).expect("template");
        assert!(validate_skill_content(content, skill.folder_name)
            .issues
            .is_empty());
    }

    #[test]
    fn save_rejects_conflicts_invalid_content_and_changed_paths_without_writing() {
        for reason in ["content", "path", "validation"] {
            let (project, mut request) = setup();
            match reason {
                "content" => request.expected_content = "Stale".into(),
                "path" => request.expected_resolved_path = "Other file".into(),
                _ => request.content = "Invalid".into(),
            }
            assert!(save_skill_content(request).is_err());
            assert_eq!(
                fs::read_to_string(project.path().join(".agents/skills/review/SKILL.md"))
                    .expect("original"),
                content("Original")
            );
            assert_eq!(
                fs::read_dir(project.path().join(".agents/skills/review"))
                    .expect("entries")
                    .count(),
                1
            );
        }
    }
}
