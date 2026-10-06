//! CLI 用户目录解析。项目级目录不受用户目录覆盖影响。
use std::ffi::OsString;
use std::path::PathBuf;

#[derive(Clone, Copy)]
pub(crate) enum AgentPath {
    Codex,
    Claude,
    ClaudeState,
    OpenCode,
    Pi,
}

pub(crate) fn user_path(agent: AgentPath) -> Result<PathBuf, String> {
    resolve_user_path(agent, dirs_next::home_dir(), |key| std::env::var_os(key))
}

fn resolve_user_path(
    agent: AgentPath,
    home: Option<PathBuf>,
    env: impl Fn(&str) -> Option<OsString>,
) -> Result<PathBuf, String> {
    let value = |key| {
        env(key)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    };
    let override_path = match agent {
        AgentPath::Codex => value("CODEX_HOME"),
        AgentPath::Claude => value("CLAUDE_CONFIG_DIR"),
        AgentPath::ClaudeState => value("CLAUDE_CONFIG_DIR").map(|path| path.join(".claude.json")),
        AgentPath::OpenCode => value("OPENCODE_CONFIG_DIR")
            .or_else(|| value("XDG_CONFIG_HOME").map(|path| path.join("opencode"))),
        AgentPath::Pi => value("PI_CODING_AGENT_DIR"),
    };
    if let Some(path) = override_path {
        return Ok(path);
    }
    let home = home.ok_or("Unable to resolve the user home directory")?;
    Ok(match agent {
        AgentPath::Codex => home.join(".codex"),
        AgentPath::Claude => home.join(".claude"),
        AgentPath::ClaudeState => home.join(".claude.json"),
        AgentPath::OpenCode => home.join(".config").join("opencode"),
        AgentPath::Pi => home.join(".pi").join("agent"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_overrides_match_cli_layouts() {
        for (agent, key, default, suffix) in [
            (AgentPath::Codex, "CODEX_HOME", ".codex", ""),
            (AgentPath::Claude, "CLAUDE_CONFIG_DIR", ".claude", ""),
            (
                AgentPath::ClaudeState,
                "CLAUDE_CONFIG_DIR",
                ".claude.json",
                ".claude.json",
            ),
            (
                AgentPath::OpenCode,
                "OPENCODE_CONFIG_DIR",
                ".config/opencode",
                "",
            ),
            (AgentPath::Pi, "PI_CODING_AGENT_DIR", ".pi/agent", ""),
        ] {
            let home = PathBuf::from("user");
            assert_eq!(
                resolve_user_path(agent, Some(home.clone()), |_| None).unwrap(),
                home.join(default)
            );
            let custom = PathBuf::from("custom directory/中文");
            assert_eq!(
                resolve_user_path(agent, None, |name| (name == key)
                    .then(|| custom.clone().into_os_string()))
                .unwrap(),
                if suffix.is_empty() {
                    custom
                } else {
                    custom.join(suffix)
                }
            );
            assert_eq!(
                resolve_user_path(agent, Some(home.clone()), |_| Some(OsString::new())).unwrap(),
                home.join(default)
            );
        }
    }

    #[test]
    fn opencode_explicit_directory_precedes_xdg() {
        let resolve = |explicit| {
            resolve_user_path(AgentPath::OpenCode, None, |key| match key {
                "OPENCODE_CONFIG_DIR" if explicit => Some("explicit".into()),
                "XDG_CONFIG_HOME" => Some("xdg".into()),
                _ => None,
            })
            .unwrap()
        };
        assert_eq!(resolve(true), PathBuf::from("explicit"));
        assert_eq!(resolve(false), PathBuf::from("xdg/opencode"));
        assert!(resolve_user_path(AgentPath::Codex, None, |_| None).is_err());
    }
}
