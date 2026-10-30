//! 本地供应商历史适配：活动记录独立于 Token 可用性，复制历史不重复累计。
use super::*;

fn nonempty_string(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

pub(super) fn has_content(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(text)) => !text.trim().is_empty(),
        Some(Value::Array(blocks)) => blocks.iter().any(|block| has_content(Some(block))),
        Some(Value::Object(block)) => {
            has_content(block.get("text"))
                || has_content(block.get("thinking"))
                || nonempty_string(block.get("name")).is_some()
        }
        _ => false,
    }
}

fn collect_jsonl(root: &Path, files: &mut BTreeMap<String, PathBuf>) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(root).map_err(|e| format!("读取本地会话目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("读取本地会话条目失败: {e}"))?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_dir() {
            collect_jsonl(&entry.path(), files)?;
        } else if kind.is_file()
            && entry.path().extension().and_then(|s| s.to_str()) == Some("jsonl")
        {
            files.insert(local_path_key(&entry.path()), entry.path());
        }
    }
    Ok(())
}

pub(super) fn qoder_cli_files() -> Result<Vec<PathBuf>, String> {
    let mut files = BTreeMap::new();
    for (variable, directory) in [
        ("QODER_CONFIG_DIR", ".qoder"),
        ("QODERCN_CONFIG_DIR", ".qoder-cn"),
    ] {
        let root = env::var_os(variable)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| dirs_next::home_dir().map(|home| home.join(directory)));
        if let Some(root) = root {
            collect_jsonl(&root.join("projects"), &mut files)?;
        }
    }
    Ok(files.into_values().collect())
}

fn qoder_cli_event(record: &Value) -> Option<(String, ParsedAgentUsageEvent)> {
    if record.get("type")?.as_str()? != "assistant" {
        return None;
    }
    let message = record.get("message")?;
    let session = nonempty_string(record.get("sessionId"))
        .or_else(|| nonempty_string(record.get("session_id")))?;
    let usage = message.get("usage");
    let input = json_u64(usage.and_then(|u| u.get("input_tokens")));
    let output = json_u64(usage.and_then(|u| u.get("output_tokens")));
    let cache_read = json_u64(usage.and_then(|u| u.get("cache_read_input_tokens")));
    let cache_write = json_u64(usage.and_then(|u| u.get("cache_creation_input_tokens")));
    let total = input
        .saturating_add(output)
        .saturating_add(cache_read)
        .saturating_add(cache_write);
    let credits = usage
        .and_then(|u| u.get("credits"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    if total == 0 && credits <= 0.0 && !has_content(message.get("content")) {
        return None;
    }
    // 同一模型响应的多个内容块共享 message.id；缺失时使用会话内 uuid。
    let id = nonempty_string(message.get("id"))
        .or_else(|| nonempty_string(record.get("request_id")))
        .or_else(|| nonempty_string(record.get("uuid")))?;
    let timestamp = nonempty_string(record.get("timestamp")).and_then(parse_timestamp_utc)?;
    let model = nonempty_string(message.get("model")).unwrap_or("agent");
    let token_breakdown = AgentUsageTokenBreakdown {
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_read,
        cache_creation_tokens: cache_write,
        total_tokens: total,
        ..Default::default()
    };
    Some((
        format!("{session}:{id}"),
        ParsedAgentUsageEvent {
            session_id: session.to_string(),
            timestamp,
            model: format!("Qoder / {model}"),
            total_tokens: total,
            token_breakdown,
        },
    ))
}

fn insert_event(
    events: &mut BTreeMap<String, ParsedAgentUsageEvent>,
    key: String,
    event: ParsedAgentUsageEvent,
) {
    match events.get_mut(&key) {
        Some(previous) => {
            let first = previous.timestamp.min(event.timestamp);
            if event.total_tokens > previous.total_tokens {
                *previous = event;
            }
            previous.timestamp = first;
        }
        None => {
            events.insert(key, event);
        }
    }
}

pub(super) fn build_qoder_stats(
    database_paths: Vec<PathBuf>,
    transcript_files: Vec<PathBuf>,
) -> Result<AggregatedTranscriptStats, String> {
    let mut database_events = BTreeMap::new();
    let mut cli_events = BTreeMap::new();
    let mut database_sessions = BTreeSet::new();
    let mut database_token_sessions = BTreeSet::new();
    for path in database_paths {
        let connection = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| format!("打开 Qoder 本地数据库失败 {}: {e}", display_path(&path)))?;
        for row in select_qoder_usage_rows(&connection)? {
            let key = format!("{}:{}", row.session_id, row.id);
            if let Some(event) = parse_qoder_usage_row(row) {
                database_sessions.insert(event.session_id.clone());
                if event.total_tokens > 0 {
                    database_token_sessions.insert(event.session_id.clone());
                }
                insert_event(&mut database_events, key, event);
            }
        }
    }
    for path in transcript_files {
        let file = fs::File::open(&path).map_err(|e| format!("读取 Qoder CLI 会话失败: {e}"))?;
        for line in BufReader::new(file).lines() {
            let line = line.map_err(|e| format!("读取 Qoder CLI 记录失败: {e}"))?;
            let Ok(record) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if let Some((key, event)) = qoder_cli_event(&record) {
                insert_event(&mut cli_events, key, event);
            }
        }
    }
    let cli_sessions = cli_events
        .values()
        .map(|event| event.session_id.clone())
        .collect::<BTreeSet<_>>();
    let mut aggregate = AggregatedTranscriptStats::default();
    let mut sessions = BTreeMap::new();
    for event in database_events.into_values() {
        aggregate.token_data_incomplete |= event.total_tokens == 0;
        if cli_sessions.contains(&event.session_id) {
            // CLI 负责该会话活动（含数据库停止同步之后的使用日期），DB 只补精确
            // Token。两源没有可靠逐请求关联，不再额外累计 DB 的第二套活动。
            aggregate.token_data_incomplete = true;
            add_tokens_only(&mut aggregate, &event);
            sessions
                .entry(event.session_id)
                .and_modify(|span: &mut UsageSessionSpan| span.update(event.timestamp))
                .or_insert_with(|| UsageSessionSpan::new(event.timestamp));
        } else {
            record_generic_usage_event(&mut aggregate, &mut sessions, event);
        }
    }
    for mut event in cli_events.into_values() {
        if database_sessions.contains(&event.session_id) {
            aggregate.token_data_incomplete = true;
        }
        if database_token_sessions.contains(&event.session_id) {
            // Token 仍以 DB 为准；CLI 的零值不能抹掉已知精确值，也不相加两套量。
            event.total_tokens = 0;
            event.token_breakdown = AgentUsageTokenBreakdown::default();
        }
        aggregate.token_data_incomplete |= event.total_tokens == 0;
        record_generic_usage_event(&mut aggregate, &mut sessions, event);
    }
    finalize_generic_sessions(&mut aggregate, sessions);
    Ok(aggregate)
}

fn add_tokens_only(aggregate: &mut AggregatedTranscriptStats, event: &ParsedAgentUsageEvent) {
    if event.total_tokens == 0 {
        return;
    }
    aggregate
        .model_usage
        .entry(event.model.clone())
        .or_default()
        .input_tokens += event.total_tokens;
    aggregate.token_breakdown.merge(event.token_breakdown);
    *aggregate
        .daily_model_tokens
        .entry(local_date_string(&event.timestamp))
        .or_default()
        .entry(event.model.clone())
        .or_insert(0) += event.total_tokens;
}

pub(super) fn parse_pi_record(
    record: &Value,
    session_id: &str,
    current_model: Option<&str>,
) -> Option<ParsedAgentUsageEvent> {
    let kind = record.get("type")?.as_str()?;
    let (usage, model, content) = match kind {
        "message" => {
            let message = record.get("message")?;
            if message.get("role")?.as_str()? != "assistant" {
                return None;
            }
            (
                message.get("usage"),
                nonempty_string(message.get("model")).or(current_model),
                message.get("content"),
            )
        }
        "compaction" | "branch_summary" | "usage" => (
            record.get("usage"),
            nonempty_string(record.get("model")).or(current_model),
            record.get("summary"),
        ),
        _ => return None,
    };
    let input = json_u64(usage.and_then(|u| u.get("input")));
    let output = json_u64(usage.and_then(|u| u.get("output")));
    let cache_read = json_u64(usage.and_then(|u| u.get("cacheRead")));
    let cache_write = json_u64(usage.and_then(|u| u.get("cacheWrite")));
    let reasoning = json_u64(usage.and_then(|u| u.get("reasoning"))).min(output);
    let categorized = input
        .saturating_add(output)
        .saturating_add(cache_read)
        .saturating_add(cache_write);
    let total_tokens = json_u64(usage.and_then(|u| u.get("totalTokens"))).max(categorized);
    if total_tokens == 0 && (kind != "message" || !has_content(content)) {
        return None;
    }
    let timestamp = nonempty_string(record.get("timestamp")).and_then(parse_timestamp_utc)?;
    let token_breakdown = AgentUsageTokenBreakdown {
        input_tokens: input,
        output_tokens: output - reasoning,
        cache_read_tokens: cache_read,
        cache_creation_tokens: cache_write,
        reasoning_output_tokens: reasoning,
        other_tokens: total_tokens - categorized,
        total_tokens,
    };
    Some(ParsedAgentUsageEvent {
        session_id: session_id.to_string(),
        timestamp,
        model: model.unwrap_or("pi-unknown").to_string(),
        total_tokens,
        token_breakdown,
    })
}

pub(super) fn build_pi_stats(
    session_files: Vec<PathBuf>,
) -> Result<AggregatedTranscriptStats, String> {
    let mut transcripts = Vec::new();
    let mut ancestry = BTreeMap::new();
    for path in session_files {
        let file = fs::File::open(&path).map_err(|e| format!("读取 Pi 会话失败: {e}"))?;
        let mut header = None;
        for line in BufReader::new(file).lines() {
            let line = line.map_err(|e| format!("读取 Pi 会话记录失败: {e}"))?;
            if let Ok(record) = serde_json::from_str::<Value>(&line) {
                if record.get("type").and_then(Value::as_str) == Some("session") {
                    header = Some(record);
                    break;
                }
            }
        }
        let header = header.as_ref();
        let session = header
            .and_then(|r| nonempty_string(r.get("id")))
            .map(str::to_string)
            .unwrap_or_else(|| local_path_key(&path));
        let created = header
            .and_then(|r| nonempty_string(r.get("timestamp")))
            .unwrap_or("")
            .to_string();
        let path_key = local_path_key(&path);
        let parent = header
            .and_then(|r| nonempty_string(r.get("parentSession")))
            .map(|value| {
                let value = PathBuf::from(value);
                local_path_key(&if value.is_absolute() {
                    value
                } else {
                    path.parent().unwrap_or(Path::new("")).join(value)
                })
            });
        ancestry.insert(path_key.clone(), (session.clone(), parent.clone()));
        transcripts.push((parent.is_some(), created, session, path_key, path));
    }
    // 原会话先于 fork 读取，使复制的历史事件归属于产生它的原会话。
    transcripts
        .sort_by(|left, right| (&left.0, &left.1, &left.2).cmp(&(&right.0, &right.1, &right.2)));
    let mut seen = BTreeSet::new();
    let mut aggregate = AggregatedTranscriptStats::default();
    let mut sessions = BTreeMap::new();
    for (_, _, session, path_key, path) in transcripts {
        let mut lineage = path_key;
        let mut visited = BTreeSet::new();
        while visited.insert(lineage.clone()) {
            match ancestry.get(&lineage) {
                Some((_, Some(parent))) => lineage = parent.clone(),
                Some((root_session, None)) => {
                    lineage = root_session.clone();
                    break;
                }
                None => break,
            }
        }
        let mut model: Option<String> = None;
        let file = fs::File::open(path).map_err(|e| format!("读取 Pi 会话失败: {e}"))?;
        for (index, line) in BufReader::new(file).lines().enumerate() {
            let line = line.map_err(|e| format!("读取 Pi 会话记录失败: {e}"))?;
            let Ok(record) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if record.get("type").and_then(Value::as_str) == Some("model_change") {
                model = nonempty_string(record.get("modelId")).map(str::to_string);
            }
            if let Some(value) = record
                .get("message")
                .and_then(|m| nonempty_string(m.get("model")))
            {
                model = Some(value.to_string());
            }
            if let Some(event) = parse_pi_record(&record, &session, model.as_deref()) {
                let key = match nonempty_string(record.get("id")) {
                    // 短 ID 只在同一会话树内去重；无关会话可生成相同短 ID。
                    Some(id) => format!(
                        "{lineage}:{id}:{}:{}",
                        event.timestamp.to_rfc3339(),
                        record.get("type").and_then(Value::as_str).unwrap_or("")
                    ),
                    None => format!("{session}:{index}"),
                };
                if seen.insert(key) {
                    aggregate.token_data_incomplete |= event.total_tokens == 0;
                    record_generic_usage_event(&mut aggregate, &mut sessions, event);
                }
            }
        }
    }
    finalize_generic_sessions(&mut aggregate, sessions);
    Ok(aggregate)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_records(path: &Path, records: &[Value]) {
        fs::write(
            path,
            records
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
    }

    #[test]
    fn qoder_zero_token_credits_keep_activity_and_stream_chunks_are_deduplicated() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("qoder.jsonl");
        let record = json!({"type":"assistant","uuid":"block-1","sessionId":"cli-only","timestamp":"2026-09-01T00:01:00Z","message":{"id":"response-1","model":"auto","content":[{"type":"text","text":"answer"}],"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"credits":0.5}}});
        let mut duplicate = record.clone();
        duplicate["uuid"] = json!("block-2");
        let placeholder = json!({"type":"assistant","uuid":"empty","sessionId":"cli-only","timestamp":"2026-09-01T00:02:00Z","message":{"content":[{"type":"text","text":""}]}});
        write_records(&path, &[record, duplicate, placeholder]);
        let stats = build_qoder_stats(vec![], vec![path]).unwrap();
        assert_eq!(stats.total_messages, 1);
        assert_eq!(stats.total_sessions, 1);
        assert_eq!(stats.total_tokens(), 0);
        assert_eq!(stats.daily_activity.len(), 1);
        assert!(stats.token_data_incomplete);
    }

    #[test]
    fn qoder_database_precedes_cli_export_and_cli_only_sessions_are_retained() {
        let root = tempfile::tempdir().unwrap();
        let database = root.path().join("local.db");
        let db = Connection::open(&database).unwrap();
        db.execute_batch("CREATE TABLE chat_message(id TEXT,session_id TEXT,role TEXT,token_info TEXT,gmt_create INTEGER); INSERT INTO chat_message VALUES('db-message','covered','assistant','{\"prompt_tokens\":100,\"cached_tokens\":80,\"completion_tokens\":20}',1788220860000);").unwrap();
        drop(db);
        let path = root.path().join("cli.jsonl");
        write_records(
            &path,
            &[
                json!({"type":"assistant","uuid":"exported-block","sessionId":"covered","timestamp":"2026-09-01T00:01:00Z","message":{"content":[{"type":"text","text":"answer"}]}}),
                json!({"type":"assistant","uuid":"new-response","sessionId":"cli-only","timestamp":"2026-09-02T00:01:00Z","message":{"content":[{"type":"text","text":"answer"}],"usage":{"credits":1.0}}}),
            ],
        );
        let stats = build_qoder_stats(vec![database], vec![path]).unwrap();
        assert_eq!(stats.total_messages, 2);
        assert_eq!(stats.total_sessions, 2);
        assert_eq!(stats.total_tokens(), 120);
        assert_eq!(stats.token_breakdown.cache_read_tokens, 80);
        assert!(stats.token_data_incomplete);
    }

    #[test]
    fn qoder_cli_continuation_keeps_new_activity_without_erasing_or_repeating_database_tokens() {
        let root = tempfile::tempdir().unwrap();
        let database = root.path().join("local.db");
        let db = Connection::open(&database).unwrap();
        let first_timestamp = parse_timestamp_utc("2026-09-01T00:01:00Z").unwrap();
        db.execute_batch("CREATE TABLE chat_message(id TEXT,session_id TEXT,role TEXT,token_info TEXT,gmt_create INTEGER);").unwrap();
        db.execute(
            "INSERT INTO chat_message VALUES('db-message','continued','assistant',?1,?2)",
            rusqlite::params![
                r#"{"prompt_tokens":100,"cached_tokens":80,"completion_tokens":20}"#,
                first_timestamp.timestamp_millis()
            ],
        )
        .unwrap();
        drop(db);
        let path = root.path().join("cli.jsonl");
        for continuation_usage in [
            json!({"credits":1.0}),
            json!({"input_tokens":40,"output_tokens":10}),
        ] {
            write_records(
                &path,
                &[
                    json!({"type":"assistant","uuid":"old-export","sessionId":"continued","timestamp":"2026-09-01T00:01:00Z","message":{"id":"old-response","model":"auto","content":[{"type":"text","text":"old answer"}],"usage":{"input_tokens":20,"cache_read_input_tokens":80,"output_tokens":20}}}),
                    json!({"type":"assistant","uuid":"new-response","sessionId":"continued","timestamp":"2026-09-02T00:01:00Z","message":{"model":"auto","content":[{"type":"text","text":"new answer"}],"usage":continuation_usage}}),
                ],
            );
            let stats = build_qoder_stats(vec![database.clone()], vec![path.clone()]).unwrap();
            let first_day = local_date_string(&first_timestamp);
            let next_day = local_date_string(&parse_timestamp_utc("2026-09-02T00:01:00Z").unwrap());
            assert_eq!(stats.total_sessions, 1);
            assert_eq!(stats.total_messages, 2);
            assert_eq!(stats.daily_activity[&first_day].message_count, 1);
            assert_eq!(stats.daily_activity[&next_day].message_count, 1);
            assert_eq!(stats.last_session_date.as_deref(), Some(next_day.as_str()));
            assert_eq!(stats.total_tokens(), 120);
            assert_eq!(stats.token_breakdown.total_tokens, 120);
            assert_eq!(stats.token_breakdown.cache_read_tokens, 80);
            assert_eq!(
                stats
                    .daily_model_tokens
                    .values()
                    .flat_map(|models| models.values())
                    .sum::<u64>(),
                120
            );
            assert_eq!(stats.hour_counts.values().sum::<u64>(), 2);
            assert!(stats.token_data_incomplete);
        }
    }

    #[test]
    fn pi_fork_history_is_counted_once_and_summary_and_cache_warming_usage_are_counted() {
        let root = tempfile::tempdir().unwrap();
        let original = root.path().join("original.jsonl");
        let fork = root.path().join("fork.jsonl");
        let message = json!({"type":"message","id":"shared","timestamp":"2026-09-01T00:01:00Z","message":{"role":"assistant","model":"model-a","usage":{"input":10,"output":2,"cacheRead":20,"cacheWrite":3}}});
        write_records(
            &original,
            &[
                json!({"type":"session","id":"original","timestamp":"2026-09-01T00:00:00Z"}),
                message.clone(),
            ],
        );
        write_records(
            &fork,
            &[
                json!({"type":"session","id":"fork","parentSession":"original.jsonl","timestamp":"2026-09-02T00:00:00Z"}),
                message,
                json!({"type":"compaction","id":"compact","timestamp":"2026-09-02T00:01:00Z","summary":"summary","usage":{"input":4,"output":1}}),
                json!({"type":"branch_summary","id":"branch","timestamp":"2026-09-02T00:02:00Z","summary":"summary","usage":{"input":2,"output":1}}),
                json!({"type":"usage","id":"warm","kind":"cache_warm","model":"model-b","timestamp":"2026-09-02T00:03:00Z","usage":{"input":1,"cacheWrite":9}}),
            ],
        );
        let stats = build_pi_stats(vec![fork, original]).unwrap();
        assert_eq!(stats.total_tokens(), 53);
        assert_eq!(stats.total_messages, 4);
        assert_eq!(stats.total_sessions, 2);
        assert_eq!(stats.model_usage["model-a"].total_tokens(), 43);
        assert_eq!(stats.model_usage["model-b"].total_tokens(), 10);
    }

    #[test]
    fn pi_actual_response_without_usage_keeps_activity_but_empty_placeholder_does_not() {
        let event = json!({"type":"message","timestamp":"2026-09-01T00:01:00Z","message":{"role":"assistant","model":"a","content":[{"type":"text","text":"answer"}]}});
        assert_eq!(
            parse_pi_record(&event, "session", None)
                .unwrap()
                .total_tokens,
            0
        );
        let empty = json!({"type":"message","timestamp":"2026-09-01T00:01:00Z","message":{"role":"assistant","model":"a","content":[]}});
        assert!(parse_pi_record(&empty, "session", None).is_none());
    }

    #[test]
    fn pi_short_entry_ids_in_unrelated_sessions_are_not_deduplicated() {
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("first.jsonl");
        let second = root.path().join("second.jsonl");
        let event = json!({"type":"message","id":"abcd1234","timestamp":"2026-09-01T00:01:00Z","message":{"role":"assistant","model":"a","usage":{"input":10,"output":1}}});
        for (path, session) in [(&first, "first"), (&second, "second")] {
            write_records(
                path,
                &[json!({"type":"session","id":session}), event.clone()],
            );
        }
        let stats = build_pi_stats(vec![first, second]).unwrap();
        assert_eq!(stats.total_tokens(), 22);
        assert_eq!(stats.total_messages, 2);
        assert_eq!(stats.total_sessions, 2);
    }

    #[test]
    fn qoder_database_zero_usage_content_is_activity_without_invented_tokens() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("local.db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE chat_message(id TEXT,session_id TEXT,role TEXT,token_info TEXT,gmt_create INTEGER,content TEXT); INSERT INTO chat_message VALUES('real','session','assistant',NULL,1788220860000,'answer'); INSERT INTO chat_message VALUES('empty','session','assistant',NULL,1788220860001,'[]');").unwrap();
        db.execute("INSERT INTO chat_message VALUES('empty-block','session','assistant',NULL,1788220860002,?1)", [r#"[{"type":"text","text":""}]"#]).unwrap();
        drop(db);
        let stats = build_qoder_stats(vec![path], vec![]).unwrap();
        assert_eq!(stats.total_messages, 1);
        assert_eq!(stats.total_sessions, 1);
        assert_eq!(stats.total_tokens(), 0);
        assert!(stats.token_data_incomplete);
    }
}
