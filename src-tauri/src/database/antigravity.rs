//! Antigravity 本地生成计数。字段参考 OpenUsage 的 AntigravityProtoDecoder：
//! https://github.com/robinebers/openusage/blob/main/Sources/OpenUsage/Providers/Antigravity/AntigravityProtoDecoder.swift
//! 未公开的格式必须校验边界；不保存提示词、响应或原始 protobuf。
use rusqlite::{Connection, OpenFlags};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime},
};

const MAX_BLOB_BYTES: i64 = 1_048_576;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Generation {
    pub model: String,
    pub timestamp: i64,
    pub input: u64,
    pub output: u64,
    pub cache: u64,
}

#[derive(Clone, Default)]
pub(crate) struct Conversation {
    pub events: Vec<Generation>,
    pub incomplete: bool,
}

#[derive(Default)]
pub(crate) struct Scan {
    pub conversations: BTreeMap<PathBuf, Conversation>,
    pub incomplete: bool,
}

fn varint(data: &[u8], offset: &mut usize) -> Option<u64> {
    let mut value = 0;
    for shift in (0..70).step_by(7) {
        let byte = *data.get(*offset)?;
        *offset += 1;
        if shift == 63 && byte > 1 {
            return None;
        }
        value |= u64::from(byte & 127) << shift;
        if byte < 128 {
            return Some(value);
        }
    }
    None
}

enum Field<'a> {
    Number(u64),
    Bytes(&'a [u8]),
}

fn field(data: &[u8], number: u64) -> Option<Field<'_>> {
    let mut offset = 0;
    while offset < data.len() {
        let tag = varint(data, &mut offset)?;
        if tag >> 3 == 0 {
            return None;
        }
        let value = match tag & 7 {
            0 => Field::Number(varint(data, &mut offset)?),
            2 => {
                let size = usize::try_from(varint(data, &mut offset)?).ok()?;
                let end = offset.checked_add(size)?;
                let bytes = data.get(offset..end)?;
                offset = end;
                Field::Bytes(bytes)
            }
            1 | 5 => {
                offset = offset.checked_add(if tag & 7 == 1 { 8 } else { 4 })?;
                if offset > data.len() {
                    return None;
                }
                continue;
            }
            _ => return None,
        };
        if tag >> 3 == number {
            return Some(value);
        }
    }
    None
}

fn bytes(data: &[u8], number: u64) -> Option<&[u8]> {
    match field(data, number)? {
        Field::Bytes(value) => Some(value),
        _ => None,
    }
}
fn number(data: &[u8], key: u64) -> u64 {
    match field(data, key) {
        Some(Field::Number(value)) => value,
        _ => 0,
    }
}
fn name(data: &[u8], key: u64) -> Option<&str> {
    std::str::from_utf8(bytes(data, key)?)
        .ok()
        .map(str::trim)
        .filter(|s| !s.is_empty())
}
fn timestamp(data: &[u8]) -> Option<i64> {
    i64::try_from(number(data, 1))
        .ok()
        .filter(|value| *value > 0 && chrono::DateTime::from_timestamp(*value, 0).is_some())
}

fn decode(data: &[u8], step: Option<&[u8]>) -> Option<Generation> {
    let event = bytes(data, 1)?;
    let usage = bytes(event, 4)?;
    let id = name(event, 19);
    let label = name(event, 21);
    let model = if id.is_some_and(|s| s.ends_with("-default")) {
        label.or(id)
    } else {
        id.or(label)
    };
    let input = number(usage, 1).checked_add(number(usage, 2))?;
    let output = number(usage, 3);
    let cache = number(usage, 5);
    // 只有系统提示计数且没有模型的记录属于上下文记账，不是生成请求。
    if model.is_none() && number(usage, 2) == 0 && output == 0 && cache == 0 {
        return None;
    }
    let total = input.checked_add(output)?.checked_add(cache)?;
    if total == 0 || total > i64::MAX as u64 {
        return None;
    }
    let time = bytes(event, 9)
        .and_then(|b| bytes(b, 4))
        .and_then(timestamp)
        .or_else(|| step.and_then(|b| bytes(b, 1)).and_then(timestamp))?;
    let model = model.unwrap_or("antigravity-unknown");
    Some(Generation {
        model: model.strip_suffix("-tiered").unwrap_or(model).into(),
        timestamp: time,
        input,
        output,
        cache,
    })
}

fn read(path: &Path) -> Result<Conversation, rusqlite::Error> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(Duration::from_millis(250))?;
    let has_step: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('steps') WHERE name='metadata')",
        [],
        |row| row.get(0),
    )?;
    let step = if has_step {
        "(SELECT CASE WHEN length(metadata)<=1048576 THEN metadata END FROM steps WHERE idx=g.idx)"
    } else {
        "NULL"
    };
    let sql = format!("SELECT CASE WHEN length(data)<=?1 THEN data END, {step} FROM gen_metadata g WHERE data IS NOT NULL ORDER BY idx");
    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement.query([MAX_BLOB_BYTES])?;
    let mut result = Conversation::default();
    while let Some(row) = rows.next()? {
        let data: Option<Vec<u8>> = row.get(0)?;
        let step: Option<Vec<u8>> = row.get(1)?;
        // 无模型的纯系统提示记账记录可以正常跳过，不表示数据损坏。
        if data
            .as_deref()
            .and_then(|data| bytes(data, 1))
            .is_some_and(|event| {
                name(event, 19).is_none()
                    && name(event, 21).is_none()
                    && bytes(event, 4).is_some_and(|usage| {
                        number(usage, 1) > 0
                            && [2, 3, 5].into_iter().all(|key| number(usage, key) == 0)
                    })
            })
        {
            continue;
        }
        match data.as_deref().and_then(|b| decode(b, step.as_deref())) {
            Some(event) => result.events.push(event),
            None => result.incomplete = true,
        }
    }
    Ok(result)
}

type Fingerprint = (u64, Option<SystemTime>, Option<(u64, Option<SystemTime>)>);
fn fingerprint(path: &Path) -> Option<Fingerprint> {
    let metadata = fs::metadata(path).ok()?;
    let mut wal = path.as_os_str().to_os_string();
    wal.push("-wal");
    let wal = fs::metadata(PathBuf::from(wal))
        .ok()
        .map(|m| (m.len(), m.modified().ok()));
    Some((metadata.len(), metadata.modified().ok(), wal))
}

#[derive(Default)]
struct Cache {
    entries: BTreeMap<PathBuf, (Fingerprint, Conversation)>,
}

impl Cache {
    fn scan(&mut self, home: &Path) -> Scan {
        let mut result = Scan::default();
        let mut seen = BTreeSet::new();
        let entries = match fs::read_dir(home) {
            Ok(entries) => entries,
            Err(error) => {
                result.incomplete = error.kind() != std::io::ErrorKind::NotFound;
                return result;
            }
        };
        for entry in entries {
            let Ok(entry) = entry else {
                result.incomplete = true;
                continue;
            };
            if !entry
                .file_name()
                .to_string_lossy()
                .starts_with("antigravity")
            {
                continue;
            }
            let directory = entry.path().join("conversations");
            let files = match fs::read_dir(directory) {
                Ok(files) => files,
                Err(error) => {
                    result.incomplete |= error.kind() != std::io::ErrorKind::NotFound;
                    continue;
                }
            };
            for file in files {
                let Ok(file) = file else {
                    result.incomplete = true;
                    continue;
                };
                let path = file.path();
                if path.extension().is_none_or(|ext| ext != "db") {
                    continue;
                }
                let Ok(path) = path.canonicalize() else {
                    result.incomplete = true;
                    continue;
                };
                if !seen.insert(path.clone()) {
                    continue;
                }
                let Some(before) = fingerprint(&path) else {
                    result.incomplete = true;
                    continue;
                };
                let conversation = if let Some((_, value)) =
                    self.entries.get(&path).filter(|(key, _)| *key == before)
                {
                    Ok(value.clone())
                } else {
                    // 已有 idx 也可能补写 token；变更时重读该会话，避免 append-only 缓存漏计。
                    read(&path)
                };
                match conversation {
                    Ok(value) => {
                        if fingerprint(&path).as_ref() == Some(&before) {
                            self.entries.insert(path.clone(), (before, value.clone()));
                        }
                        result.incomplete |= value.incomplete;
                        result.conversations.insert(path, value);
                    }
                    Err(_) => {
                        result.incomplete = true;
                        self.entries.remove(&path);
                    }
                }
            }
        }
        self.entries.retain(|path, _| seen.contains(path));
        result
    }
}

pub(crate) fn scan(home: &Path) -> Scan {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    match CACHE.get_or_init(|| Mutex::new(Cache::default())).lock() {
        Ok(mut cache) => cache.scan(home),
        Err(_) => Scan {
            incomplete: true,
            ..Scan::default()
        },
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn encode_varint(mut value: u64) -> Vec<u8> {
        let mut result = Vec::new();
        while value >= 128 {
            result.push((value as u8 & 127) | 128);
            value >>= 7;
        }
        result.push(value as u8);
        result
    }
    fn n(key: u64, value: u64) -> Vec<u8> {
        [encode_varint(key << 3), encode_varint(value)].concat()
    }
    fn b(key: u64, value: &[u8]) -> Vec<u8> {
        [
            encode_varint(key << 3 | 2),
            encode_varint(value.len() as u64),
            value.to_vec(),
        ]
        .concat()
    }
    pub(crate) fn fixture() -> Vec<u8> {
        b(
            1,
            &[
                b(4, &[n(1, 10), n(2, 100), n(3, 20), n(5, 1000)].concat()),
                b(19, b"gemini-default"),
                b(21, b"Gemini 3.8 Flash"),
                b(9, &b(4, &n(1, 1_789_430_400))),
            ]
            .concat(),
        )
    }
    pub(crate) fn create_database(path: &Path) -> Connection {
        fs::create_dir_all(path.parent().expect("parent")).expect("directory");
        let db = Connection::open(path).expect("database");
        db.execute_batch("CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps(idx INTEGER PRIMARY KEY, metadata BLOB);").expect("schema");
        db.execute("INSERT INTO gen_metadata VALUES(1, ?1)", [fixture()])
            .expect("generation");
        db
    }

    #[test]
    fn decodes_separate_cache_and_system_tokens_and_actual_model() {
        let event = decode(&fixture(), None).expect("event");
        assert_eq!((event.input, event.output, event.cache), (110, 20, 1000));
        assert_eq!(event.model, "Gemini 3.8 Flash");
        assert_eq!(event.timestamp, 1_789_430_400);
    }

    #[test]
    fn uses_step_time_and_does_not_guess_file_time() {
        let data = b(
            1,
            &[b(4, &n(2, 42)), b(19, b"gemini-flash-tiered")].concat(),
        );
        assert!(decode(&data, None).is_none());
        let event = decode(&data, Some(&b(1, &n(1, 1_789_430_400)))).expect("step time");
        assert_eq!(event.model, "gemini-flash");
    }

    #[test]
    fn rejects_truncated_overflow_and_context_only_records() {
        for data in [
            vec![10, 255],
            vec![255; 20],
            vec![0],
            b(1, &b(4, &n(1, 10))),
        ] {
            assert!(decode(&data, None).is_none());
        }
        let data = b(1, &b(4, &[n(1, u64::MAX), n(2, 1)].concat()));
        assert!(decode(&data, None).is_none());
    }

    #[test]
    fn refreshes_wal_updates_and_repeated_scans_do_not_duplicate_events() {
        let home = tempfile::tempdir().expect("home");
        let path = home.path().join("antigravity-cli/conversations/session.db");
        let db = create_database(&path);
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
            .expect("wal");
        let mut cache = Cache::default();
        let first = cache.scan(home.path());
        assert_eq!(first.conversations.len(), 1);
        assert_eq!(
            first
                .conversations
                .values()
                .next()
                .expect("conversation")
                .events
                .len(),
            1
        );
        db.execute("INSERT INTO gen_metadata VALUES(2, ?1)", [fixture()])
            .expect("insert");
        for _ in 0..2 {
            let next = cache.scan(home.path());
            assert_eq!(
                next.conversations
                    .values()
                    .next()
                    .expect("conversation")
                    .events
                    .len(),
                2
            );
        }
        db.execute("UPDATE gen_metadata SET data=?1 WHERE idx=1", [vec![0_u8]])
            .expect("update");
        let changed = cache.scan(home.path());
        assert!(changed.incomplete);
        assert_eq!(
            changed
                .conversations
                .values()
                .next()
                .expect("conversation")
                .events
                .len(),
            1
        );
    }

    #[test]
    fn bounds_blobs_and_keeps_healthy_conversations_when_one_database_is_bad() {
        let home = tempfile::tempdir().expect("home");
        let path = home.path().join("antigravity-acp/conversations/session.db");
        let db = create_database(&path);
        db.execute(
            "INSERT INTO gen_metadata VALUES(2, zeroblob(?1))",
            [MAX_BLOB_BYTES + 1],
        )
        .expect("large row");
        fs::write(path.with_file_name("broken.db"), b"invalid database").expect("broken db");
        let result = Cache::default().scan(home.path());
        assert!(result.incomplete);
        assert_eq!(result.conversations.len(), 1);
        assert_eq!(
            result
                .conversations
                .values()
                .next()
                .expect("conversation")
                .events
                .len(),
            1
        );
    }
}
