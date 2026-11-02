//! CLI 使用独立的有界输出流，不依赖 WebView 是否挂载或终端滚动位置。
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_RETAINED_TERMINALS: usize = 64;
pub const MAX_TERMINAL_OUTPUT_BYTES: usize = 1024 * 1024;
pub const MAX_READ_BYTES: usize = 64 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalKind {
    Agent,
    Terminal,
    Runner,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeTerminalMetadata {
    pub label: String,
    pub kind: TerminalKind,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeTerminalInfo {
    pub id: String,
    pub session_id: String,
    pub project_path: String,
    pub label: String,
    pub kind: TerminalKind,
    pub agent_id: String,
    pub pid: u32,
    pub status: &'static str,
    pub exit_code: Option<i32>,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub retained_bytes: usize,
    pub total_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeOutputRead {
    pub terminal: RuntimeTerminalInfo,
    pub text: String,
    pub start_cursor: String,
    pub next_cursor: String,
    pub has_more: bool,
    pub truncated: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum OutputReadError {
    NotFound,
    InvalidCursor,
    InvalidLimit,
}

// CSI、OSC、DCS 等序列可跨 PTY 分块，不能对每块单独做正则替换。
#[derive(Default)]
enum EscapeState {
    #[default]
    Text,
    Escape,
    Intermediate,
    Csi,
    String(bool),
    StringEscape(bool),
}

#[derive(Default)]
struct OutputSanitizer {
    state: EscapeState,
    previous_cr: bool,
}

impl OutputSanitizer {
    fn push(&mut self, data: &str) -> String {
        let mut text = String::with_capacity(data.len());
        for ch in data.chars() {
            self.state = match self.state {
                EscapeState::Text => {
                    match ch {
                        '\x1b' => {
                            self.state = EscapeState::Escape;
                            continue;
                        }
                        '\u{009b}' => {
                            self.state = EscapeState::Csi;
                            continue;
                        }
                        '\u{009d}' => {
                            self.state = EscapeState::String(true);
                            continue;
                        }
                        '\u{0090}' | '\u{009e}' | '\u{009f}' => {
                            self.state = EscapeState::String(false);
                            continue;
                        }
                        '\r' => text.push('\n'),
                        '\n' if self.previous_cr => {}
                        '\n' | '\t' => text.push(ch),
                        ch if !ch.is_control() => text.push(ch),
                        _ => {}
                    }
                    self.previous_cr = ch == '\r';
                    EscapeState::Text
                }
                EscapeState::Escape => match ch {
                    '[' => EscapeState::Csi,
                    ']' => EscapeState::String(true),
                    'P' | '^' | '_' | 'X' => EscapeState::String(false),
                    '\x20'..='\x2f' => EscapeState::Intermediate,
                    '\x1b' => EscapeState::Escape,
                    _ => EscapeState::Text,
                },
                EscapeState::Intermediate => match ch {
                    '\x20'..='\x2f' => EscapeState::Intermediate,
                    '\x1b' => EscapeState::Escape,
                    _ => EscapeState::Text,
                },
                EscapeState::Csi => match ch {
                    '\x40'..='\x7e' | '\x18' | '\x1a' => EscapeState::Text,
                    '\x1b' => EscapeState::Escape,
                    _ => EscapeState::Csi,
                },
                EscapeState::String(osc) => match ch {
                    '\x07' if osc => EscapeState::Text,
                    '\u{009c}' | '\x18' | '\x1a' => EscapeState::Text,
                    '\x1b' => EscapeState::StringEscape(osc),
                    _ => EscapeState::String(osc),
                },
                EscapeState::StringEscape(osc) => match ch {
                    '\\' | '\u{009c}' => EscapeState::Text,
                    '\x07' if osc => EscapeState::Text,
                    '\x1b' => EscapeState::StringEscape(osc),
                    _ => EscapeState::String(osc),
                },
            };
        }
        text
    }
}

pub struct TerminalOutput {
    info: RuntimeTerminalInfo,
    text: String,
    start: u64,
    capacity: usize,
    sanitizer: OutputSanitizer,
    instance_id: u64,
    capture_enabled: bool,
}

impl TerminalOutput {
    pub fn append(&mut self, data: &str) {
        if !self.capture_enabled {
            return;
        }
        let clean = self.sanitizer.push(data);
        self.info.total_bytes += clean.len() as u64;
        self.text.push_str(&clean);
        if self.text.len() > self.capacity {
            let mut end = self.text.len() - self.capacity;
            while !self.text.is_char_boundary(end) {
                end += 1;
            }
            self.text.drain(..end);
            self.start += end as u64;
        }
        self.info.retained_bytes = self.text.len();
    }

    pub fn finish(&mut self, code: Option<i32>, closed: bool) {
        if self.info.status != "running" {
            return;
        }
        self.info.status = if closed { "closed" } else { "exited" };
        self.info.exit_code = code;
        self.info.ended_at = Some(now_ms());
    }

    fn cursor(&self, offset: u64) -> String {
        format!("{}:{offset}", self.info.id)
    }

    fn read(
        &self,
        cursor: Option<&str>,
        tail: usize,
        limit: usize,
    ) -> Result<RuntimeOutputRead, OutputReadError> {
        if !(4..=MAX_READ_BYTES).contains(&limit) || !(1..=10_000).contains(&tail) {
            return Err(OutputReadError::InvalidLimit);
        }
        let requested = match cursor {
            Some(cursor) => {
                let (id, offset) = cursor
                    .rsplit_once(':')
                    .ok_or(OutputReadError::InvalidCursor)?;
                if id != self.info.id {
                    return Err(OutputReadError::InvalidCursor);
                }
                offset
                    .parse::<u64>()
                    .map_err(|_| OutputReadError::InvalidCursor)?
            }
            None => self.start + tail_start(&self.text, tail) as u64,
        };
        if requested > self.info.total_bytes {
            return Err(OutputReadError::InvalidCursor);
        }
        let start = requested.max(self.start);
        let from = (start - self.start) as usize;
        if !self.text.is_char_boundary(from) {
            return Err(OutputReadError::InvalidCursor);
        }
        let mut to = (from + limit).min(self.text.len());
        while !self.text.is_char_boundary(to) {
            to -= 1;
        }
        Ok(RuntimeOutputRead {
            terminal: self.info.clone(),
            text: self.text[from..to].to_string(),
            start_cursor: self.cursor(start),
            next_cursor: self.cursor(self.start + to as u64),
            has_more: to < self.text.len(),
            truncated: requested < self.start || (cursor.is_none() && (self.start > 0 || from > 0)),
        })
    }
}

fn tail_start(text: &str, lines: usize) -> usize {
    let trimmed = text.strip_suffix('\n').unwrap_or(text);
    trimmed
        .rmatch_indices('\n')
        .nth(lines - 1)
        .map_or(0, |(index, _)| index + 1)
}

pub struct RuntimeOutputStore {
    pub runtime_id: String,
    terminals: Mutex<VecDeque<Arc<Mutex<TerminalOutput>>>>,
}

impl Default for RuntimeOutputStore {
    fn default() -> Self {
        Self {
            runtime_id: format!("{:032x}", rand::random::<u128>()),
            terminals: Mutex::new(VecDeque::new()),
        }
    }
}

impl RuntimeOutputStore {
    pub fn start(
        &self,
        session_id: &str,
        instance_id: u64,
        project_path: &str,
        agent_id: &str,
        pid: u32,
        metadata: Option<RuntimeTerminalMetadata>,
    ) -> Arc<Mutex<TerminalOutput>> {
        let metadata = metadata.unwrap_or_else(|| RuntimeTerminalMetadata {
            label: agent_id.to_string(),
            kind: if matches!(agent_id, "powershell" | "cmd") {
                TerminalKind::Terminal
            } else {
                TerminalKind::Agent
            },
        });
        let output = Arc::new(Mutex::new(TerminalOutput {
            info: RuntimeTerminalInfo {
                id: format!("{}-{instance_id}", self.runtime_id),
                session_id: session_id.into(),
                project_path: project_path.into(),
                label: metadata
                    .label
                    .chars()
                    .filter(|ch| !ch.is_control())
                    .take(256)
                    .collect(),
                kind: metadata.kind,
                agent_id: agent_id.into(),
                pid,
                status: "running",
                exit_code: None,
                started_at: now_ms(),
                ended_at: None,
                retained_bytes: 0,
                total_bytes: 0,
            },
            text: String::new(),
            start: 0,
            capacity: MAX_TERMINAL_OUTPUT_BYTES,
            sanitizer: OutputSanitizer::default(),
            instance_id,
            capture_enabled: true,
        }));
        let mut terminals = self.terminals.lock();
        if terminals.len() >= MAX_RETAINED_TERMINALS {
            let index = terminals
                .iter()
                .position(|item| item.lock().info.status != "running")
                .unwrap_or(0);
            if let Some(evicted) = terminals.remove(index) {
                let mut evicted = evicted.lock();
                evicted.capture_enabled = false;
                evicted.text = String::new();
            }
        }
        terminals.push_back(output.clone());
        output
    }

    pub fn list(&self, project: Option<&str>) -> Vec<RuntimeTerminalInfo> {
        let terminals: Vec<_> = self.terminals.lock().iter().cloned().collect();
        terminals
            .into_iter()
            .filter_map(|item| {
                let output = item.lock();
                project
                    .filter(|project| !same_project(project, &output.info.project_path))
                    .map_or_else(|| Some(output.info.clone()), |_| None)
            })
            .collect()
    }

    pub fn read(
        &self,
        id: &str,
        cursor: Option<&str>,
        tail: usize,
        limit: usize,
    ) -> Result<RuntimeOutputRead, OutputReadError> {
        let output = self
            .terminals
            .lock()
            .iter()
            .find(|item| item.lock().info.id == id)
            .cloned()
            .ok_or(OutputReadError::NotFound)?;
        let result = output.lock().read(cursor, tail, limit);
        result
    }

    pub fn close(&self, session_id: &str, instance_id: u64) {
        for output in self.terminals.lock().iter() {
            let mut output = output.lock();
            if output.info.session_id == session_id && output.instance_id == instance_id {
                output.finish(None, true);
            }
        }
    }
}

fn same_project(left: &str, right: &str) -> bool {
    let normalize = |path: &str| path.replace('\\', "/").trim_end_matches('/').to_string();
    let (left, right) = (normalize(left), normalize(right));
    if cfg!(windows) {
        left.eq_ignore_ascii_case(&right)
    } else {
        left == right
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (RuntimeOutputStore, Arc<Mutex<TerminalOutput>>, String) {
        let store = RuntimeOutputStore::default();
        let output = store.start("s", 1, "project", "powershell", 42, None);
        let id = output.lock().info.id.clone();
        (store, output, id)
    }

    #[test]
    fn strips_escape_sequences_split_across_chunks_without_losing_unicode() {
        let (_, output, _) = fixture();
        for part in [
            "\x1b[3",
            "1m错误🙂\x1b[0m\r",
            "\n\x1b]0;private",
            " title\x07ready\x1bPsecret",
            "\x1b",
            "\\!\x1b(0ok",
        ] {
            output.lock().append(part);
        }
        assert_eq!(output.lock().text, "错误🙂\nready!ok");
    }

    #[test]
    fn cursor_reads_only_new_output_and_pages_without_splitting_utf8() {
        let (store, output, id) = fixture();
        output.lock().append("one\n中文🙂\n");
        let first = store.read(&id, None, 1, 4).unwrap();
        assert_eq!(first.text, "中");
        assert!(first.has_more);
        let second = store
            .read(&id, Some(&first.next_cursor), 1, MAX_READ_BYTES)
            .unwrap();
        assert_eq!(second.text, "文🙂\n");
        assert!(!second.has_more);
        output.lock().append("new");
        assert_eq!(
            store
                .read(&id, Some(&second.next_cursor), 1, MAX_READ_BYTES)
                .unwrap()
                .text,
            "new"
        );
    }

    #[test]
    fn output_is_bounded_and_reports_expired_cursors() {
        let (store, output, id) = fixture();
        let initial = store
            .read(&id, None, 200, MAX_READ_BYTES)
            .unwrap()
            .next_cursor;
        output.lock().capacity = 7;
        output.lock().append("old text中文🙂");
        let read = store
            .read(&id, Some(&initial), 200, MAX_READ_BYTES)
            .unwrap();
        assert_eq!(read.text, "文🙂");
        assert!(read.truncated);
        assert_eq!(read.terminal.retained_bytes, 7);
        assert!(read.terminal.total_bytes > 7);
    }

    #[test]
    fn cursors_cannot_cross_runs_or_point_inside_unicode_or_the_future() {
        let (store, output, id) = fixture();
        output.lock().append("中文");
        for cursor in [
            "another:0".to_string(),
            format!("{id}:1"),
            format!("{id}:99"),
            format!("{id}:-1"),
        ] {
            assert!(matches!(
                store.read(&id, Some(&cursor), 200, 32),
                Err(OutputReadError::InvalidCursor)
            ));
        }
        assert!(matches!(
            store.read(&id, None, 0, 32),
            Err(OutputReadError::InvalidLimit)
        ));
    }

    #[test]
    fn finished_output_survives_exit_and_replaced_sessions_have_distinct_handles() {
        let (store, output, id) = fixture();
        output.lock().append("final error");
        output.lock().finish(Some(7), false);
        let replacement = store.start("s", 2, "project", "cmd", 99, None);
        store.close("s", 1);
        assert_eq!(replacement.lock().info.status, "running");
        assert_ne!(replacement.lock().info.id, id);
        assert_eq!(
            store.read(&id, None, 200, MAX_READ_BYTES).unwrap().text,
            "final error"
        );
        assert_eq!(
            store
                .read(&id, None, 200, MAX_READ_BYTES)
                .unwrap()
                .terminal
                .exit_code,
            Some(7)
        );
        assert!(store.list(Some("other")).is_empty());
    }

    #[test]
    fn retention_prefers_evicting_finished_runs_and_never_grows_unbounded() {
        let (store, output, id) = fixture();
        output.lock().finish(Some(0), false);
        for index in 2..=MAX_RETAINED_TERMINALS as u64 + 1 {
            store.start("s", index, "project", "cmd", 0, None);
        }
        assert_eq!(store.list(None).len(), MAX_RETAINED_TERMINALS);
        assert!(matches!(
            store.read(&id, None, 200, MAX_READ_BYTES),
            Err(OutputReadError::NotFound)
        ));
    }

    #[test]
    fn tails_complete_and_partial_lines_consistently() {
        for text in ["a\nb\nc", "a\nb\nc\n"] {
            assert_eq!(
                &text[tail_start(text, 2)..],
                text.strip_prefix("a\n").unwrap()
            );
        }
    }

    #[test]
    fn evicted_live_readers_stop_allocating_output() {
        let (store, output, _) = fixture();
        output.lock().append("old");
        for index in 2..=MAX_RETAINED_TERMINALS as u64 + 1 {
            store.start("s", index, "project", "cmd", 0, None);
        }
        output.lock().append("new data after eviction");
        assert!(output.lock().text.is_empty());
        assert!(!output.lock().capture_enabled);
    }
}
