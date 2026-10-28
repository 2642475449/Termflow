use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

struct CachedTitles {
    path: PathBuf,
    size: u64,
    modified: Option<SystemTime>,
    session_ids: HashSet<String>,
    titles: HashMap<String, String>,
}

static TITLE_CACHE: Mutex<Option<CachedTitles>> = Mutex::new(None);

#[tauri::command]
pub async fn read_codex_session_titles(
    session_ids: Vec<String>,
) -> Result<HashMap<String, String>, String> {
    super::run_background_task("read_codex_session_titles", move || {
        let home = crate::agent_paths::user_path(crate::agent_paths::AgentPath::Codex)?;
        read_titles(&home.join("session_index.jsonl"), &session_ids)
    })
    .await
}

fn read_titles(
    index_path: &Path,
    session_ids: &[String],
) -> Result<HashMap<String, String>, String> {
    let wanted: HashSet<String> = session_ids.iter().cloned().collect();
    let mut titles = HashMap::new();
    if wanted.is_empty() {
        return Ok(titles);
    }
    let file = match File::open(index_path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(titles),
        Err(error) => return Err(error.to_string()),
    };
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    let mut cache = TITLE_CACHE.lock().map_err(|error| error.to_string())?;
    if let Some(cached) = cache.as_ref() {
        if cached.path == index_path
            && cached.size == metadata.len()
            && cached.modified == metadata.modified().ok()
            && cached.session_ids == wanted
        {
            return Ok(cached.titles.clone());
        }
    }
    // 同一 ID 的后续有效记录覆盖旧名称；忽略尚未写完或格式无效的行。
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|error| error.to_string())?;
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(id) = record.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !wanted.contains(id) {
            continue;
        }
        if let Some(title) = record.get("thread_name").and_then(Value::as_str) {
            let title = title.trim();
            if !title.is_empty() {
                titles.insert(id.to_string(), title.to_string());
            }
        }
    }
    // 索引未变化时不重复解析；查询 ID 变化仍需重新读取，防止漏掉刚绑定的会话。
    *cache = Some(CachedTitles {
        path: index_path.to_path_buf(),
        size: metadata.len(),
        modified: metadata.modified().ok(),
        session_ids: wanted,
        titles: titles.clone(),
    });
    Ok(titles)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_latest_title_by_exact_id_without_truncating_or_rewriting_it() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let index = dir.path().join("session_index.jsonl");
        std::fs::write(&index, concat!(
            "{\"id\":\"one\",\"thread_name\":\"旧名称\"}\n",
            "{\"id\":\"other\",\"thread_name\":\"其他会话\"}\n",
            "{\"id\":\"one\",\"thread_name\":\"  修复 Codex / Termflow 会话名称同步：保留完整原生标题与标点  \"}\n",
            "{\"id\":\"one\",\"thread_name\":\"  \"}\n",
            "not json\n{\"id\":\"one\""
        )).expect("write index");
        let titles = read_titles(&index, &["one".into(), "missing".into()]).expect("read index");
        assert_eq!(titles.len(), 1);
        assert_eq!(
            titles.get("one").map(String::as_str),
            Some("修复 Codex / Termflow 会话名称同步：保留完整原生标题与标点")
        );
    }

    #[test]
    fn missing_index_or_empty_requests_have_no_native_title() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let index = dir.path().join("missing.jsonl");
        assert!(read_titles(&index, &["one".into()])
            .expect("missing index")
            .is_empty());
        assert!(read_titles(dir.path(), &[])
            .expect("empty request")
            .is_empty());
    }

    #[test]
    fn refreshes_when_the_index_or_requested_session_changes() {
        let dir = tempfile::tempdir().expect("temporary directory");
        let index = dir.path().join("session_index.jsonl");
        std::fs::write(&index, "{\"id\":\"one\",\"thread_name\":\"旧名称\"}\n{\"id\":\"two\",\"thread_name\":\"其他名称\"}\n").expect("write index");
        let first = read_titles(&index, &["one".into()]).expect("first read");
        assert_eq!(
            read_titles(&index, &["one".into()]).expect("cached read"),
            first
        );
        assert!(read_titles(&index, &["two".into()])
            .expect("different request")
            .contains_key("two"));
        std::fs::write(
            &index,
            "{\"id\":\"one\",\"thread_name\":\"修改后的完整名称\"}\n",
        )
        .expect("update index");
        assert_eq!(
            read_titles(&index, &["one".into()])
                .expect("updated read")
                .get("one")
                .map(String::as_str),
            Some("修改后的完整名称")
        );
    }
}
