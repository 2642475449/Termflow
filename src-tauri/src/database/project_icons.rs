use super::{read_setting, write_setting, Database};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const PREFERENCES_KEY: &str = "projects.iconPreferences.v1";
pub const MAX_PROJECT_ICON_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProjectIconMode {
    Auto,
    Initials,
    Emoji,
    Image,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIconPreference {
    pub color: u8,
    pub mode: ProjectIconMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(default)]
    pub revision: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyProjectIcon {
    pub path: String,
    pub color: u8,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectIconPreferences {
    #[serde(default)]
    migrated: bool,
    #[serde(default)]
    preferences: BTreeMap<String, ProjectIconPreference>,
}

pub fn normalize_project_icon_path(path: &str) -> Result<String, String> {
    if path.trim().is_empty() || path.len() > 8192 {
        return Err("项目路径无效".into());
    }
    let normalized = path.replace('\\', "/").trim_end_matches('/').to_owned();
    let bytes = normalized.as_bytes();
    let windows_drive =
        bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/';
    Ok(if windows_drive || normalized.starts_with("//") {
        normalized.to_lowercase()
    } else {
        normalized
    })
}

pub fn project_icon_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"\x00\x00\x01\x00") {
        Some("image/x-icon")
    } else {
        None
    }
}

impl ProjectIconPreference {
    fn automatic(color: u8, revision: u64) -> Self {
        Self {
            color,
            mode: ProjectIconMode::Auto,
            emoji: None,
            image: None,
            revision,
        }
    }

    fn validate_and_normalize(&mut self) -> Result<(), String> {
        if self.color >= 12 {
            return Err("图标颜色无效".into());
        }
        match self.mode {
            ProjectIconMode::Emoji => {
                let emoji = self.emoji.as_deref().unwrap_or("").trim();
                if emoji.is_empty()
                    || emoji.len() > 128
                    || emoji.encode_utf16().count() > 32
                    || emoji.chars().any(char::is_control)
                {
                    return Err("请输入有效的 Emoji".into());
                }
                self.emoji = Some(emoji.to_owned());
                self.image = None;
            }
            ProjectIconMode::Image => {
                let image = self.image.as_deref().ok_or("请选择图片")?;
                if image.len() > MAX_PROJECT_ICON_BYTES.div_ceil(3) * 4 + 64 {
                    return Err("图片超过 256KB，请压缩后再试".into());
                }
                let (header, encoded) = image.split_once(',').ok_or("图标图片格式无效")?;
                let bytes = STANDARD.decode(encoded).map_err(|_| "图标图片格式无效")?;
                if bytes.len() > MAX_PROJECT_ICON_BYTES {
                    return Err("图片超过 256KB，请压缩后再试".into());
                }
                let mime = project_icon_mime(&bytes).ok_or("请选择 PNG、WebP、JPEG 或 ICO 图片")?;
                if header != format!("data:{mime};base64") {
                    return Err("图标图片格式无效".into());
                }
                self.emoji = None;
            }
            ProjectIconMode::Auto | ProjectIconMode::Initials => {
                self.emoji = None;
                self.image = None;
            }
        }
        Ok(())
    }
}

fn next_revision(preferences: &BTreeMap<String, ProjectIconPreference>) -> u64 {
    preferences
        .values()
        .map(|entry| entry.revision)
        .max()
        .unwrap_or(0)
        .saturating_add(1)
}

fn default_color(path: &str) -> u8 {
    let mut hash = 0x811c9dc5_u32;
    for unit in path.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x01000193);
    }
    hash ^= hash >> 16;
    (hash % 12) as u8
}

impl Database {
    pub fn load_project_icon_preferences(
        &self,
        legacy_projects: &[LegacyProjectIcon],
    ) -> Result<BTreeMap<String, ProjectIconPreference>, String> {
        let conn = self.conn.lock();
        let mut state: ProjectIconPreferences =
            read_setting(&conn, PREFERENCES_KEY)?.unwrap_or_default();
        // 空名单可能来自尚未恢复的窗口，不抢先完成迁移。
        if !state.migrated && !legacy_projects.is_empty() {
            for legacy in legacy_projects {
                if legacy.color >= 6 {
                    return Err("旧项目图标颜色无效".into());
                }
                let key = normalize_project_icon_path(&legacy.path)?;
                if !state.preferences.contains_key(&key) {
                    let preference = ProjectIconPreference::automatic(
                        legacy.color,
                        next_revision(&state.preferences),
                    );
                    state.preferences.insert(key, preference);
                }
            }
            state.migrated = true;
            write_setting(&conn, PREFERENCES_KEY, &state)?;
        }
        Ok(state.preferences)
    }

    pub fn ensure_project_icon_preference(
        &self,
        project_path: &str,
    ) -> Result<ProjectIconPreference, String> {
        let key = normalize_project_icon_path(project_path)?;
        let conn = self.conn.lock();
        let mut state: ProjectIconPreferences =
            read_setting(&conn, PREFERENCES_KEY)?.unwrap_or_default();
        if let Some(preference) = state.preferences.get(&key) {
            return Ok(preference.clone());
        }
        let preference = ProjectIconPreference::automatic(
            default_color(&key),
            next_revision(&state.preferences),
        );
        state.preferences.insert(key, preference.clone());
        write_setting(&conn, PREFERENCES_KEY, &state)?;
        Ok(preference)
    }

    pub fn save_project_icon_preference(
        &self,
        project_path: &str,
        mut preference: ProjectIconPreference,
    ) -> Result<ProjectIconPreference, String> {
        let key = normalize_project_icon_path(project_path)?;
        preference.validate_and_normalize()?;
        let conn = self.conn.lock();
        let mut state: ProjectIconPreferences =
            read_setting(&conn, PREFERENCES_KEY)?.unwrap_or_default();
        let expected_revision = state
            .preferences
            .get(&key)
            .map(|entry| entry.revision)
            .unwrap_or(0);
        // 编辑草稿携带打开时的修订号，防止另一窗口的新设置被旧草稿覆盖。
        if preference.revision != expected_revision {
            return Err("PROJECT_ICON_CONFLICT".into());
        }
        // 只更新当前项目，避免其他窗口提交的项目设置被旧快照覆盖。
        preference.revision = next_revision(&state.preferences);
        state.preferences.insert(key, preference.clone());
        write_setting(&conn, PREFERENCES_KEY, &state)?;
        Ok(preference)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_legacy_colors_once_and_preserves_new_project_preferences() {
        let db = Database::open_in_memory();
        assert!(db
            .load_project_icon_preferences(&[])
            .expect("load")
            .is_empty());
        let migrated = db
            .load_project_icon_preferences(&[LegacyProjectIcon {
                path: "E:\\Project".into(),
                color: 4,
            }])
            .expect("migrate");
        assert_eq!(migrated["e:/project"].color, 4);
        assert_eq!(
            db.ensure_project_icon_preference("e:/PROJECT/")
                .expect("ensure"),
            migrated["e:/project"]
        );
        let next = db.ensure_project_icon_preference("/new").expect("new");
        let later = db
            .load_project_icon_preferences(&[LegacyProjectIcon {
                path: "/new".into(),
                color: 1,
            }])
            .expect("reload");
        assert_eq!(later["/new"], next);
    }

    #[test]
    fn project_updates_survive_other_settings_and_preserve_other_projects() {
        let db = Database::open_in_memory();
        let first = db.ensure_project_icon_preference("/one").expect("one");
        let second = db.ensure_project_icon_preference("/two").expect("two");
        let saved = db
            .save_project_icon_preference(
                "/one",
                ProjectIconPreference {
                    color: 11,
                    mode: ProjectIconMode::Emoji,
                    emoji: Some("🚀".into()),
                    image: None,
                    revision: first.revision,
                },
            )
            .expect("save");
        assert!(saved.revision > second.revision && second.revision > first.revision);
        db.save_general_persistent_settings(&Default::default())
            .expect("general settings");
        let restored = db.load_project_icon_preferences(&[]).expect("reload");
        assert_eq!(restored["/one"], saved);
        assert_eq!(restored["/two"], second);
    }

    #[test]
    fn rejects_invalid_colors_emoji_and_images() {
        let db = Database::open_in_memory();
        let mut preference = ProjectIconPreference::automatic(12, 0);
        assert!(db
            .save_project_icon_preference("/one", preference.clone())
            .is_err());
        preference.color = 0;
        preference.mode = ProjectIconMode::Emoji;
        preference.emoji = Some("\n".into());
        assert!(db
            .save_project_icon_preference("/one", preference.clone())
            .is_err());
        preference.mode = ProjectIconMode::Image;
        preference.image = Some("data:image/svg+xml;base64,PHN2Zy8+".into());
        assert!(db
            .save_project_icon_preference("/one", preference.clone())
            .is_err());
        preference.image = Some(format!(
            "data:image/png;base64,{}",
            STANDARD.encode(b"\x89PNG\r\n\x1a\n")
        ));
        let saved = db
            .save_project_icon_preference("/one", preference)
            .expect("png");
        assert_eq!(saved.emoji, None);
    }

    #[test]
    fn preferences_and_revisions_survive_database_reopen() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("icons.db");
        let open = || {
            let conn = rusqlite::Connection::open(&path).expect("open");
            super::super::schema::migrate(&conn).expect("migrate schema");
            Database {
                conn: parking_lot::Mutex::new(conn),
            }
        };
        let saved = {
            let db = open();
            let mut preference = db
                .ensure_project_icon_preference("E:\\Saved")
                .expect("ensure");
            preference.mode = ProjectIconMode::Initials;
            preference.color = 10;
            db.save_project_icon_preference("e:/saved", preference)
                .expect("save")
        };
        let db = open();
        assert_eq!(
            db.ensure_project_icon_preference("E:/SAVED/")
                .expect("restored"),
            saved
        );
        let next = db.ensure_project_icon_preference("/another").expect("new");
        assert!(next.revision > saved.revision);
    }

    #[test]
    fn newly_seen_projects_can_use_all_twelve_colors() {
        let db = Database::open_in_memory();
        let mut colors = std::collections::BTreeSet::new();
        for index in 0..100 {
            colors.insert(
                db.ensure_project_icon_preference(&format!("/project-{index}"))
                    .expect("ensure")
                    .color,
            );
        }
        assert_eq!(colors.len(), 12);
    }

    #[test]
    fn stale_editor_cannot_overwrite_another_windows_saved_preference() {
        let db = Database::open_in_memory();
        let original = db
            .ensure_project_icon_preference("E:\\Project")
            .expect("ensure");
        let mut newer_draft = original.clone();
        newer_draft.color = 10;
        let saved = db
            .save_project_icon_preference("e:/project", newer_draft)
            .expect("newer save");
        let mut stale_draft = original;
        stale_draft.color = 11;
        assert_eq!(
            db.save_project_icon_preference("E:/PROJECT/", stale_draft),
            Err("PROJECT_ICON_CONFLICT".into())
        );
        assert_eq!(
            db.ensure_project_icon_preference("e:/project")
                .expect("retained"),
            saved
        );
        let mut refreshed_draft = saved;
        refreshed_draft.color = 11;
        assert_eq!(
            db.save_project_icon_preference("e:/project", refreshed_draft)
                .expect("refreshed save")
                .color,
            11
        );
    }

    #[test]
    fn a_preference_for_a_missing_project_requires_initial_revision_zero() {
        let db = Database::open_in_memory();
        assert_eq!(
            db.save_project_icon_preference("/missing", ProjectIconPreference::automatic(2, 1)),
            Err("PROJECT_ICON_CONFLICT".into())
        );
        assert!(db
            .save_project_icon_preference("/missing", ProjectIconPreference::automatic(2, 0))
            .is_ok());
    }
}
