//! 为智能体提供工作台选中任务的上下文，用户不必描述技能或调用协议。
use crate::runtime_output::{
    RuntimeOutputRead, RuntimeOutputStore, RuntimeTerminalInfo, TerminalKind,
};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;

#[derive(Default)]
pub(crate) struct RuntimeContext {
    selected_runners: Mutex<HashMap<String, String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentRuntimeContext {
    project_path: String,
    selection_source: &'static str,
    selected_run: Option<RuntimeTerminalInfo>,
    available_runs: Vec<RuntimeTerminalInfo>,
    output: Option<RuntimeOutputRead>,
}

impl RuntimeContext {
    pub fn select_runner(&self, project: &str, session: Option<String>) {
        let project = project_key(project);
        let mut selected = self.selected_runners.lock();
        if let Some(session) = session {
            selected.insert(project, session);
        } else {
            selected.remove(&project);
        }
    }

    pub fn snapshot(
        &self,
        output: &RuntimeOutputStore,
        project: &str,
        caller: Option<&str>,
        include_output: bool,
    ) -> AgentRuntimeContext {
        let runs: Vec<_> = output
            .list(Some(project))
            .into_iter()
            .filter(|run| {
                Some(run.session_id.as_str()) != caller && !matches!(run.kind, TerminalKind::Agent)
            })
            .collect();
        let selected_session = self
            .selected_runners
            .lock()
            .get(&project_key(project))
            .cloned();
        let active = selected_session.as_deref().and_then(|session| {
            runs.iter()
                .rev()
                .find(|run| run.session_id == session && matches!(run.kind, TerminalKind::Runner))
        });
        let (selected, source) = if let Some(run) = active {
            (Some(run), "active_runner")
        } else if let Some(run) = runs
            .iter()
            .rev()
            .find(|run| matches!(run.kind, TerminalKind::Runner))
        {
            (Some(run), "latest_runner")
        } else {
            (runs.last(), "latest_terminal")
        };
        let log = if include_output {
            selected.and_then(|run| output.read(&run.id, None, 80, 8192).ok())
        } else {
            None
        };
        AgentRuntimeContext {
            project_path: project.into(),
            selection_source: if selected.is_some() { source } else { "none" },
            selected_run: selected.cloned(),
            available_runs: runs.iter().rev().take(8).cloned().collect(),
            output: log,
        }
    }
}

fn project_key(project: &str) -> String {
    let key = project.replace('\\', "/").trim_end_matches('/').to_string();
    if cfg!(windows) {
        key.to_ascii_lowercase()
    } else {
        key
    }
}

pub(crate) fn hook_bridge() -> &'static str {
    include_str!("runtime_hooks/bridge.cjs")
}

#[cfg(test)]
pub(crate) fn check_native_integration(mode: &str, source: &str) {
    let directory = tempfile::tempdir().unwrap();
    let extension = if matches!(mode, "pi" | "opencode") {
        "mjs"
    } else {
        "cjs"
    };
    let script = directory.path().join(format!("provider.{extension}"));
    let helper = directory.path().join("runtime-context.cjs");
    let test = directory.path().join("integration.test.cjs");
    std::fs::write(&script, source).unwrap();
    std::fs::write(&helper, include_str!("runtime_hooks/context.cjs")).unwrap();
    std::fs::write(&test, include_str!("runtime_hooks/integration.test.cjs")).unwrap();
    let output = std::process::Command::new("node")
        .arg(test)
        .arg(mode)
        .arg(script)
        .arg(helper)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{mode}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_output::RuntimeTerminalMetadata;

    #[test]
    fn automatically_fetches_logs_for_natural_requests_and_stays_inert_outside_termflow() {
        check_native_integration("helper", "");
    }

    #[test]
    fn uses_visible_runner_instead_of_a_newer_background_task() {
        let output = RuntimeOutputStore::default();
        let context = RuntimeContext::default();
        let first = output.start(
            "first",
            1,
            "project",
            "powershell",
            1,
            Some(RuntimeTerminalMetadata {
                label: "你好".into(),
                kind: TerminalKind::Runner,
            }),
        );
        first.lock().append("你好: command not found");
        first.lock().finish(Some(1), false);
        output.start(
            "background",
            2,
            "project",
            "powershell",
            2,
            Some(RuntimeTerminalMetadata {
                label: "Background".into(),
                kind: TerminalKind::Runner,
            }),
        );
        context.select_runner("project", Some("first".into()));
        let snapshot = context.snapshot(&output, "project", Some("agent"), true);
        assert_eq!(snapshot.selection_source, "active_runner");
        assert_eq!(snapshot.selected_run.unwrap().session_id, "first");
        assert_eq!(snapshot.output.unwrap().text, "你好: command not found");
    }

    #[test]
    fn excludes_agent_transcripts_other_projects_and_logs_when_not_requested() {
        let output = RuntimeOutputStore::default();
        let context = RuntimeContext::default();
        output
            .start("caller", 1, "project", "codex", 0, None)
            .lock()
            .append("private agent transcript");
        output
            .start("other", 2, "another", "cmd", 0, None)
            .lock()
            .append("another project");
        output
            .start("shell", 3, "project", "cmd", 0, None)
            .lock()
            .append("application output");
        let snapshot = context.snapshot(&output, "project", Some("caller"), false);
        assert_eq!(snapshot.available_runs.len(), 1);
        assert!(snapshot.output.is_none());
        assert_eq!(snapshot.selected_run.unwrap().session_id, "shell");
    }
}
