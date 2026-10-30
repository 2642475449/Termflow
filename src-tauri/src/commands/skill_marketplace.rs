use super::skills::parse_skill_frontmatter;
use crate::database::Database;
use futures_util::{stream, StreamExt, TryStreamExt};
use reqwest::Client;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant},
};
use tauri::State;

mod http_security;
use http_security::{preview_client, preview_url, redirect_policy};

const CACHE_TTL: Duration = Duration::from_secs(600);
const MAX_FILE: usize = 5 * 1024 * 1024;
const MAX_MANIFEST: usize = 256 * 1024;
const MAX_MANIFEST_TOTAL: usize = 20 * 1024 * 1024;
const MAX_SKILL: usize = 50 * 1024 * 1024;
const MAX_FILES: usize = 1024;
const COMMUNITY_LIMIT: usize = 50;
const SKILL_NOT_FOUND: &str = "marketplace_skill_not_found";
const SKILL_AMBIGUOUS: &str = "marketplace_skill_ambiguous";
const PREVIEW_UNAVAILABLE: &str = "marketplace_preview_unavailable";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSkill {
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
    limited: bool,
    next_page: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSummary {
    repository: String,
    slug: String,
    description: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketDetail {
    pub skill: MarketSkill,
    pub content: String,
    pub file_count: usize,
    pub files: Vec<String>,
    pub total_bytes: u64,
    pub source_url: String,
    pub preview_only: bool,
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
static SUMMARIES: LazyLock<Cache<String>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static DETAILS: LazyLock<Cache<MarketDetail>> = LazyLock::new(|| Mutex::new(HashMap::new()));

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

fn invalidate_latest_snapshot(repository: &str) {
    if let Ok(mut entries) = REPOSITORIES.lock() {
        entries.remove(&format!("{repository}@HEAD"));
    }
}

fn client(database: &State<'_, Arc<Database>>) -> Result<Client, String> {
    let proxy = super::network_proxy::load_resolved_proxy(database)?;
    crate::network_proxy::apply_proxy_to_client_builder(
        Client::builder()
            .no_proxy()
            .https_only(true)
            .redirect(redirect_policy(true))
            .user_agent("Termflow skill marketplace")
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30)),
        &proxy,
    )?
    .build()
    .map_err(|error| error.to_string())
}

async fn read_bytes(client: &Client, url: reqwest::Url, limit: usize) -> Result<Vec<u8>, String> {
    let started = Instant::now();
    let budget = Duration::from_secs(35);
    for attempt in 1..=3 {
        let remaining = budget.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err(format!(
                "Response from {} timed out after retries",
                url.host_str().unwrap_or("remote service")
            ));
        }
        match read_bytes_once(
            client,
            url.clone(),
            limit,
            remaining.min(Duration::from_secs(30)),
        )
        .await
        {
            Ok(bytes) => return Ok(bytes),
            Err(failure) => {
                if !failure.retryable || attempt == 3 || started.elapsed() >= budget {
                    return Err(format!(
                        "{} (host: {}, attempts: {attempt})",
                        failure.message,
                        url.host_str().unwrap_or("remote service")
                    ));
                }
                tokio::time::sleep(Duration::from_millis(250 * attempt)).await;
            }
        }
    }
    Err("Response retry limit reached".into())
}

struct ResponseReadFailure {
    message: String,
    retryable: bool,
}

impl ResponseReadFailure {
    fn permanent(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
        }
    }

    fn transport(stage: &str, error: reqwest::Error) -> Self {
        let retryable =
            error.is_timeout() || error.is_connect() || error.is_body() || error.is_decode();
        // Display 只显示泛化错误；保留 source 链，去掉可能包含敏感参数的 URL。
        let error = error.without_url();
        let mut message = format!("{stage}: {error}");
        let mut source = std::error::Error::source(&error);
        while let Some(cause) = source {
            message.push_str(&format!(": {cause}"));
            source = cause.source();
        }
        Self { message, retryable }
    }
}

async fn read_bytes_once(
    client: &Client,
    url: reqwest::Url,
    limit: usize,
    timeout: Duration,
) -> Result<Vec<u8>, ResponseReadFailure> {
    let mut response = client
        .get(url)
        .timeout(timeout)
        .send()
        .await
        .map_err(|error| ResponseReadFailure::transport("Network request failed", error))?;
    let status = response.status();
    if !status.is_success() {
        let rate_limited = status.as_u16() == 429
            || (status.as_u16() == 403
                && response
                    .headers()
                    .get("x-ratelimit-remaining")
                    .is_some_and(|value| value == "0"));
        return Err(ResponseReadFailure {
            message: if rate_limited {
                "Service rate limit reached; please retry later".into()
            } else {
                format!("Service returned HTTP {status}")
            },
            retryable: !rate_limited && (status.is_server_error() || status.as_u16() == 408),
        });
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(ResponseReadFailure::permanent(
            "Remote response exceeds the size limit",
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| ResponseReadFailure::transport("Response body read failed", error))?
    {
        if bytes.len() + chunk.len() > limit {
            return Err(ResponseReadFailure::permanent(
                "Remote response exceeds the size limit",
            ));
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
    validate_listing_skill(skill)
}

// 目录允许域名来源；GitHub 内容预览另行验证仓库格式。
fn validate_listing_skill(skill: &MarketSkill) -> Result<(), String> {
    let parts: Vec<_> = skill.repository.split('/').collect();
    if !(1..=2).contains(&parts.len())
        || parts.iter().any(|part| {
            part.is_empty()
                || part.len() > 100
                || part.starts_with('.')
                || !part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
    {
        return Err("Invalid skill source".into());
    }
    validate_path(&skill.slug)?;
    if skill.slug.contains('/') {
        return Err("Invalid skill identifier".into());
    }
    Ok(())
}

async fn snapshot(
    client: &Client,
    repository: &str,
    revision: Option<&str>,
) -> Result<RepositorySnapshot, String> {
    validate_repository(repository)?;
    let key = format!("{repository}@{}", revision.unwrap_or("HEAD"));
    if let Some(item) = cached(&REPOSITORIES, &key) {
        return Ok(item);
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
        || entry.size > MAX_MANIFEST as u64
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
    let bytes = read_bytes(client, url, MAX_MANIFEST).await?;
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

#[derive(Deserialize)]
struct CommunityResults {
    skills: Vec<CommunitySkill>,
    #[serde(default, rename = "hasMore")]
    has_more: bool,
}
#[derive(Deserialize)]
struct CommunitySkill {
    #[serde(default)]
    id: String,
    #[serde(default, rename = "skillId")]
    skill_id: String,
    source: String,
    name: String,
    installs: u64,
    #[serde(default)]
    description: String,
}

fn community_skills(results: CommunityResults) -> Vec<MarketSkill> {
    results
        .skills
        .into_iter()
        .filter_map(|entry| {
            let slug = if entry.id.is_empty() {
                entry.skill_id
            } else {
                entry
                    .id
                    .strip_prefix(&format!("{}/", entry.source))?
                    .to_string()
            };
            let skill = MarketSkill {
                repository: entry.source,
                slug,
                name: entry.name,
                description: entry.description,
                installs: Some(entry.installs),
            };
            validate_listing_skill(&skill).ok()?;
            Some(skill)
        })
        .collect()
}

fn community_url(query: &str, page: u32) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(if query.is_empty() {
        "https://skills.sh/api/skills/all-time/0"
    } else {
        "https://skills.sh/api/search"
    })
    .map_err(|error| error.to_string())?;
    if query.is_empty() {
        url.set_path(&format!("/api/skills/all-time/{page}"));
    } else if page != 0 {
        return Err("Search pagination is not supported".into());
    }
    if !query.is_empty() {
        url.query_pairs_mut()
            .append_pair("q", query)
            .append_pair("limit", &COMMUNITY_LIMIT.to_string());
    }
    Ok(url)
}

async fn search_community(client: &Client, query: &str, page: u32) -> Result<MarketSearch, String> {
    let url = community_url(query, page)?;
    let results = serde_json::from_slice::<CommunityResults>(
        &read_bytes(client, url, 2 * 1024 * 1024).await?,
    )
    .map_err(|error| format!("Invalid skills.sh search response: {error}"))?;
    let limited = if query.is_empty() {
        results.has_more
    } else {
        results.skills.len() >= COMMUNITY_LIMIT
    };
    let next_page = if query.is_empty() && results.has_more {
        page.checked_add(1)
    } else {
        None
    };
    Ok(MarketSearch {
        skills: community_skills(results),
        limited,
        next_page,
    })
}

#[tauri::command]
pub async fn search_skill_marketplace(
    query: String,
    page: Option<u32>,
    database: State<'_, Arc<Database>>,
) -> Result<MarketSearch, String> {
    let client = client(&database)?;
    search_with_client(&client, &query, page.unwrap_or(0)).await
}

async fn search_with_client(
    client: &Client,
    query: &str,
    page: u32,
) -> Result<MarketSearch, String> {
    let query = query.trim();
    let query_length = query.chars().count();
    if query_length > 200 {
        return Err("Search query is too long".into());
    }
    if query_length == 1 {
        return Ok(MarketSearch {
            skills: Vec::new(),
            limited: false,
            next_page: None,
        });
    }
    let mut results = search_community(client, query, page).await?;
    results.skills.sort_by(|a, b| {
        b.installs
            .unwrap_or(0)
            .cmp(&a.installs.unwrap_or(0))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(results)
}

fn listing_description(html: &str) -> Option<String> {
    let tags = regex::Regex::new(r"(?is)<meta\s+[^>]*>").ok()?;
    let attributes = regex::Regex::new(r#"(?is)([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')"#).ok()?;
    let entities = regex::Regex::new(r"&(?:#x[0-9a-fA-F]+|#[0-9]+|amp|quot|apos|lt|gt);").ok()?;
    for tag in tags.find_iter(html) {
        let attrs = attributes
            .captures_iter(tag.as_str())
            .filter_map(|capture| {
                Some((
                    capture[1].to_lowercase(),
                    capture
                        .get(2)
                        .or_else(|| capture.get(3))?
                        .as_str()
                        .to_string(),
                ))
            })
            .collect::<HashMap<_, _>>();
        if attrs
            .get("name")
            .or_else(|| attrs.get("property"))
            .is_some_and(|value| value == "description" || value == "og:description")
        {
            let content = attrs.get("content")?;
            let decoded =
                entities.replace_all(content, |capture: &regex::Captures<'_>| match &capture[0] {
                    "&amp;" => "&".into(),
                    "&quot;" => "\"".into(),
                    "&apos;" => "'".into(),
                    "&lt;" => "<".into(),
                    "&gt;" => ">".into(),
                    entity => {
                        let value = entity.trim_start_matches("&#").trim_end_matches(';');
                        let number = if let Some(hex) = value.strip_prefix('x') {
                            u32::from_str_radix(hex, 16).ok()
                        } else {
                            value.parse::<u32>().ok()
                        };
                        number
                            .and_then(char::from_u32)
                            .map(|c| c.to_string())
                            .unwrap_or_else(|| entity.to_string())
                    }
                });
            let description = decoded
                .trim()
                .chars()
                .filter(|c| *c != '\u{fffd}')
                .take(500)
                .collect::<String>();
            if !description.is_empty() {
                return Some(description);
            }
        }
    }
    None
}

#[tauri::command]
pub async fn get_marketplace_skill_summaries(
    skills: Vec<MarketSkill>,
    database: State<'_, Arc<Database>>,
) -> Result<Vec<MarketSummary>, String> {
    if skills.len() > 24 {
        return Err("Too many skill summaries requested".into());
    }
    for skill in &skills {
        validate_listing_skill(skill)?;
    }
    let client = client(&database)?;
    let summaries = stream::iter(skills.into_iter().map(|skill| {
        let client = &client;
        async move {
            let key = format!("{}/{}", skill.repository, skill.slug);
            let description = if let Some(description) = cached(&SUMMARIES, &key) {
                Some(description)
            } else {
                let url = reqwest::Url::parse(&format!("https://skills.sh/{key}")).ok()?;
                let html =
                    String::from_utf8(read_bytes(client, url, 2 * 1024 * 1024).await.ok()?).ok()?;
                let description = listing_description(&html)?;
                remember(&SUMMARIES, key, description.clone());
                Some(description)
            }?;
            Some(MarketSummary {
                repository: skill.repository,
                slug: skill.slug,
                description,
            })
        }
    }))
    .buffer_unordered(6)
    .collect::<Vec<_>>()
    .await;
    Ok(summaries.into_iter().flatten().collect())
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
            return Err("Skill contains unsupported resource links or submodules".into());
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

async fn matching_manifest<S>(
    slug: &str,
    candidates: S,
) -> Result<(TreeEntry, String), String>
where
    S: futures_util::Stream<Item = Result<(TreeEntry, String), String>>,
{
    futures_util::pin_mut!(candidates);
    let mut selected = None;
    let mut total = 0usize;
    while let Some((entry, content)) = candidates.try_next().await? {
        total = total.saturating_add(content.len());
        if content.len() > MAX_MANIFEST || total > MAX_MANIFEST_TOTAL {
            return Err("Skill manifest resolution exceeds the download size limit".into());
        }
        if parse_skill_frontmatter(&content).0 == slug {
            if selected.is_some() {
                return Err(SKILL_AMBIGUOUS.into());
            }
            selected = Some((entry, content));
        }
        // 不匹配的清单在本轮立即释放，只保留唯一候选和有界的在途请求。
    }
    selected.ok_or_else(|| SKILL_NOT_FOUND.to_string())
}

fn validate_manifest_candidates(candidates: &[TreeEntry]) -> Result<(), String> {
    let total = candidates.iter().fold(0u64, |total, entry| total.saturating_add(entry.size));
    if candidates.len() > 256
        || candidates.iter().any(|entry| entry.size > MAX_MANIFEST as u64)
        || total > MAX_MANIFEST_TOTAL as u64
    {
        return Err("Skill manifest resolution exceeds the download size or file count limit".into());
    }
    Ok(())
}

async fn resolve_manifest(
    client: &Client,
    skill: &MarketSkill,
    repo: &RepositorySnapshot,
) -> Result<(TreeEntry, String), String> {
    let candidates = repo
        .entries
        .iter()
        .filter(|entry| entry.path == "SKILL.md" || entry.path.ends_with("/SKILL.md"))
        .cloned()
        .collect::<Vec<_>>();
    let direct = candidates
        .iter()
        .filter(|entry| {
            entry
                .path
                .strip_suffix("/SKILL.md")
                .and_then(|directory| directory.rsplit('/').next())
                == Some(skill.slug.as_str())
        })
        .cloned()
        .collect::<Vec<_>>();
    if direct.len() == 1 {
        validate_manifest_candidates(&direct)?;
        let entry = direct
            .into_iter()
            .next()
            .ok_or_else(|| SKILL_NOT_FOUND.to_string())?;
        let content = manifest(client, &skill.repository, repo, &entry).await?;
        return Ok((entry, content));
    }
    // 多个同名目录不能任取第一个；先通过 frontmatter 消歧。
    let ambiguous_directory = direct.len() > 1;
    let candidates = if ambiguous_directory {
        direct
    } else {
        candidates
    };
    validate_manifest_candidates(&candidates)?;
    let contents = stream::iter(candidates.into_iter().map(|entry| async move {
        let content = manifest(client, &skill.repository, repo, &entry).await?;
        Ok::<_, String>((entry, content))
    }))
    .buffer_unordered(6);
    matching_manifest(&skill.slug, contents).await.map_err(|reason| {
        if ambiguous_directory && reason == SKILL_NOT_FOUND {
            SKILL_AMBIGUOUS.into()
        } else {
            reason
        }
    })
}

async fn detail_with_client(
    client: &Client,
    mut skill: MarketSkill,
) -> Result<MarketDetail, String> {
    validate_listing_skill(&skill)?;
    if !skill.repository.contains('/') {
        return well_known_detail(skill).await;
    }
    validate_skill(&skill)?;
    let repo = match snapshot(client, &skill.repository, None).await {
        Ok(repo) => repo,
        Err(reason) => return fallback_preview(client, skill, reason).await,
    };
    let (entry, content) = match resolve_manifest(client, &skill, &repo).await {
        Ok(manifest) => manifest,
        Err(reason) => return fallback_preview(client, skill, reason).await,
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
    let source_url = format!(
        "https://github.com/{}/tree/{}/{}",
        skill.repository, repo.revision, directory
    );
    Ok(MarketDetail {
        skill,
        content,
        file_count: files.len(),
        files: files.iter().map(|(_, path)| path.clone()).collect(),
        total_bytes: files.iter().map(|(entry, _)| entry.size).sum(),
        source_url,
        preview_only: false,
    })
}

fn fallback_paths(slug: &str) -> Vec<String> {
    [
        format!("skills/{slug}/SKILL.md"),
        format!(".agents/skills/{slug}/SKILL.md"),
        format!(".claude/skills/{slug}/SKILL.md"),
        format!("{slug}/SKILL.md"),
        "SKILL.md".into(),
    ]
    .into()
}

fn manifest_preview(
    mut skill: MarketSkill,
    path: &str,
    content: String,
) -> Result<MarketDetail, String> {
    validate_skill(&skill)?;
    validate_path(path)?;
    let (name, description) = parse_skill_frontmatter(&content);
    if name != skill.slug {
        return Err(SKILL_NOT_FOUND.into());
    }
    skill.name = name;
    skill.description = description;
    Ok(MarketDetail {
        source_url: format!("https://github.com/{}/blob/HEAD/{path}", skill.repository),
        skill,
        total_bytes: content.len() as u64,
        content,
        files: Vec::new(),
        file_count: 0,
        preview_only: true,
    })
}

async fn fallback_preview(
    client: &Client,
    skill: MarketSkill,
    original_error: String,
) -> Result<MarketDetail, String> {
    // 仅在传输或服务故障时降级；不存在、歧义、完整性校验失败仍保留原判定。
    if ![
        "Network request failed",
        "Response body read failed",
        "Service rate limit",
        "Service returned HTTP 5",
        "Service returned HTTP 408",
        "Invalid service response",
        "timed out after retries",
    ]
    .iter()
    .any(|message| original_error.contains(message))
    {
        return Err(original_error);
    }
    let mut candidates = stream::iter(fallback_paths(&skill.slug).into_iter().map(|path| {
        let skill = &skill;
        async move {
            let url = reqwest::Url::parse(&format!(
                "https://raw.githubusercontent.com/{}/HEAD/{path}",
                skill.repository
            ))
            .ok()?;
            let content = String::from_utf8(read_bytes(client, url, MAX_MANIFEST).await.ok()?).ok()?;
            manifest_preview(skill.clone(), &path, content).ok()
        }
    }))
    .buffered(3);
    while let Some(detail) = candidates.next().await {
        if let Some(detail) = detail {
            return Ok(detail);
        }
    }
    Err(original_error)
}

// 只读取索引和 SKILL.md，不写文件、不下载资源包，也不执行 CLI。
fn well_known_manifest(
    index: serde_json::Value,
    index_url: &reqwest::Url,
    slug: &str,
) -> Result<(reqwest::Url, Vec<String>, Option<String>), String> {
    let entries = index
        .get("skills")
        .and_then(|value| value.as_array())
        .ok_or("Invalid skill index")?;
    let mut matches = entries
        .iter()
        .filter(|entry| entry.get("name").and_then(|name| name.as_str()) == Some(slug));
    let entry = matches.next().ok_or(SKILL_NOT_FOUND)?;
    if matches.next().is_some() {
        return Err(SKILL_AMBIGUOUS.into());
    }
    if let Some(schema) = index.get("$schema") {
        if schema.as_str() != Some("https://schemas.agentskills.io/discovery/0.2.0/schema.json")
            || entry.get("type").and_then(|value| value.as_str()) != Some("skill-md")
        {
            return Err(PREVIEW_UNAVAILABLE.into());
        }
        let artifact = entry
            .get("url")
            .and_then(|value| value.as_str())
            .ok_or("Missing skill URL")?;
        let digest = entry
            .get("digest")
            .and_then(|value| value.as_str())
            .ok_or("Missing skill digest")?;
        let hash = digest
            .strip_prefix("sha256:")
            .ok_or("Invalid skill digest")?;
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Invalid skill digest".into());
        }
        return Ok((
            preview_url(
                index_url
                    .join(artifact)
                    .map_err(|error| error.to_string())?,
            )?,
            vec!["SKILL.md".into()],
            Some(digest.to_ascii_lowercase()),
        ));
    }
    let files = entry
        .get("files")
        .and_then(|value| value.as_array())
        .ok_or("Missing skill file list")?;
    if files.len() > MAX_FILES {
        return Err("Too many skill resources".into());
    }
    let files = files
        .iter()
        .map(|file| {
            let path = file.as_str().ok_or("Invalid skill resource path")?;
            validate_path(path)?;
            Ok(path.to_string())
        })
        .collect::<Result<Vec<_>, String>>()?;
    let manifest = files
        .iter()
        .find(|path| path.eq_ignore_ascii_case("SKILL.md"))
        .ok_or(SKILL_NOT_FOUND)?;
    let mut url = index_url.join("./").map_err(|error| error.to_string())?;
    url.path_segments_mut()
        .map_err(|_| "Invalid skill URL")?
        .pop_if_empty()
        .push(slug)
        .push(manifest);
    Ok((preview_url(url)?, files, None))
}

async fn well_known_detail(
    mut skill: MarketSkill,
) -> Result<MarketDetail, String> {
    let client = preview_client()?;
    let root = preview_url(
        reqwest::Url::parse(&format!("https://{}/", skill.repository))
            .map_err(|error| error.to_string())?,
    )?;
    let mut last_error = SKILL_NOT_FOUND.to_string();
    for path in [
        ".well-known/agent-skills/index.json",
        ".well-known/skills/index.json",
    ] {
        let index_url = root.join(path).map_err(|error| error.to_string())?;
        let bytes = match read_bytes(&client, index_url.clone(), 2 * 1024 * 1024).await {
            Ok(bytes) => bytes,
            Err(reason) => {
                last_error = reason;
                continue;
            }
        };
        let index = match serde_json::from_slice(&bytes) {
            Ok(index) => index,
            Err(_) => {
                last_error = "Invalid skill index".into();
                continue;
            }
        };
        let (url, files, digest) = match well_known_manifest(index, &index_url, &skill.slug) {
            Ok(manifest) => manifest,
            Err(reason) if reason == SKILL_NOT_FOUND => {
                last_error = reason;
                continue;
            }
            Err(reason) => return Err(reason),
        };
        let bytes = read_bytes(&client, url.clone(), MAX_MANIFEST).await?;
        if digest.is_some_and(|expected| expected != format!("sha256:{:x}", Sha256::digest(&bytes)))
        {
            return Err("Skill preview failed integrity verification".into());
        }
        let total_bytes = bytes.len() as u64;
        let content = String::from_utf8(bytes).map_err(|_| "SKILL.md must be UTF-8 text")?;
        let (name, description) = parse_skill_frontmatter(&content);
        if name.is_empty() {
            return Err("Invalid SKILL.md content".into());
        }
        skill.name = name;
        skill.description = description;
        return Ok(MarketDetail {
            skill,
            content,
            file_count: files.len(),
            files,
            total_bytes,
            source_url: url.to_string(),
            preview_only: false,
        });
    }
    Err(last_error)
}

#[tauri::command]
pub async fn get_marketplace_skill_detail(
    skill: MarketSkill,
    refresh: Option<bool>,
    database: State<'_, Arc<Database>>,
) -> Result<MarketDetail, String> {
    validate_listing_skill(&skill)?;
    let key = format!("{}/{}", skill.repository, skill.slug);
    if refresh.unwrap_or(false) {
        invalidate_latest_snapshot(&skill.repository);
        if let Ok(mut entries) = DETAILS.lock() {
            entries.remove(&key);
        }
    } else if let Some(detail) = cached(&DETAILS, &key) {
        return Ok(detail);
    }
    let detail = detail_with_client(&client(&database)?, skill).await?;
    remember(&DETAILS, key, detail.clone());
    Ok(detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matching_manifest(slug: &str, candidates: Vec<(TreeEntry, String)>) -> Result<(TreeEntry, String), String> {
        tauri::async_runtime::block_on(super::matching_manifest(slug, stream::iter(candidates.into_iter().map(Ok))))
    }

    #[test]
    fn manifest_metadata_limits_are_checked_before_downloading() {
        let mut manifest = entry("skills/review/SKILL.md");
        manifest.size = MAX_MANIFEST as u64 + 1;
        assert!(validate_manifest_candidates(&[manifest]).is_err());
        let mut manifest = entry("skills/review/SKILL.md");
        manifest.size = MAX_MANIFEST as u64;
        assert!(validate_manifest_candidates(&vec![manifest.clone(); 80]).is_ok());
        assert!(validate_manifest_candidates(&vec![manifest; 81]).is_err());
        assert!(validate_manifest_candidates(&vec![entry("SKILL.md"); 257]).is_err());
    }

    #[test]
    fn manifest_stream_stops_at_actual_byte_budget_and_preserves_ambiguity_detection() {
        tauri::async_runtime::block_on(async {
            let mut consumed = 0;
            let candidates = stream::iter((0..256).map(|index| {
                consumed += 1;
                let mut content = named_manifest("SKILL.md", "other").1;
                content.push_str(&"x".repeat(MAX_MANIFEST - content.len()));
                Ok((entry(&format!("{index}/SKILL.md")), content))
            }));
            let error = super::matching_manifest("review", candidates).await.err().expect("budget exhausted");
            assert!(error.contains("download size limit"));
            assert_eq!(consumed, 81);
            let mut consumed = 0;
            let candidates = stream::iter((0..256).map(|index| {
                consumed += 1;
                Ok(named_manifest(&format!("{index}/SKILL.md"), "review"))
            }));
            assert_eq!(super::matching_manifest("review", candidates).await.err().as_deref(), Some(SKILL_AMBIGUOUS));
            assert_eq!(consumed, 2);
        });
    }

    #[test]
    fn fallback_preview_requires_exact_manifest_identity_and_does_not_invent_resource_lists() {
        let skill = MarketSkill {
            repository: "owner/skills".into(),
            slug: "review".into(),
            name: "review".into(),
            description: String::new(),
            installs: None,
        };
        let detail = manifest_preview(
            skill.clone(),
            "skills/review/SKILL.md",
            "---\nname: review\ndescription: Review code\n---\nInstructions".into(),
        )
        .expect("preview");
        assert!(detail.preview_only);
        assert!(detail.files.is_empty());
        assert_eq!(detail.file_count, 0);
        assert_eq!(detail.skill.description, "Review code");
        assert!(manifest_preview(
            skill.clone(),
            "skills/review/SKILL.md",
            "---\nname: other\n---\nWrong skill".into()
        )
        .is_err());
        assert!(manifest_preview(skill, "../SKILL.md", "---\nname: review\n---\n".into()).is_err());
        assert!(fallback_paths("review")
            .iter()
            .all(|path| validate_path(path).is_ok() && path.ends_with("SKILL.md")));
    }

    #[test]
    fn missing_ambiguous_and_integrity_failures_cannot_use_the_fallback() {
        tauri::async_runtime::block_on(async {
            for reason in [
                SKILL_NOT_FOUND,
                SKILL_AMBIGUOUS,
                "Skill resource failed integrity verification",
            ] {
                let skill = MarketSkill {
                    repository: "owner/skills".into(),
                    slug: "review".into(),
                    name: "review".into(),
                    description: String::new(),
                    installs: None,
                };
                assert_eq!(
                    fallback_preview(&Client::new(), skill, reason.into())
                        .await
                        .err()
                        .as_deref(),
                    Some(reason)
                );
            }
        });
    }

    fn response_server(
        responses: Vec<&'static str>,
    ) -> (reqwest::Url, std::thread::JoinHandle<usize>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("local server");
        let url = reqwest::Url::parse(&format!(
            "http://{}/skill",
            listener.local_addr().expect("address")
        ))
        .expect("URL");
        listener.set_nonblocking(true).expect("nonblocking");
        let task = std::thread::spawn(move || {
            let mut count = 0;
            for response in responses {
                let deadline = Instant::now() + Duration::from_secs(5);
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(error)
                            if error.kind() == std::io::ErrorKind::WouldBlock
                                && Instant::now() < deadline =>
                        {
                            std::thread::sleep(Duration::from_millis(10))
                        }
                        _ => return count,
                    }
                };
                // Windows accept 会继承监听套接字的非阻塞属性；请求头读取使用下方超时。
                socket.set_nonblocking(false).expect("blocking request socket");
                socket
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .expect("read timeout");
                // TCP 一次 read 不保证包含完整请求头；提前关闭带未读数据的连接在 Windows 会触发 RST。
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut chunk = [0; 1024];
                    let count = socket.read(&mut chunk).expect("read request");
                    assert!(count > 0 && request.len() + count <= 16 * 1024, "complete request headers");
                    request.extend_from_slice(&chunk[..count]);
                }
                socket
                    .write_all(response.as_bytes())
                    .expect("write response");
                count += 1;
            }
            count
        });
        (url, task)
    }

    #[test]
    fn interrupted_response_is_retried_without_reusing_partial_bytes() {
        tauri::async_runtime::block_on(async {
            let (url, server) = response_server(vec![
                "HTTP/1.1 200 OK\r\nContent-Length: 20\r\nConnection: close\r\n\r\npartial",
                "HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\ncomplete",
            ]);
            let client = Client::builder().no_proxy().build().expect("client");
            assert_eq!(
                read_bytes(&client, url, 100).await.expect("retry succeeds"),
                b"complete"
            );
            assert_eq!(server.join().expect("server"), 2);
        });
    }

    #[test]
    fn persistent_body_failure_has_bounded_retries_and_diagnostics() {
        tauri::async_runtime::block_on(async {
            let (url, server) = response_server(vec![
                    "HTTP/1.1 200 OK\r\nContent-Length: 20\r\nConnection: close\r\n\r\npartial";
                    3
                ]);
            let client = Client::builder().no_proxy().build().expect("client");
            let error = read_bytes(&client, url, 100)
                .await
                .expect_err("truncated body");
            assert!(error.contains("Response body read failed"), "{error}");
            assert!(error.contains("host: 127.0.0.1, attempts: 3"), "{error}");
            assert_eq!(server.join().expect("server"), 3);
        });
    }

    #[test]
    fn temporary_server_failure_is_retried() {
        tauri::async_runtime::block_on(async {
            let (url, server) = response_server(vec![
                "HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
            ]);
            let client = Client::builder().no_proxy().build().expect("client");
            assert_eq!(
                read_bytes(&client, url, 100).await.expect("retry succeeds"),
                b"ok"
            );
            assert_eq!(server.join().expect("server"), 2);
        });
    }

    #[test]
    fn permanent_http_errors_rate_limits_and_size_limits_are_not_retried() {
        tauri::async_runtime::block_on(async {
            for response in [
                "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                "HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                "HTTP/1.1 200 OK\r\nContent-Length: 20\r\nConnection: close\r\n\r\noversized content!!!",
            ] {
                let (url, server) = response_server(vec![response]);
                let client = Client::builder().no_proxy().build().expect("client");
                let error = read_bytes(&client, url, 10).await.expect_err("permanent failure");
                assert!(error.contains("attempts: 1"), "{error}");
                assert_eq!(server.join().expect("server"), 1);
            }
        });
    }

    fn entry(path: &str) -> TreeEntry {
        TreeEntry {
            path: path.into(),
            mode: "100644".into(),
            kind: "blob".into(),
            sha: String::new(),
            size: 10,
        }
    }

    fn named_manifest(path: &str, name: &str) -> (TreeEntry, String) {
        (
            entry(path),
            format!("---\nname: {name}\ndescription: Example skill\n---\n"),
        )
    }

    #[test]
    fn default_browse_uses_the_public_leaderboard_and_preserves_its_skill_ids() {
        assert_eq!(
            community_url("", 0).expect("browse URL").path(),
            "/api/skills/all-time/0"
        );
        assert_eq!(
            community_url("", 3).expect("next browse URL").path(),
            "/api/skills/all-time/3"
        );
        assert!(community_url("react", 1).is_err());
        assert_eq!(
            community_url("react native", 0)
                .expect("search URL")
                .query_pairs()
                .find(|(key, _)| key == "q")
                .map(|(_, value)| value.to_string()),
            Some("react native".into())
        );
        let results: CommunityResults = serde_json::from_str(r#"{"skills":[{"source":"vercel-labs/skills","skillId":"find-skills","name":"find-skills","installs":123}],"hasMore":true}"#).expect("leaderboard response");
        assert!(results.has_more);
        let skills = community_skills(results);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].slug, "find-skills");
    }

    #[test]
    fn listing_metadata_is_plain_text_and_decodes_quotes_and_entities() {
        assert_eq!(listing_description(r#"<meta content="React's &quot;patterns&quot; &amp; APIs &#x2014; guide" name="description"/>"#).as_deref(), Some("React's \"patterns\" & APIs — guide"));
        assert_eq!(
            listing_description("<meta property='og:description' content='Build UI'/>").as_deref(),
            Some("Build UI")
        );
        assert!(listing_description("<h1>No description</h1>").is_none());
    }

    #[test]
    fn domain_previews_resolve_legacy_manifests_and_v2_artifacts_without_installing() {
        let index_url = reqwest::Url::parse("https://example.com/.well-known/skills/index.json")
            .expect("index URL");
        let legacy = serde_json::json!({"skills":[{"name":"review", "files":["SKILL.md", "references/check.md"]}]});
        let (url, files, digest) =
            well_known_manifest(legacy, &index_url, "review").expect("legacy preview");
        assert_eq!(
            url.as_str(),
            "https://example.com/.well-known/skills/review/SKILL.md"
        );
        assert_eq!(files.len(), 2);
        assert!(digest.is_none());
        let v2 = serde_json::json!({"$schema":"https://schemas.agentskills.io/discovery/0.2.0/schema.json", "skills":[{"name":"review", "type":"skill-md", "url":"./review.md", "digest":format!("sha256:{}", "a".repeat(64))}]});
        let (url, _, digest) =
            well_known_manifest(v2.clone(), &index_url, "review").expect("v2 preview");
        assert_eq!(
            url.as_str(),
            "https://example.com/.well-known/skills/review.md"
        );
        assert!(digest.is_some());
        let mut archive = v2;
        archive["skills"][0]["type"] = serde_json::json!("archive");
        assert_eq!(
            well_known_manifest(archive, &index_url, "review").expect_err("unsupported archive"),
            PREVIEW_UNAVAILABLE
        );
        let unsafe_files =
            serde_json::json!({"skills":[{"name":"review", "files":["SKILL.md", "../outside"]}]});
        assert!(well_known_manifest(unsafe_files, &index_url, "review").is_err());
        assert!(
            preview_url(reqwest::Url::parse("http://example.com/SKILL.md").expect("URL")).is_err()
        );
        assert!(
            preview_url(reqwest::Url::parse("https://127.0.0.1/SKILL.md").expect("URL")).is_err()
        );
    }

    #[test]
    fn missing_and_ambiguous_manifests_have_distinct_errors() {
        assert_eq!(
            matching_manifest("review", Vec::new()).err().as_deref(),
            Some(SKILL_NOT_FOUND)
        );
        assert_eq!(
            matching_manifest(
                "review",
                vec![named_manifest("skills/other/SKILL.md", "other")]
            )
            .err()
            .as_deref(),
            Some(SKILL_NOT_FOUND)
        );
        assert_eq!(
            matching_manifest(
                "review",
                vec![
                    named_manifest("skills/review/SKILL.md", "review"),
                    named_manifest("examples/review/SKILL.md", "review"),
                ]
            )
            .err()
            .as_deref(),
            Some(SKILL_AMBIGUOUS)
        );
        let (manifest, _) = matching_manifest(
            "review",
            vec![named_manifest("skills/alias/SKILL.md", "review")],
        )
        .expect("frontmatter match");
        assert_eq!(manifest.path, "skills/alias/SKILL.md");
    }

    #[test]
    fn archived_documentation_does_not_become_an_installable_skill() {
        tauri::async_runtime::block_on(async {
            let skill = MarketSkill {
                repository: "mattpocock/skills".into(),
                slug: "resolving-merge-conflicts".into(),
                name: "resolving-merge-conflicts".into(),
                description: String::new(),
                installs: None,
            };
            let repo = RepositorySnapshot {
                revision: "a".repeat(40),
                entries: vec![entry("docs/engineering/resolving-merge-conflicts.md")],
            };
            let result = resolve_manifest(&Client::new(), &skill, &repo).await;
            assert_eq!(result.err().as_deref(), Some(SKILL_NOT_FOUND));
        });
    }

    #[test]
    fn refresh_invalidates_latest_tree_but_preserves_pinned_install_revisions() {
        let revision = "a".repeat(40);
        let repo = RepositorySnapshot {
            revision: revision.clone(),
            entries: Vec::new(),
        };
        let latest_key = "test-refresh/skills@HEAD";
        let pinned_key = format!("test-refresh/skills@{revision}");
        remember(&REPOSITORIES, latest_key.into(), repo.clone());
        remember(&REPOSITORIES, pinned_key.clone(), repo);
        invalidate_latest_snapshot("test-refresh/skills");
        assert!(cached(&REPOSITORIES, latest_key).is_none());
        assert!(cached(&REPOSITORIES, &pinned_key).is_some());
        REPOSITORIES.lock().expect("cache").remove(&pinned_key);
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
    fn one_character_queries_do_not_send_search_requests() {
        tauri::async_runtime::block_on(async {
            let client = Client::new();
            for query in ["a", " 🦀 "] {
                let result = search_with_client(&client, query, 0)
                    .await
                    .expect("empty search");
                assert!(result.skills.is_empty());
                assert!(!result.limited);
            }
            assert!(search_with_client(&client, &"a".repeat(201), 0)
                .await
                .is_err());
        });
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
            has_more: false,
            skills: vec![
                CommunitySkill {
                    id: "vercel-labs/agent-skills/vercel-react-best-practices".into(),
                    skill_id: String::new(),
                    description: String::new(),
                    source: "vercel-labs/agent-skills".into(),
                    name: "React".into(),
                    installs: 42,
                },
                CommunitySkill {
                    id: "example.com/review".into(),
                    skill_id: String::new(),
                    description: String::new(),
                    source: "example.com".into(),
                    name: "Review".into(),
                    installs: 1,
                },
            ],
        };
        let skills = community_skills(results);
        assert_eq!(skills.len(), 2);
        assert_eq!(skills[0].slug, "vercel-react-best-practices");
        assert_eq!(skills[0].installs, Some(42));
        assert!(validate_listing_skill(&skills[1]).is_ok());
        assert!(validate_skill(&skills[1]).is_err());
        for source in [
            "https://example.com",
            "../repo",
            "owner/repo/extra",
            "example.com?redirect=evil",
        ] {
            let mut invalid = skills[1].clone();
            invalid.repository = source.into();
            assert!(validate_listing_skill(&invalid).is_err(), "{source}");
        }
    }

    #[test]
    #[ignore = "只读访问真实 GitHub / skills.sh 和域名技能目录"]
    fn live_marketplace_search_and_preview() {
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
            let browse = search_with_client(&client, "", 0)
                .await
                .expect("default popular skills");
            assert!(
                browse.skills.len() > 24,
                "default page has a browsable catalog"
            );
            let next =
                search_with_client(&client, "", browse.next_page.expect("more popular skills"))
                    .await
                    .expect("second popular batch");
            assert!(!next.skills.is_empty());
            assert_ne!(browse.skills[0].slug, next.skills[0].slug);
            assert!(
                browse
                    .skills
                    .iter()
                    .any(|skill| validate_repository(&skill.repository).is_err()),
                "domain sources remain visible"
            );
            let results = search_with_client(&client, "react", 0)
                .await
                .expect("search");
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
            assert!(detail.content.contains("---"));
            let external = browse
                .skills
                .into_iter()
                .find(|skill| skill.repository == "open.feishu.cn" && skill.slug == "lark-doc")
                .expect("domain source");
            let preview = detail_with_client(&client, external)
                .await
                .expect("domain skill preview");
            assert!(preview.content.contains("lark-doc"));
            assert!(preview.files.iter().any(|file| file == "SKILL.md"));
        });
    }

    #[test]
    #[ignore = "只读访问真实 GitHub，检查截图中的 hyperframes-cli 详情"]
    fn live_hyperframes_preview() {
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
            let detail = detail_with_client(
                &client,
                MarketSkill {
                    repository: "heygen-com/hyperframes".into(),
                    slug: "hyperframes-cli".into(),
                    name: "hyperframes-cli".into(),
                    description: String::new(),
                    installs: None,
                },
            )
            .await
            .expect("hyperframes-cli preview");
            assert!(!detail.content.is_empty());
            assert_eq!(detail.skill.name, "hyperframes-cli");
            if detail.preview_only {
                assert!(detail.files.is_empty());
            } else {
                assert!(detail.file_count > 0);
            }
            eprintln!(
                "Live preview succeeded: {} bytes, preview_only={}",
                detail.content.len(),
                detail.preview_only
            );
        });
    }

    #[test]
    #[ignore = "访问真实 skills.sh / GitHub，复现已归档技能的详情提示"]
    fn live_removed_skill_is_reported_as_unavailable() {
        tauri::async_runtime::block_on(async {
            let proxy = crate::network_proxy::resolve_network_proxy(
                &crate::network_proxy::NetworkProxySettings::default(),
            )
            .expect("proxy");
            let client = crate::network_proxy::apply_proxy_to_client_builder(
                Client::builder()
                    .no_proxy()
                    .user_agent("Termflow archived skill regression check")
                    .timeout(Duration::from_secs(30)),
                &proxy,
            )
            .expect("builder")
            .build()
            .expect("client");
            let results = search_with_client(&client, "resolving-merge-conflicts", 0)
                .await
                .expect("listing");
            let skill = results
                .skills
                .into_iter()
                .find(|skill| {
                    skill.repository == "mattpocock/skills"
                        && skill.slug == "resolving-merge-conflicts"
                })
                .expect("stale listing");
            invalidate_latest_snapshot(&skill.repository);
            let result = detail_with_client(&client, skill).await;
            assert_eq!(result.err().as_deref(), Some(SKILL_NOT_FOUND));
        });
    }
}
