use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const QUIET_PERIOD: Duration = Duration::from_secs(10);
const MIN_UPDATE_INTERVAL: Duration = Duration::from_secs(30);
const MAX_CHANGE_AGE: Duration = Duration::from_secs(60);
pub(super) const MAX_PENDING_PATHS: usize = 1_024;

#[derive(Default)]
pub(super) struct ProjectRuntime {
    pub changes: Mutex<PendingChanges>,
    // 手动重建与后台增量写入必须串行，搜索仍可读取已提交的数据库。
    pub writer: Mutex<()>,
}

#[derive(Default)]
pub(super) struct PendingChanges {
    pub revision: u64,
    pub paths: HashMap<PathBuf, u64>,
    pub reconcile: Option<u64>,
    pub writing: bool,
    active_searches: usize,
    first_change: Option<Instant>,
    last_change: Option<Instant>,
    last_update: Option<Instant>,
}

pub(super) struct UpdateBatch {
    pub revision: u64,
    pub paths: Vec<PathBuf>,
    pub reconcile: bool,
}

impl PendingChanges {
    pub fn searches_active(&self) -> bool {
        self.active_searches > 0
    }

    pub fn record(&mut self, paths: Vec<PathBuf>, reconcile: bool, now: Instant) {
        if paths.is_empty() && !reconcile {
            return;
        }
        self.revision += 1;
        self.first_change.get_or_insert(now);
        self.last_change = Some(now);
        for path in paths {
            self.paths.insert(path, self.revision);
            if self.paths.len() > MAX_PENDING_PATHS {
                // 事件风暴时限制内存；完整核对前搜索保守回退到扫描。
                self.paths.clear();
                self.reconcile = Some(self.revision);
            }
        }
        if reconcile {
            self.reconcile = Some(self.revision);
        }
    }

    pub fn scheduled_batch(&mut self, now: Instant) -> Option<UpdateBatch> {
        let first = self.first_change?;
        let last = self.last_change?;
        if self.writing || self.active_searches > 0 {
            return None;
        }
        if self
            .last_update
            .is_some_and(|last| now.duration_since(last) < MIN_UPDATE_INTERVAL)
        {
            return None;
        }
        if now.duration_since(last) < QUIET_PERIOD && now.duration_since(first) < MAX_CHANGE_AGE {
            return None;
        }
        self.writing = true;
        Some(UpdateBatch {
            revision: self.revision,
            paths: self.paths.keys().cloned().collect(),
            reconcile: self.reconcile.is_some(),
        })
    }

    pub fn acknowledge(&mut self, revision: u64, now: Instant) {
        self.paths.retain(|_, changed_at| *changed_at > revision);
        if self
            .reconcile
            .is_some_and(|changed_at| changed_at <= revision)
        {
            self.reconcile = None;
        }
        self.last_update = Some(now);
        self.first_change = if self.paths.is_empty() && self.reconcile.is_none() {
            self.last_change = None;
            None
        } else {
            // 更新期间再次发生的变更保留在下一批，不能随着本批一起清除。
            self.last_change
        };
    }
}

pub(crate) struct SearchActivityGuard(Arc<ProjectRuntime>);

impl ProjectRuntime {
    pub fn begin_search(self: &Arc<Self>) -> SearchActivityGuard {
        if let Ok(mut changes) = self.changes.lock() {
            changes.active_searches += 1;
        }
        SearchActivityGuard(self.clone())
    }
}

impl Drop for SearchActivityGuard {
    fn drop(&mut self) {
        if let Ok(mut changes) = self.0.changes.lock() {
            changes.active_searches = changes.active_searches.saturating_sub(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_wait_for_quiet_and_respect_update_interval() {
        let now = Instant::now();
        let mut changes = PendingChanges::default();
        changes.record(vec!["main.rs".into()], false, now);
        assert!(changes
            .scheduled_batch(now + Duration::from_secs(5))
            .is_none());
        let batch = changes.scheduled_batch(now + QUIET_PERIOD).unwrap();
        changes.acknowledge(batch.revision, now + QUIET_PERIOD);
        changes.writing = false;
        changes.record(vec!["main.rs".into()], false, now + Duration::from_secs(15));
        assert!(changes
            .scheduled_batch(now + Duration::from_secs(25))
            .is_none());
        assert!(changes
            .scheduled_batch(now + Duration::from_secs(40))
            .is_some());
    }

    #[test]
    fn continuous_saves_flush_at_maximum_age_without_counting_duplicates() {
        let now = Instant::now();
        let mut changes = PendingChanges::default();
        for seconds in (0..=60).step_by(5) {
            changes.record(
                vec!["main.rs".into()],
                false,
                now + Duration::from_secs(seconds),
            );
        }
        let batch = changes.scheduled_batch(now + MAX_CHANGE_AGE).unwrap();
        assert_eq!(batch.paths.len(), 1);
        assert!(!batch.reconcile);
    }

    #[test]
    fn committing_a_batch_preserves_newer_edits_and_reconciliation() {
        let now = Instant::now();
        let path = PathBuf::from("main.rs");
        let mut changes = PendingChanges::default();
        changes.record(vec![path.clone()], false, now);
        let batch = changes.scheduled_batch(now + QUIET_PERIOD).unwrap();
        changes.record(vec![path.clone()], true, now + QUIET_PERIOD);
        changes.acknowledge(batch.revision, now + QUIET_PERIOD);
        assert!(changes.paths.contains_key(&path));
        assert!(changes.reconcile.is_some());
    }

    #[test]
    fn active_searches_and_writers_defer_batches_and_release_on_drop() {
        let now = Instant::now();
        let runtime = Arc::new(ProjectRuntime::default());
        runtime
            .changes
            .lock()
            .unwrap()
            .record(vec!["main.rs".into()], false, now);
        let first = runtime.begin_search();
        let second = runtime.begin_search();
        drop(first);
        assert!(runtime
            .changes
            .lock()
            .unwrap()
            .scheduled_batch(now + MAX_CHANGE_AGE)
            .is_none());
        drop(second);
        assert!(runtime
            .changes
            .lock()
            .unwrap()
            .scheduled_batch(now + MAX_CHANGE_AGE)
            .is_some());
        assert!(runtime
            .changes
            .lock()
            .unwrap()
            .scheduled_batch(now + MAX_CHANGE_AGE)
            .is_none());
    }

    #[test]
    fn event_storms_bound_memory_and_require_reconciliation() {
        let mut changes = PendingChanges::default();
        changes.record(
            (0..10_000)
                .map(|i| PathBuf::from(format!("{i}.rs")))
                .collect(),
            false,
            Instant::now(),
        );
        assert!(changes.paths.len() <= MAX_PENDING_PATHS);
        assert!(changes.reconcile.is_some());
    }

    #[test]
    fn duplicate_events_do_not_request_reconciliation_and_failed_batches_can_retry() {
        let now = Instant::now();
        let mut changes = PendingChanges::default();
        changes.record(vec![PathBuf::from("main.rs"); 10_000], false, now);
        let batch = changes.scheduled_batch(now + MAX_CHANGE_AGE).unwrap();
        assert_eq!(batch.paths.len(), 1);
        assert!(!batch.reconcile);
        // 写入失败时不确认批次，下一次调度仍必须拿到原来的路径。
        changes.writing = false;
        let retry = changes.scheduled_batch(now + MAX_CHANGE_AGE).unwrap();
        assert_eq!(retry.paths, batch.paths);
        changes.acknowledge(retry.revision, now + MAX_CHANGE_AGE);
        changes.writing = false;
        assert!(changes
            .scheduled_batch(now + MAX_CHANGE_AGE + MIN_UPDATE_INTERVAL)
            .is_none());
    }
}
