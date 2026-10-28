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
const SKILL_NOT_FOUND: &str = "marketplace_skill_not_found";
const SKILL_AMBIGUOUS: &str = "marketplace_skill_ambiguous";

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
    database: State<'_, Arc<Database>>,
) -> Result<MarketSearch, String> {
    let client = client(&database)?;
    search_with_client(&client, &query).await
}

async fn search_with_client(client: &Client, query: &str) -> Result<MarketSearch, String> {
    let query = query.trim();
    let query_length = query.chars().count();
    if query_length > 200 {
        return Err("Search query is too long".into());
    }
    if query_length < 2 {
        return Ok(MarketSearch {
            skills: Vec::new(),
            limited: false,
        });
    }
    let mut skills = search_community(client, query).await?;
    skills.sort_by(|a, b| {
        b.installs
            .unwrap_or(0)
            .cmp(&a.installs.unwrap_or(0))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(MarketSearch {
        limited: skills.len() >= COMMUNITY_LIMIT,
        skills,
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

fn matching_manifest(
    slug: &str,
    candidates: Vec<(TreeEntry, String)>,
) -> Result<(TreeEntry, String), String> {
    let mut matches = candidates
        .into_iter()
        .filter(|(_, content)| parse_skill_frontmatter(content).0 == slug);
    let selected = matches.next().ok_or_else(|| SKILL_NOT_FOUND.to_string())?;
    if matches.next().is_some() {
        return Err(SKILL_AMBIGUOUS.into());
    }
    Ok(selected)
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
    if candidates.len() > 256 {
        return Err("Repository contains too many skills to resolve this selection".into());
    }
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
    let contents = stream::iter(candidates.into_iter().map(|entry| async move {
        let content = manifest(client, &skill.repository, repo, &entry).await?;
        Ok::<_, String>((entry, content))
    }))
    .buffer_unordered(6)
    .try_collect::<Vec<_>>()
    .await?;
    matching_manifest(&skill.slug, contents).map_err(|reason| {
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
    validate_skill(&skill)?;
    let repo = snapshot(client, &skill.repository, None).await?;
    let (entry, content) = resolve_manifest(client, &skill, &repo).await?;
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
    refresh: Option<bool>,
    database: State<'_, Arc<Database>>,
) -> Result<MarketDetail, String> {
    if refresh.unwrap_or(false) {
        invalidate_latest_snapshot(&skill.repository);
    }
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
    let repo = snapshot(client, &request.skill.repository, Some(&request.revision)).await?;
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

    fn named_manifest(path: &str, name: &str) -> (TreeEntry, String) {
        (
            entry(path),
            format!("---\nname: {name}\ndescription: Example skill\n---\n"),
        )
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
    fn empty_and_short_queries_do_not_request_a_catalog() {
        tauri::async_runtime::block_on(async {
            let client = Client::new();
            for query in ["", " ", "a", " 🦀 "] {
                let result = search_with_client(&client, query)
                    .await
                    .expect("empty search");
                assert!(result.skills.is_empty());
                assert!(!result.limited);
            }
            assert!(search_with_client(&client, &"a".repeat(201)).await.is_err());
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
            let results = search_with_client(&client, "react").await.expect("search");
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
            let repo = snapshot(&client, &detail.skill.repository, Some(&detail.revision))
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
            let results = search_with_client(&client, "resolving-merge-conflicts")
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
