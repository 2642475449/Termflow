//! 只发现 OpenSSH 配置中明确命名的 Host，不解析凭据，也不执行 Match exec。
//! 连接时仍传入原始别名，由系统 ssh 处理 HostName/User/IdentityFile/ProxyJump 等。
use globset::GlobBuilder;
use serde::Serialize;
use std::collections::HashSet;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

const MAX_FILES: usize = 256;
const MAX_BYTES: u64 = 1024 * 1024;
const MAX_DEPTH: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHost {
    pub alias: String,
    pub config_file: String,
}

pub fn discover_default_hosts() -> Result<Vec<SshConfigHost>, String> {
    let home = dirs_next::home_dir().ok_or("remote_ssh_config_home_unavailable")?;
    #[cfg(windows)]
    let system = std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
        .join("ssh/ssh_config");
    #[cfg(not(windows))]
    let system = PathBuf::from("/etc/ssh/ssh_config");
    discover_hosts(&home, &[home.join(".ssh/config"), system])
}

pub fn discover_hosts(home: &Path, roots: &[PathBuf]) -> Result<Vec<SshConfigHost>, String> {
    let mut reader = ConfigReader {
        home,
        visited: HashSet::new(),
        aliases: HashSet::new(),
        hosts: Vec::new(),
    };
    for (index, root) in roots.iter().enumerate() {
        // 相对 Include 基于用户 ~/.ssh 或系统配置目录，非被包含文件的父目录。
        let base = if index == 0 {
            home.join(".ssh")
        } else {
            root.parent().unwrap_or(Path::new(".")).to_path_buf()
        };
        reader.read(root, &base, 0)?;
    }
    Ok(reader.hosts)
}

struct ConfigReader<'a> {
    home: &'a Path,
    visited: HashSet<PathBuf>,
    aliases: HashSet<String>,
    hosts: Vec<SshConfigHost>,
}

fn config_error(path: &Path, detail: &str) -> String {
    format!(
        "remote_ssh_config_read_failed: {} ({detail})",
        path.display()
    )
}

impl ConfigReader<'_> {
    fn read(&mut self, path: &Path, base: &Path, depth: usize) -> Result<(), String> {
        let canonical = match path.canonicalize() {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(config_error(path, &error.to_string())),
        };
        if self.visited.contains(&canonical) {
            return Ok(());
        }
        if depth > MAX_DEPTH || self.visited.len() >= MAX_FILES {
            return Err(config_error(path, "Include nesting/file limit exceeded"));
        }
        self.visited.insert(canonical);
        let file =
            std::fs::File::open(path).map_err(|error| config_error(path, &error.to_string()))?;
        let mut bytes = Vec::new();
        file.take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| config_error(path, &error.to_string()))?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err(config_error(path, "configuration exceeds 1 MiB"));
        }
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| config_error(path, "expected UTF-8 configuration"))?;
        for (line_number, line) in text.trim_start_matches('\u{feff}').lines().enumerate() {
            let line = line.trim_start();
            let split = line
                .find(|c: char| c.is_whitespace() || c == '=')
                .unwrap_or(line.len());
            let keyword = &line[..split];
            if !keyword.eq_ignore_ascii_case("host") && !keyword.eq_ignore_ascii_case("include") {
                continue;
            }
            let value = line[split..]
                .trim_start()
                .strip_prefix('=')
                .unwrap_or(line[split..].trim_start())
                .trim_start();
            let arguments = tokenize(value).map_err(|_| {
                config_error(
                    path,
                    &format!("invalid quoting on line {}", line_number + 1),
                )
            })?;
            if keyword.eq_ignore_ascii_case("host") {
                for alias in &arguments {
                    if alias.is_empty()
                        || alias.starts_with('!')
                        || alias.contains(['*', '?', '[', ']'])
                    {
                        continue;
                    }
                    let excluded = arguments
                        .iter()
                        .filter_map(|pattern| pattern.strip_prefix('!'))
                        .any(|pattern| {
                            GlobBuilder::new(pattern)
                                .backslash_escape(false)
                                .build()
                                .map(|glob| glob.compile_matcher().is_match(alias))
                                .unwrap_or(false)
                        });
                    if !excluded && self.aliases.insert(alias.clone()) {
                        self.hosts.push(SshConfigHost {
                            alias: alias.clone(),
                            config_file: path.to_string_lossy().into_owned(),
                        });
                    }
                }
            } else {
                for argument in arguments {
                    if let Some(pattern) = expand_include(&argument, self.home, base) {
                        for included in expand_glob(&pattern)? {
                            self.read(&included, base, depth + 1)?;
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

fn tokenize(value: &str) -> Result<Vec<String>, ()> {
    let mut fields = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        match character {
            '"' => quoted = !quoted,
            '#' if !quoted => break,
            '\\' if chars
                .peek()
                .is_some_and(|next| matches!(next, '"' | '\\' | '#' | ' ' | '\t')) =>
            {
                if let Some(next) = chars.next() {
                    field.push(next);
                }
            }
            character if character.is_whitespace() && !quoted => {
                if !field.is_empty() {
                    fields.push(std::mem::take(&mut field));
                }
            }
            character => field.push(character),
        }
    }
    if quoted {
        return Err(());
    }
    if !field.is_empty() {
        fields.push(field);
    }
    Ok(fields)
}

fn expand_include(value: &str, home: &Path, base: &Path) -> Option<PathBuf> {
    let mut expanded = String::new();
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '$' && chars.peek() == Some(&'{') {
            chars.next();
            let mut variable = String::new();
            let mut closed = false;
            for next in chars.by_ref() {
                if next == '}' {
                    closed = true;
                    break;
                }
                variable.push(next);
            }
            if !closed {
                return None;
            }
            expanded.push_str(&std::env::var(variable).ok()?);
        } else if character == '%' {
            match chars.next()? {
                '%' => expanded.push('%'),
                'd' => expanded.push_str(&home.to_string_lossy()),
                'u' => expanded.push_str(
                    &std::env::var("USER")
                        .or_else(|_| std::env::var("USERNAME"))
                        .ok()?,
                ),
                _ => return None, // 主机相关 token 留给真正的 OpenSSH 连接处理。
            }
        } else {
            expanded.push(character);
        }
    }
    let path = if expanded == "~" {
        home.to_path_buf()
    } else if let Some(relative) = expanded
        .strip_prefix("~/")
        .or_else(|| expanded.strip_prefix("~\\"))
    {
        home.join(relative)
    } else {
        PathBuf::from(expanded)
    };
    Some(if path.is_absolute() {
        path
    } else {
        base.join(path)
    })
}

fn expand_glob(pattern: &Path) -> Result<Vec<PathBuf>, String> {
    let mut candidates = vec![PathBuf::new()];
    for component in pattern.components() {
        if let Component::Normal(name) = component {
            let name = name.to_string_lossy();
            if name.contains(['*', '?', '[']) {
                let matcher = GlobBuilder::new(&name)
                    .backslash_escape(false)
                    .case_insensitive(cfg!(windows))
                    .build()
                    .map_err(|_| config_error(pattern, "invalid Include glob"))?
                    .compile_matcher();
                let mut matches = Vec::new();
                for parent in &candidates {
                    let entries = match std::fs::read_dir(parent) {
                        Ok(entries) => entries,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(error) => return Err(config_error(parent, &error.to_string())),
                    };
                    for entry in entries {
                        let entry =
                            entry.map_err(|error| config_error(parent, &error.to_string()))?;
                        if matcher.is_match(Path::new(&entry.file_name())) {
                            matches.push(entry.path());
                            if matches.len() > MAX_FILES {
                                return Err(config_error(pattern, "Include file limit exceeded"));
                            }
                        }
                    }
                }
                candidates = matches;
                continue;
            }
        }
        for candidate in &mut candidates {
            candidate.push(component.as_os_str());
        }
    }
    candidates.sort();
    Ok(candidates)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().expect("parent directory"))
            .expect("create fixture directory");
        std::fs::write(path, text).expect("write fixture");
    }

    #[test]
    fn explicit_aliases_support_unicode_quotes_equals_and_exclude_patterns() {
        let temp = tempfile::tempdir().expect("temp home");
        let path = temp.path().join(".ssh/config");
        write(&path, "\u{feff}Host myserver infini-ai 8g\r\nhOsT = \"电信\" 82 # comment\nHost * !no\nHost host-* [ab] ? !negated\nHost removed !removed\nHost 82\n");
        let hosts = discover_hosts(temp.path(), &[path]).expect("discover aliases");
        assert_eq!(
            hosts
                .iter()
                .map(|host| host.alias.as_str())
                .collect::<Vec<_>>(),
            ["myserver", "infini-ai", "8g", "电信", "82"]
        );
    }

    #[test]
    fn includes_expand_in_lexical_order_and_nested_paths_use_the_ssh_root() {
        let temp = tempfile::tempdir().expect("temp home");
        let root = temp.path().join(".ssh/config");
        write(&root, "Include \"conf d/*.conf\" absent.conf\nHost last\n");
        write(&temp.path().join(".ssh/conf d/20.conf"), "Host second\n");
        write(
            &temp.path().join(".ssh/conf d/10.conf"),
            "Host first\nInclude nested.conf\n",
        );
        write(
            &temp.path().join(".ssh/nested.conf"),
            "Host nested\nInclude config\n",
        );
        let hosts = discover_hosts(temp.path(), &[root]).expect("discover includes");
        assert_eq!(
            hosts
                .iter()
                .map(|host| host.alias.as_str())
                .collect::<Vec<_>>(),
            ["first", "nested", "second", "last"]
        );
    }

    #[test]
    fn user_and_system_sources_keep_first_alias_and_never_execute_match_commands() {
        let temp = tempfile::tempdir().expect("temp home");
        let user = temp.path().join(".ssh/config");
        let system = temp.path().join("system/ssh_config");
        let marker = temp.path().join("must-not-exist");
        write(
            &user,
            &format!(
                "Host shared\nMatch exec \"touch {}\"\nHost user-only\n",
                marker.display()
            ),
        );
        write(&system, "Host shared\nInclude conf.d/*.conf\n");
        write(
            &temp.path().join("system/conf.d/extra.conf"),
            "Host system-only\n",
        );
        let hosts = discover_hosts(temp.path(), &[user.clone(), system]).expect("discover sources");
        assert_eq!(
            hosts
                .iter()
                .map(|host| host.alias.as_str())
                .collect::<Vec<_>>(),
            ["shared", "user-only", "system-only"]
        );
        assert_eq!(hosts[0].config_file, user.to_string_lossy());
        assert!(!marker.exists());
    }

    #[test]
    fn missing_config_is_empty_and_malformed_include_reports_location_without_contents() {
        let temp = tempfile::tempdir().expect("temp home");
        let path = temp.path().join(".ssh/config");
        assert!(discover_hosts(temp.path(), &[path.clone()])
            .expect("missing file")
            .is_empty());
        write(&path, "Include \"private-value\n");
        let error = discover_hosts(temp.path(), &[path]).expect_err("invalid quoting");
        assert!(error.contains("line 1"));
        assert!(!error.contains("private-value"));
    }

    #[test]
    fn paths_keep_windows_backslashes_and_expand_home_tokens() {
        assert_eq!(
            tokenize(r#""C:\Users\A B\.ssh\config" other # ignored"#).expect("tokenize"),
            [r"C:\Users\A B\.ssh\config", "other"]
        );
        let temp = tempfile::tempdir().expect("temp home");
        let home = temp.path();
        assert_eq!(
            expand_include("%d/.ssh/conf.d/*.conf", home, Path::new("/unused")),
            Some(home.join(".ssh/conf.d/*.conf"))
        );
        assert_eq!(
            expand_include("~/.ssh/config", home, Path::new("/unused")),
            Some(home.join(".ssh/config"))
        );
    }
}
