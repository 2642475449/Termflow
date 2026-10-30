use super::*;

#[derive(Clone)]
struct TranscriptMessage {
    timestamp: Option<DateTime<Utc>>,
    session_id: String,
    is_subagent: bool,
    usage: Option<(String, ClaudeStatsModelUsage)>,
}

fn message_key(entry: &Value, path: &Path, line: usize) -> String {
    if let Some(id) = get_message_dedupe_key(entry) {
        return id;
    }
    if let Some(id) = entry.get("uuid").and_then(Value::as_str) {
        return format!("uuid:{id}");
    }
    format!("{}:{line}", path.to_string_lossy())
}

fn read_messages(files: &[PathBuf]) -> (Vec<TranscriptMessage>, bool) {
    let mut incomplete = false;
    let mut records = Vec::<TranscriptMessage>::new();
    let mut indexes = BTreeMap::<String, usize>::new();
    let mut files = files.to_vec();
    files.sort();
    for path in files {
        let Ok(file) = fs::File::open(&path) else {
            incomplete = true;
            continue;
        };
        let subagent = is_subagent_session_file(&path);
        for (line_number, line) in BufReader::new(file).lines().enumerate() {
            let Ok(line) = line else {
                incomplete = true;
                continue;
            };
            let Ok(entry) = serde_json::from_str::<Value>(&line) else {
                incomplete = true;
                continue;
            };
            if !is_transcript_message(&entry)
                || (!subagent && entry.get("isSidechain").and_then(Value::as_bool) == Some(true))
            {
                continue;
            }
            let timestamp = entry
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(parse_timestamp_utc);
            incomplete |= timestamp.is_none();
            let assistant = entry.get("type").and_then(Value::as_str) == Some("assistant");
            let usage = assistant.then(|| get_message_usage(&entry)).flatten();
            if assistant
                && usage.is_none()
                && entry.pointer("/message/model").and_then(Value::as_str) != Some("<synthetic>")
            {
                incomplete = true;
            }
            let key = message_key(&entry, &path, line_number);
            if let Some(index) = indexes.get(&key).copied() {
                let existing = &mut records[index];
                existing.timestamp = match (existing.timestamp, timestamp) {
                    (Some(a), Some(b)) => Some(a.min(b)),
                    (a, b) => a.or(b),
                };
                if let Some((model, usage)) = usage {
                    if let Some((_, previous)) = &mut existing.usage {
                        previous.merge_max(&usage);
                    } else {
                        existing.usage = Some((model, usage));
                    }
                }
                continue;
            }
            indexes.insert(key, records.len());
            records.push(TranscriptMessage {
                timestamp,
                // 主线程与子代理文件均作为线程记录，复制历史按原消息身份去重。
                session_id: path.to_string_lossy().to_string(),
                is_subagent: subagent,
                usage,
            });
        }
    }
    (records, incomplete)
}

fn aggregate_messages(
    records: &[TranscriptMessage],
    incomplete: bool,
    from_date: Option<&str>,
    to_date: Option<&str>,
) -> AggregatedTranscriptStats {
    let mut aggregate = AggregatedTranscriptStats {
        token_data_incomplete: incomplete,
        ..Default::default()
    };
    let mut sessions = BTreeMap::new();
    let mut untimed_sessions = BTreeSet::new();
    for record in records {
        let date = record.timestamp.as_ref().map(local_date_string);
        if date.as_ref().is_some_and(|date| {
            from_date.is_some_and(|from| date.as_str() < from)
                || to_date.is_some_and(|to| date.as_str() > to)
        }) {
            continue;
        }
        aggregate.total_messages += 1;
        if let (Some(date), Some(timestamp)) = (&date, record.timestamp) {
            let activity =
                aggregate
                    .daily_activity
                    .entry(date.clone())
                    .or_insert(AgentUsageDailyActivity {
                        date: date.clone(),
                        message_count: 0,
                        session_count: 0,
                    });
            activity.message_count += 1;
            *aggregate
                .hour_counts
                .entry(local_hour_string(&timestamp))
                .or_insert(0) += 1;
            sessions
                .entry(record.session_id.clone())
                .and_modify(|span: &mut UsageSessionSpan| span.update(timestamp))
                .or_insert_with(|| UsageSessionSpan::new(timestamp));
        } else {
            // 能恢复用量但缺日期时保留总数，不伪造当天日期。
            untimed_sessions.insert(record.session_id.clone());
        }
        if let Some((model, usage)) = &record.usage {
            let total = usage.total_tokens();
            if total == 0 {
                continue;
            }
            aggregate.token_breakdown.add_model_usage(usage);
            let existing = aggregate.model_usage.entry(model.clone()).or_default();
            existing.input_tokens += usage.input_tokens;
            existing.output_tokens += usage.output_tokens;
            existing.cache_read_input_tokens += usage.cache_read_input_tokens;
            existing.cache_creation_input_tokens += usage.cache_creation_input_tokens;
            if let Some(date) = date {
                *aggregate
                    .daily_model_tokens
                    .entry(date)
                    .or_default()
                    .entry(model.clone())
                    .or_insert(0) += total;
            } else {
                aggregate.undated_tokens += total;
            }
        }
    }
    let untimed_count = untimed_sessions
        .iter()
        .filter(|id| !sessions.contains_key(*id))
        .count() as u64;
    finalize_generic_sessions(&mut aggregate, sessions);
    aggregate.total_sessions += untimed_count;
    aggregate
}

#[cfg(test)]
fn process_files(
    files: &[PathBuf],
    from_date: Option<&str>,
    to_date: Option<&str>,
) -> AggregatedTranscriptStats {
    let (records, incomplete) = read_messages(files);
    aggregate_messages(&records, incomplete, from_date, to_date)
}

pub(super) fn reconcile_cache(
    cache: Option<ClaudeStatsCache>,
    files: &[PathBuf],
) -> AggregatedTranscriptStats {
    // 总量与缓存覆盖部分使用同一批已去重记录，避免刷新期间追加日志造成两次扫描不一致。
    let (records, incomplete) = read_messages(files);
    let mut detailed = aggregate_messages(&records, incomplete, None, None);
    let Some(cache) = cache else {
        return detailed;
    };
    let cutoff = cache
        .last_computed_date
        .clone()
        .filter(|date| NaiveDate::parse_from_str(date, "%Y-%m-%d").is_ok());
    detailed.token_data_incomplete |= cutoff.is_none();
    let covered = aggregate_messages(&records, incomplete, None, cutoff.as_deref());
    let cached = cache_to_aggregate(cache);
    for (model, usage) in cached.model_usage {
        let known = covered.model_usage.get(&model).cloned().unwrap_or_default();
        let remaining = ClaudeStatsModelUsage {
            input_tokens: usage.input_tokens.saturating_sub(known.input_tokens),
            output_tokens: usage.output_tokens.saturating_sub(known.output_tokens),
            cache_read_input_tokens: usage
                .cache_read_input_tokens
                .saturating_sub(known.cache_read_input_tokens),
            cache_creation_input_tokens: usage
                .cache_creation_input_tokens
                .saturating_sub(known.cache_creation_input_tokens),
        };
        let total = remaining.total_tokens();
        if total > 0 {
            detailed.undated_tokens += total;
            detailed.token_data_incomplete = true;
            detailed.token_breakdown.add_model_usage(&remaining);
            merge_model_usage(
                &mut detailed.model_usage,
                BTreeMap::from([(model, remaining)]),
            );
        }
    }
    // 缓存仍能证明哪些日期有活动，但无法恢复缺失请求的日计数与 Token，单独保留日期事实。
    detailed.historical_active_dates.extend(
        cached
            .daily_activity
            .values()
            .filter(|day| day.message_count > 0 || day.session_count > 0)
            .map(|day| day.date.clone()),
    );
    // 官方历史缓存按主会话记录计数，不能用子代理数量抵消已丢失的主会话。
    let covered_main = records.iter().filter(|record| {
        !record.is_subagent
            && record
                .timestamp
                .as_ref()
                .map(local_date_string)
                .is_none_or(|date| {
                    cutoff
                        .as_deref()
                        .is_none_or(|cutoff| date.as_str() <= cutoff)
                })
    });
    let mut main_sessions = BTreeSet::new();
    let mut main_messages = 0_u64;
    for record in covered_main {
        main_messages += 1;
        main_sessions.insert(record.session_id.clone());
    }
    let missing_messages = cached.total_messages.saturating_sub(main_messages);
    let missing_sessions = cached
        .total_sessions
        .saturating_sub(main_sessions.len() as u64);
    detailed.total_messages += missing_messages;
    detailed.total_sessions += missing_sessions;
    detailed.token_data_incomplete |= missing_messages > 0 || missing_sessions > 0;
    detailed.longest_session_ms = detailed.longest_session_ms.max(cached.longest_session_ms);
    if let Some(first) = cached.first_session_date {
        update_min_string(&mut detailed.first_session_date, first);
    }
    if let Some(last) = cached.last_session_date {
        update_max_string(&mut detailed.last_session_date, last);
    }
    detailed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(directory: &Path, name: &str, messages: &[Value]) -> PathBuf {
        let path = directory.join(name);
        let content = messages
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&path, content).expect("fixture");
        path
    }

    fn message(id: &str, timestamp: &str, input: u64, cache: u64) -> Value {
        json!({
            "type": "assistant", "timestamp": timestamp,
            "message": {"id": id, "model": "claude-fixture", "usage": {
                "input_tokens": input, "output_tokens": 10, "cache_read_input_tokens": cache
            }}
        })
    }

    #[test]
    fn claude_cross_day_usage_and_resumed_history_follow_event_dates() {
        let dir = tempfile::tempdir().expect("temp");
        let path = fixture(
            dir.path(),
            "session.jsonl",
            &[
                message("one", "2026-09-01T12:00:00Z", 100, 0),
                message("two", "2026-09-02T12:00:00Z", 210, 0),
            ],
        );
        let first = local_date_string(&parse_timestamp_utc("2026-09-01T12:00:00Z").expect("time"));
        let second = local_date_string(&parse_timestamp_utc("2026-09-02T12:00:00Z").expect("time"));
        let stats = process_files(std::slice::from_ref(&path), None, None);
        assert_eq!(stats.daily_model_tokens[&first]["claude-fixture"], 110);
        assert_eq!(stats.daily_model_tokens[&second]["claude-fixture"], 220);
        let resumed = process_files(&[path], Some(&second), None);
        assert_eq!(resumed.total_tokens(), 220);
    }

    #[test]
    fn claude_copied_and_streamed_messages_are_counted_once_before_date_filtering() {
        let dir = tempfile::tempdir().expect("temp");
        let a = message("same", "2026-09-01T12:00:00Z", 100, 200);
        let b = message("same", "2026-09-02T12:00:00Z", 100, 200);
        let first = fixture(dir.path(), "a.jsonl", &[a, b.clone()]);
        let fork = fixture(dir.path(), "b.jsonl", &[b]);
        let files = vec![first, fork];
        let stats = process_files(&files, None, None);
        assert_eq!(stats.total_tokens(), 310);
        assert_eq!(stats.total_messages, 1);
        let second = local_date_string(&parse_timestamp_utc("2026-09-02T12:00:00Z").expect("time"));
        assert_eq!(process_files(&files, Some(&second), None).total_tokens(), 0);
    }

    #[test]
    fn claude_cache_preserves_only_missing_totals_without_inventing_daily_usage() {
        let dir = tempfile::tempdir().expect("temp");
        let path = fixture(
            dir.path(),
            "session.jsonl",
            &[
                message("old", "2026-09-01T12:00:00Z", 100, 200),
                message("new", "2026-09-02T12:00:00Z", 50, 40),
            ],
        );
        let cutoff = local_date_string(&parse_timestamp_utc("2026-09-01T12:00:00Z").expect("time"));
        let cache = serde_json::from_value(json!({
            "lastComputedDate": cutoff, "totalMessages": 2, "totalSessions": 1,
            "dailyModelTokens": [{"date": cutoff, "tokensByModel": {"claude-fixture": 170}}],
            "modelUsage": {"claude-fixture": {"inputTokens": 150, "outputTokens": 20, "cacheReadInputTokens": 300}}
        })).expect("cache");
        let stats = reconcile_cache(Some(cache), &[path]);
        assert_eq!(stats.total_tokens(), 570);
        assert_eq!(stats.undated_tokens, 160);
        assert_eq!(
            stats
                .daily_model_tokens
                .values()
                .flat_map(|m| m.values())
                .sum::<u64>(),
            410
        );
        assert!(stats.token_data_incomplete);
        assert_eq!(stats.token_breakdown.total_tokens, stats.total_tokens());
    }

    #[test]
    fn claude_known_usage_without_timestamp_is_retained_as_undated() {
        let dir = tempfile::tempdir().expect("temp");
        let mut record = message("untimed", "invalid", 100, 50);
        record.as_object_mut().expect("object").remove("timestamp");
        let path = fixture(dir.path(), "session.jsonl", &[record]);
        let stats = process_files(&[path], None, None);
        assert_eq!(stats.total_tokens(), 160);
        assert_eq!(stats.undated_tokens, 160);
        assert!(stats.daily_model_tokens.is_empty());
        assert!(stats.token_data_incomplete);
    }

    #[test]
    fn claude_cache_only_retains_proven_active_dates_without_daily_token_estimates() {
        let cache = serde_json::from_value(json!({
            "lastComputedDate": "2026-09-02", "totalMessages": 2, "totalSessions": 1,
            "dailyActivity": [
                {"date": "2026-09-01", "messageCount": 1},
                {"date": "2026-09-02", "messageCount": 1}
            ],
            "modelUsage": {"fixture": {"inputTokens": 40}}
        }))
        .expect("cache");
        let stats = reconcile_cache(Some(cache), &[]);
        assert_eq!(stats.total_tokens(), 40);
        assert_eq!(stats.undated_tokens, 40);
        assert!(stats.daily_model_tokens.is_empty());
        let overview = build_usage_overview_from_aggregate(stats, Vec::new());
        assert_eq!(overview.summary.active_days, 2);
        assert_eq!(overview.summary.longest_streak_days, 2);
    }

    #[test]
    fn claude_missing_usage_and_cache_cutoff_are_explicitly_partial() {
        let dir = tempfile::tempdir().expect("temp");
        let mut record = message("missing", "2026-09-01T12:00:00Z", 100, 0);
        record["message"]
            .as_object_mut()
            .expect("object")
            .remove("usage");
        let path = fixture(dir.path(), "session.jsonl", &[record]);
        assert!(process_files(&[path], None, None).token_data_incomplete);
        let cache = serde_json::from_value(json!({
            "modelUsage": {"fixture": {"inputTokens": 100}}
        }))
        .expect("cache");
        assert!(reconcile_cache(Some(cache), &[]).token_data_incomplete);
    }

    #[test]
    fn claude_subagent_counts_cannot_cancel_missing_cached_main_sessions() {
        let dir = tempfile::tempdir().expect("temp");
        let root = fixture(
            dir.path(),
            "main.jsonl",
            &[message("root", "2026-09-01T12:00:00Z", 100, 0)],
        );
        let subdir = dir.path().join("subagents");
        fs::create_dir(&subdir).expect("directory");
        let child = fixture(
            &subdir,
            "agent-child.jsonl",
            &[message("child", "2026-09-01T12:00:00Z", 50, 0)],
        );
        let cutoff = local_date_string(&parse_timestamp_utc("2026-09-01T12:00:00Z").expect("time"));
        let cache = serde_json::from_value(json!({
            "lastComputedDate": cutoff, "totalSessions": 2, "totalMessages": 2
        }))
        .expect("cache");
        let stats = reconcile_cache(Some(cache), &[root, child]);
        assert_eq!(stats.total_sessions, 3);
        assert_eq!(stats.total_messages, 3);
        assert!(stats.token_data_incomplete);
    }
}
