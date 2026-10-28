use super::skills::{
    install_skill, parse_skill_frontmatter, SkillAgent, SkillInfo, SkillInstallRequest, SkillScope,
};
use crate::database::Database;
use futures_util::{stream, StreamExt, TryStreamExt};
use reqwest::Client;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::Path,
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};
use tauri::State;

const CACHE_TTL: Duration = Duration::from_secs(600);
const MAX_FILE: usize = 5 * 1024 * 1024;
const MAX_SKILL: usize = 50 * 1024 * 1024;
const MAX_FILES: usize = 1024;
const COMMUNITY_LIMIT: usize = 50;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MarketProvider {
    Openai,
    Anthropic,
    Community,
}

impl MarketProvider {
    fn official(self) -> Option<(&'static str, &'static str)> {
        match self {
            Self::Openai => Some(("openai/skills", "skills/.curated/")),
            Self::Anthropic => Some(("anthropics/skills", "skills/")),
            Self::Community => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSkill {
    pub provider: MarketProvider,
    pub repository: String,
    pub slug: String,
    pub name: String,
    pub description: String,
    pub installs: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSearch {
    skills: Vec<MarketSkill>,
    warnings: Vec<MarketWarning>,
    community_limited: bool,
}

#[derive(Serialize)]
pub struct MarketWarning {
    provider: MarketProvider,
    reason: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketDetail {
    pub skill: MarketSkill,
    pub revision: String,
    pub directory: String,
    pub folder_name: String,
    pub content: String,
    pub file_count: usize,
    pub files: Vec<String>,
    pub total_bytes: u64,
    pub source_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketInstallRequest {
    pub skill: MarketSkill,
    pub revision: String,
    pub directory: String,
    pub agents: Vec<SkillAgent>,
    pub scope: SkillScope,
    pub project_path: Option<String>,
}

#[derive(Clone, Deserialize)]
struct TreeEntry {
    path: String,
    mode: String,
    #[serde(rename = "type")]
    kind: String,
    sha: String,
    #[serde(default)]
    size: u64,
}

#[derive(Deserialize)]
struct GitTree {
    tree: Vec<TreeEntry>,
    truncated: bool,
}
#[derive(Deserialize)]
struct GitCommit {
    sha: String,
}

#[derive(Clone)]
struct RepositorySnapshot {
    revision: String,
    entries: Vec<TreeEntry>,
}
type Cache<T> = Mutex<HashMap<String, (Instant, T)>>;
static REPOSITORIES: LazyLock<Cache<RepositorySnapshot>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static OFFICIAL: LazyLock<Cache<Vec<MarketSkill>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn cached<T: Clone>(cache: &Cache<T>, key: &str) -> Option<T> {
    cache
        .lock()
        .ok()?
        .get(key)
        .filter(|(at, _)| at.elapsed() < CACHE_TTL)
        .map(|(_, item)| item.clone())
}

fn remember<T>(cache: &Cache<T>, key: String, value: T) {
    if let Ok(mut entries) = cache.lock() {
        entries.retain(|_, (at, _)| at.elapsed() < CACHE_TTL);
        if entries.len() >= 64 {
            entries.clear();
        }
        entries.insert(key, (Instant::now(), value));
    }
}

fn client(database: &State<'_, Arc<Database>>) -> Result<Client, String> {
    let proxy = super::network_proxy::load_resolved_proxy(database)?;
    crate::network_proxy::apply_proxy_to_client_builder(
        Client::builder()
            .no_proxy()
            .user_agent("Termflow skill marketplace")
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30)),
        &proxy,
    )?
    .build()
    .map_err(|error| error.to_string())
}

async fn read_bytes(client: &Client, url: reqwest::Url, limit: usize) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Network request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(
            if status.as_u16() == 429
                || (status.as_u16() == 403
                    && response
                        .headers()
                        .get("x-ratelimit-remaining")
                        .is_some_and(|value| value == "0"))
            {
                "Service rate limit reached; please retry later".into()
            } else {
                format!("Service returned HTTP {status}")
            },
        );
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("Remote response exceeds the size limit".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if bytes.len() + chunk.len() > limit {
            return Err("Remote response exceeds the size limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn json<T: DeserializeOwned>(client: &Client, url: &str) -> Result<T, String> {
    let url = reqwest::Url::parse(url).map_err(|error| error.to_string())?;
    serde_json::from_slice(&read_bytes(client, url, 20 * 1024 * 1024).await?)
        .map_err(|error| format!("Invalid service response: {error}"))
}

fn validate_repository(repository: &str) -> Result<(), String> {
    let parts: Vec<_> = repository.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|part| {
            part.is_empty()
                || part.len() > 100
                || part.starts_with('.')
                || !part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
    {
        return Err("Invalid GitHub repository".into());
    }
    Ok(())
}

// 下载路径按 Windows 文件系统规则验证，拒绝穿越、设备名和 NTFS 数据流。
fn validate_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.len() > 1024
        || path.split('/').any(|part| {
            let stem = part
                .split('.')
                .next()
                .unwrap_or_default()
                .to_ascii_uppercase();
            part.is_empty()
                || matches!(part, "." | "..")
                || part.ends_with(['.', ' '])
                || part
                    .chars()
                    .any(|c| c.is_control() || "\\:<>\"|?*".contains(c))
                || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | ".GIT")
                || part.eq_ignore_ascii_case(".git")
                || (stem.len() == 4
                    && (stem.starts_with("COM") || stem.starts_with("LPT"))
                    && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        })
    {
        return Err(format!("Unsupported skill resource path: {path}"));
    }
    Ok(())
}

fn validate_skill(skill: &MarketSkill) -> Result<(), String> {
    validate_repository(&skill.repository)?;
    validate_path(&skill.slug)?;
    if skill.slug.contains('/') {
        return Err("Invalid skill identifier".into());
    }
    if let Some((repository, _)) = skill.provider.official() {
        if skill.repository != repository {
            return Err("Skill repository does not match its provider".into());
        }
    }
    Ok(())
}

async fn snapshot(
    client: &Client,
    repository: &str,
    revision: Option<&str>,
    refresh: bool,
) -> Result<RepositorySnapshot, String> {
    validate_repository(repository)?;
    let key = format!("{repository}@{}", revision.unwrap_or("HEAD"));
    if !refresh {
        if let Some(item) = cached(&REPOSITORIES, &key) {
            return Ok(item);
        }
    }
    let revision = if let Some(revision) = revision {
        if revision.len() != 40 || !revision.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Invalid skill revision".into());
        }
        revision.to_string()
    } else {
        json::<GitCommit>(
            client,
            &format!("https://api.github.com/repos/{repository}/commits/HEAD"),
        )
        .await?
        .sha
    };
    let tree: GitTree = json(
        client,
        &format!("https://api.github.com/repos/{repository}/git/trees/{revision}?recursive=1"),
    )
    .await?;
    if tree.truncated {
        return Err("Repository is too large to load its complete skill tree".into());
    }
    let item = RepositorySnapshot {
        revision,
        entries: tree.tree,
    };
    remember(
        &REPOSITORIES,
        format!("{repository}@{}", item.revision),
        item.clone(),
    );
    remember(&REPOSITORIES, key, item.clone());
    Ok(item)
}

async fn resource(
    client: &Client,
    repository: &str,
    revision: &str,
    entry: &TreeEntry,
) -> Result<Vec<u8>, String> {
    validate_path(&entry.path)?;
    if entry.kind != "blob"
        || !matches!(entry.mode.as_str(), "100644" | "100755")
        || entry.size > MAX_FILE as u64
    {
        return Err(format!(
            "Unsupported or oversized skill resource: {}",
            entry.path
        ));
    }
    let mut url = reqwest::Url::parse("https://raw.githubusercontent.com")
        .map_err(|error| error.to_string())?;
    url.path_segments_mut()
        .map_err(|_| "Invalid resource URL")?
        .extend(repository.split('/'))
        .push(revision)
        .extend(entry.path.split('/'));
    let bytes = read_bytes(client, url, MAX_FILE).await?;
    let hash = git2::Oid::hash_object(git2::ObjectType::Blob, &bytes)
        .map_err(|error| error.to_string())?;
    if hash.to_string() != entry.sha {
        return Err("Skill resource failed integrity verification".into());
    }
    Ok(bytes)
}

async fn manifest(
    client: &Client,
    repository: &str,
    snapshot: &RepositorySnapshot,
    entry: &TreeEntry,
) -> Result<String, String> {
    String::from_utf8(resource(client, repository, &snapshot.revision, entry).await?)
        .map_err(|_| "SKILL.md must be UTF-8 text".into())
}

fn official_manifest(path: &str, prefix: &str) -> bool {
    path.strip_prefix(prefix)
        .and_then(|rest| rest.strip_suffix("/SKILL.md"))
        .is_some_and(|folder| !folder.is_empty() && !folder.contains('/'))
}

async fn official_skills(
    client: &Client,
    provider: MarketProvider,
    refresh: bool,
) -> Result<Vec<MarketSkill>, String> {
    let (repository, prefix) = provider.official().ok_or("Unknown official source")?;
    if !refresh {
        if let Some(skills) = cached(&OFFICIAL, repository) {
            return Ok(skills);
        }
    }
    let repo = snapshot(client, repository, None, refresh).await?;
    let entries = repo
        .entries
        .iter()
        .filter(|entry| official_manifest(&entry.path, prefix))
        .cloned()
        .collect::<Vec<_>>();
    let results = stream::iter(entries.into_iter().map(|entry| {
        let repo = &repo;
        async move {
            let content = manifest(client, repository, repo, &entry).await?;
            let (name, description) = parse_skill_frontmatter(&content);
            let slug = entry
                .path
                .trim_end_matches("/SKILL.md")
                .rsplit('/')
                .next()
                .unwrap_or_default()
                .to_string();
            Ok::<_, String>(MarketSkill {
                provider,
                repository: repository.into(),
                name: if name.is_empty() { slug.clone() } else { name },
                slug,
                description,
                installs: None,
            })
        }
    }))
    .buffer_unordered(6)
    .try_collect::<Vec<_>>()
    .await?;
    remember(&OFFICIAL, repository.into(), results.clone());
    Ok(results)
}

#[derive(Deserialize)]
struct CommunityResults {
    skills: Vec<CommunitySkill>,
}
#[derive(Deserialize)]
struct CommunitySkill {
    id: String,
    source: String,
    name: String,
    installs: u64,
}

fn community_skills(results: CommunityResults) -> Vec<MarketSkill> {
    results
        .skills
        .into_iter()
        .filter_map(|entry| {
            // 公开 CLI 搜索接口也会返回 well-known 来源；本版只安装可验证的 GitHub 目录。
            validate_repository(&entry.source).ok()?;
            let slug = entry
                .id
                .strip_prefix(&format!("{}/", entry.source))?
                .to_string();
            let skill = MarketSkill {
                provider: MarketProvider::Community,
                repository: entry.source,
                slug,
                name: entry.name,
                description: String::new(),
                installs: Some(entry.installs),
            };
            validate_skill(&skill).ok()?;
            Some(skill)
        })
        .collect()
}

async fn search_community(client: &Client, query: &str) -> Result<Vec<MarketSkill>, String> {
    let mut url =
        reqwest::Url::parse("https://skills.sh/api/search").map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("limit", &COMMUNITY_LIMIT.to_string());
    let results = serde_json::from_slice::<CommunityResults>(
        &read_bytes(client, url, 2 * 1024 * 1024).await?,
    )
    .map_err(|error| format!("Invalid skills.sh search response: {error}"))?;
    Ok(community_skills(results))
}

#[tauri::command]
pub async fn search_skill_marketplace(
    query: String,
    provider: Option<MarketProvider>,
    refresh: bool,
    database: State<'_, Arc<Database>>,
) -> Result<MarketSearch, String> {
    let client = client(&database)?;
    search_with_client(&client, &query, provider, refresh).await
}

async fn search_with_client(
    client: &Client,
    query: &str,
    provider: Option<MarketProvider>,
    refresh: bool,
) -> Result<MarketSearch, String> {
    let query = query.trim();
    if query.len() > 200 {
        return Err("Search query is too long".into());
    }
    let sources = [
        MarketProvider::Openai,
        MarketProvider::Anthropic,
        MarketProvider::Community,
    ];
    let results = stream::iter(
        sources
            .into_iter()
            .filter(|source| provider.is_none_or(|p| p == *source))
            .map(|source| async move {
                let result = if source == MarketProvider::Community {
                    if query.chars().count() < 2 {
                        Ok(Vec::new())
                    } else {
                        search_community(client, query).await
                    }
                } else {
                    official_skills(client, source, refresh).await
                };
                (source, result)
            }),
    )
    .buffer_unordered(3)
    .collect::<Vec<_>>()
    .await;
    let mut skills = Vec::new();
    let mut warnings = Vec::new();
    let mut community_limited = false;
    let keyword = query.to_lowercase();
    for (source, result) in results {
        match result {
            Ok(items) => {
                if source == MarketProvider::Community {
                    community_limited = items.len() >= COMMUNITY_LIMIT;
                }
                skills.extend(items.into_iter().filter(|skill| {
                    source == MarketProvider::Community
                        || format!("{} {} {}", skill.name, skill.description, skill.repository)
                            .to_lowercase()
                            .contains(&keyword)
                }));
            }
            Err(reason) => warnings.push(MarketWarning {
                provider: source,
                reason,
            }),
        }
    }
    skills.sort_by(|a, b| {
        b.installs
            .unwrap_or(0)
            .cmp(&a.installs.unwrap_or(0))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(MarketSearch {
        skills,
        warnings,
        community_limited,
    })
}

fn skill_resources<'a>(
    entries: &'a [TreeEntry],
    directory: &str,
) -> Result<Vec<(&'a TreeEntry, String)>, String> {
    if !directory.is_empty() {
        validate_path(directory)?;
    }
    let prefix = if directory.is_empty() {
        String::new()
    } else {
        format!("{directory}/")
    };
    let mut paths = std::collections::HashSet::new();
    let mut files = Vec::new();
    let mut size = 0u64;
    for entry in entries {
        let Some(relative) = entry.path.strip_prefix(&prefix) else {
            continue;
        };
        if entry.kind == "tree" {
            continue;
        }
        validate_path(relative)?;
        if entry.kind != "blob" || !matches!(entry.mode.as_str(), "100644" | "100755") {
            return Err("Skills containing symlinks or submodules cannot be installed".into());
        }
        if !paths.insert(relative.to_lowercase()) {
            return Err("Skill contains conflicting resource paths".into());
        }
        size = size.saturating_add(entry.size);
        if entry.size > MAX_FILE as u64 || size > MAX_SKILL as u64 || files.len() >= MAX_FILES {
            return Err("Skill exceeds the download size or file count limit".into());
        }
        files.push((entry, relative.to_string()));
    }
    if !files.iter().any(|(_, path)| path == "SKILL.md") {
        return Err("Skill directory is missing SKILL.md".into());
    }
    Ok(files)
}

async fn detail_with_client(
    client: &Client,
    mut skill: MarketSkill,
) -> Result<MarketDetail, String> {
    validate_skill(&skill)?;
    let repo = snapshot(client, &skill.repository, None, false).await?;
    let candidates = repo
        .entries
        .iter()
        .filter(|entry| entry.path == "SKILL.md" || entry.path.ends_with("/SKILL.md"))
        .filter(|entry| {
            skill
                .provider
                .official()
                .is_none_or(|(_, prefix)| official_manifest(&entry.path, prefix))
        })
        .cloned()
        .collect::<Vec<_>>();
    if candidates.len() > 256 {
        return Err("Repository contains too many skills to resolve this selection".into());
    }
    let direct = candidates.iter().find(|entry| {
        entry.path.trim_end_matches("/SKILL.md").rsplit('/').next() == Some(skill.slug.as_str())
    });
    let (entry, content) = if let Some(entry) = direct {
        (
            entry.clone(),
            manifest(client, &skill.repository, &repo, entry).await?,
        )
    } else {
        // 社区 slug 可能来自 frontmatter，而非文件夹名（如 vercel-react-best-practices）。
        let repository = &skill.repository;
        let snapshot = &repo;
        let mut matches = stream::iter(candidates.into_iter().map(|entry| async move {
            let content = manifest(client, repository, snapshot, &entry).await?;
            Ok::<_, String>((entry, content))
        }))
        .buffer_unordered(6)
        .try_filter(|(_, content)| {
            std::future::ready(parse_skill_frontmatter(content).0 == skill.slug)
        })
        .try_collect::<Vec<_>>()
        .await?;
        if matches.len() != 1 {
            return Err("Could not resolve a unique SKILL.md for this skill".into());
        }
        matches.remove(0)
    };
    let directory = entry
        .path
        .strip_suffix("/SKILL.md")
        .unwrap_or("")
        .to_string();
    let files = skill_resources(&repo.entries, &directory)?;
    let (name, description) = parse_skill_frontmatter(&content);
    if !name.is_empty() {
        skill.name = name;
    }
    skill.description = description;
    let folder_name = if directory.is_empty() {
        skill.slug.clone()
    } else {
        directory.rsplit('/').next().unwrap_or_default().to_string()
    };
    validate_path(&folder_name)?;
    let source_url = format!(
        "https://github.com/{}/tree/{}/{}",
        skill.repository, repo.revision, directory
    );
    Ok(MarketDetail {
        skill,
        revision: repo.revision.clone(),
        directory,
        folder_name,
        content,
        file_count: files.len(),
        files: files.iter().map(|(_, path)| path.clone()).collect(),
        total_bytes: files.iter().map(|(entry, _)| entry.size).sum(),
        source_url,
    })
}

#[tauri::command]
pub async fn get_marketplace_skill_detail(
    skill: MarketSkill,
    database: State<'_, Arc<Database>>,
) -> Result<MarketDetail, String> {
    detail_with_client(&client(&database)?, skill).await
}

#[tauri::command]
pub async fn install_marketplace_skill(
    request: MarketInstallRequest,
    database: State<'_, Arc<Database>>,
) -> Result<Vec<SkillInfo>, String> {
    install_with_client(&client(&database)?, request).await
}

async fn install_with_client(
    client: &Client,
    request: MarketInstallRequest,
) -> Result<Vec<SkillInfo>, String> {
    validate_skill(&request.skill)?;
    if request.agents.is_empty() {
        return Err("Select at least one agent".into());
    }
    if let Some((_, prefix)) = request.skill.provider.official() {
        if !official_manifest(&format!("{}/SKILL.md", request.directory), prefix) {
            return Err("Skill directory does not match its provider".into());
        }
    }
    let repo = snapshot(
        client,
        &request.skill.repository,
        Some(&request.revision),
        false,
    )
    .await?;
    let entries = skill_resources(&repo.entries, &request.directory)?
        .into_iter()
        .map(|(entry, path)| (entry.clone(), path))
        .collect::<Vec<_>>();
    let folder = if request.directory.is_empty() {
        request.skill.slug.clone()
    } else {
        request
            .directory
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .to_string()
    };
    validate_path(&folder)?;
    // 临时目录只存本次下载，验证完成后复用本地安装器的预检和事务回滚。
    let staging = tempfile::tempdir().map_err(|error| error.to_string())?;
    let source = staging.path().join(&folder);
    fs::create_dir(&source).map_err(|error| error.to_string())?;
    let repository = &request.skill.repository;
    let revision = &repo.revision;
    let downloaded = stream::iter(entries.into_iter().map(|(entry, path)| async move {
        let bytes = resource(client, repository, revision, &entry).await?;
        Ok::<_, String>((path, bytes, entry.mode.clone()))
    }))
    .buffer_unordered(6)
    .try_collect::<Vec<_>>()
    .await?;
    if downloaded
        .iter()
        .map(|(_, bytes, _)| bytes.len())
        .sum::<usize>()
        > MAX_SKILL
    {
        return Err("Skill exceeds the download size limit".into());
    }
    let install = SkillInstallRequest {
        agents: request.agents,
        scope: request.scope,
        name: request.skill.name,
        description: request.skill.description,
        source_directory: Some(source.to_string_lossy().into()),
        project_path: request.project_path,
    };
    super::run_background_task("安装在线技能", move || {
        for (relative, bytes, mode) in downloaded {
            let path = source.join(&relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::write(&path, bytes).map_err(|error| error.to_string())?;
            set_executable(&path, &mode)?;
        }
        let result = install_skill(install);
        drop(staging);
        result
    })
    .await
}

#[cfg(unix)]
fn set_executable(path: &Path, mode: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(
        path,
        fs::Permissions::from_mode(if mode == "100755" { 0o755 } else { 0o644 }),
    )
    .map_err(|error| error.to_string())
}
#[cfg(not(unix))]
fn set_executable(_path: &Path, _mode: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str) -> TreeEntry {
        TreeEntry {
            path: path.into(),
            mode: "100644".into(),
            kind: "blob".into(),
            sha: String::new(),
            size: 10,
        }
    }

    #[test]
    fn rejects_traversal_and_windows_unsafe_paths() {
        for path in [
            "../x",
            "/tmp/x",
            "x\\y",
            "C:/x",
            "x:y",
            "x/./y",
            "x//y",
            "x/NUL.txt",
            "x/COM1",
            "x/FILE.",
            ".git/config",
        ] {
            assert!(validate_path(path).is_err(), "{path}");
        }
        assert!(validate_path("scripts/check.py").is_ok());
        assert!(validate_repository("vercel-labs/agent-skills").is_ok());
        assert!(validate_repository("https://github.com/a/b").is_err());
    }

    #[test]
    fn only_lists_direct_official_skill_folders() {
        assert!(official_manifest(
            "skills/.curated/review/SKILL.md",
            "skills/.curated/"
        ));
        assert!(!official_manifest(
            "skills/.system/review/SKILL.md",
            "skills/.curated/"
        ));
        assert!(!official_manifest(
            "skills/review/examples/SKILL.md",
            "skills/"
        ));
    }

    #[test]
    fn resources_stay_inside_selected_directory_and_include_assets() {
        let entries = vec![
            entry("skills/review/SKILL.md"),
            entry("skills/review/scripts/check.py"),
            entry("skills/reviewer/secret.txt"),
        ];
        let files = skill_resources(&entries, "skills/review").expect("resources");
        assert_eq!(
            files
                .iter()
                .map(|(_, path)| path.as_str())
                .collect::<Vec<_>>(),
            ["SKILL.md", "scripts/check.py"]
        );
        assert!(skill_resources(&entries, "skills/missing").is_err());
    }

    #[test]
    fn rejects_symlinks_submodules_case_collisions_and_oversized_resources() {
        for (mode, kind) in [("120000", "blob"), ("160000", "commit")] {
            let mut link = entry("review/link");
            link.mode = mode.into();
            link.kind = kind.into();
            assert!(skill_resources(&[entry("review/SKILL.md"), link], "review").is_err());
        }
        assert!(skill_resources(
            &[
                entry("review/SKILL.md"),
                entry("review/a"),
                entry("review/A")
            ],
            "review"
        )
        .is_err());
        let mut large = entry("review/large");
        large.size = MAX_FILE as u64 + 1;
        assert!(skill_resources(&[entry("review/SKILL.md"), large], "review").is_err());
    }

    #[test]
    fn normalizes_community_ids_without_guessing_repository_paths() {
        let results = CommunityResults {
            skills: vec![
                CommunitySkill {
                    id: "vercel-labs/agent-skills/vercel-react-best-practices".into(),
                    source: "vercel-labs/agent-skills".into(),
                    name: "React".into(),
                    installs: 42,
                },
                CommunitySkill {
                    id: "example.com/review".into(),
                    source: "example.com".into(),
                    name: "Review".into(),
                    installs: 1,
                },
            ],
        };
        let skills = community_skills(results);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].slug, "vercel-react-best-practices");
        assert_eq!(skills[0].installs, Some(42));
    }

    #[test]
    #[ignore = "访问真实 GitHub / skills.sh，只写入临时项目目录"]
    fn live_marketplace_search_preview_and_install() {
        tauri::async_runtime::block_on(async {
            let proxy = crate::network_proxy::resolve_network_proxy(
                &crate::network_proxy::NetworkProxySettings::default(),
            )
            .expect("proxy");
            let client = crate::network_proxy::apply_proxy_to_client_builder(
                Client::builder()
                    .no_proxy()
                    .user_agent("Termflow marketplace integration check")
                    .timeout(Duration::from_secs(30)),
                &proxy,
            )
            .expect("builder")
            .build()
            .expect("client");
            let results = search_with_client(&client, "react", None, false)
                .await
                .expect("search");
            for warning in &results.warnings {
                eprintln!("{:?}: {}", warning.provider, warning.reason);
            }
            assert!(results.warnings.is_empty(), "all providers are reachable");
            for provider in [MarketProvider::Openai, MarketProvider::Anthropic] {
                let skills = official_skills(&client, provider, false)
                    .await
                    .expect("official catalog");
                assert!(!skills.is_empty());
                let detail = detail_with_client(&client, skills[0].clone())
                    .await
                    .expect("official preview");
                assert!(detail.content.contains("description:"));
            }
            let community = results
                .skills
                .into_iter()
                .find(|skill| {
                    skill.repository == "vercel-labs/agent-skills"
                        && skill.slug == "vercel-react-best-practices"
                })
                .expect("community search result");
            let detail = detail_with_client(&client, community)
                .await
                .expect("resolve frontmatter name to folder");
            assert!(detail.file_count > 1, "supporting resources are included");
            let repo = snapshot(
                &client,
                &detail.skill.repository,
                Some(&detail.revision),
                false,
            )
            .await
            .expect("pinned snapshot");
            let resources =
                skill_resources(&repo.entries, &detail.directory).expect("resource manifest");
            let project = tempfile::tempdir().expect("temporary project");
            let request = MarketInstallRequest {
                skill: detail.skill,
                revision: detail.revision,
                directory: detail.directory,
                agents: vec![SkillAgent::Codex, SkillAgent::Pi, SkillAgent::Claude],
                scope: SkillScope::Workspace,
                project_path: Some(project.path().to_string_lossy().into()),
            };
            let installed = install_with_client(&client, request)
                .await
                .expect("install full skill");
            assert_eq!(
                installed.len(),
                2,
                "shared Codex / Pi destination is written once"
            );
            for skill in installed {
                let content = fs::read_to_string(&skill.file_path).expect("installed manifest");
                assert_eq!(
                    content, detail.content,
                    "installation matches preview revision"
                );
                let directory = Path::new(&skill.file_path)
                    .parent()
                    .expect("skill directory");
                for (entry, relative) in &resources {
                    let bytes =
                        fs::read(directory.join(relative)).expect("installed supporting resource");
                    assert_eq!(
                        git2::Oid::hash_object(git2::ObjectType::Blob, &bytes)
                            .expect("hash")
                            .to_string(),
                        entry.sha
                    );
                }
            }
        });
    }
}
