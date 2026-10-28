//! 所有用量提供方共用的进程内缓存、请求合并与失败退避。
use serde::Serialize;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) const REFRESH_INTERVAL_MS: i64 = 180_000;
const MAX_CACHE_ENTRIES: usize = 2_048;

pub(crate) trait UsageSnapshot: Clone + Serialize {
    fn status(&self) -> &str;
    fn with_failure(&self, failure: Self) -> Self;
    fn same_identity(&self, _other: &Self) -> bool {
        true
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageResponse<T> {
    #[serde(flatten)]
    pub snapshot: T,
    pub next_retry_at: Option<i64>,
    pub checked_at: i64,
}

pub(crate) struct UsageCache<T> {
    pub value: Option<T>,
    last_success: Option<T>,
    pub failures: u32,
    pub attempted_at: i64,
    pub retry_at: i64,
    revision: u64,
}

impl<T> Default for UsageCache<T> {
    fn default() -> Self {
        Self {
            value: None,
            last_success: None,
            failures: 0,
            attempted_at: 0,
            retry_at: 0,
            revision: 0,
        }
    }
}

impl<T: UsageSnapshot> UsageCache<T> {
    pub fn cached(&self, requested_at: i64, now: i64, force: bool) -> Option<T> {
        self.value
            .as_ref()
            .filter(|_| {
                self.attempted_at >= requested_at
                    || now - self.attempted_at < 2_000
                    || (!force && now < self.retry_at)
            })
            .cloned()
    }

    pub fn update(&mut self, mut result: T, now: i64) -> T {
        if result.status() == "ok" {
            self.failures = 0;
            self.retry_at = now + REFRESH_INTERVAL_MS;
            self.last_success = Some(result.clone());
        } else {
            self.failures = self.failures.saturating_add(1);
            self.retry_at = if result.status() == "unavailable" {
                i64::MAX
            } else {
                now + (REFRESH_INTERVAL_MS * (1_i64 << self.failures.saturating_sub(1).min(4)))
                    .min(1_800_000)
            };
            if let Some(previous) = &self.last_success {
                if previous.same_identity(&result) {
                    result = previous.with_failure(result);
                } else {
                    self.last_success = None;
                }
            }
        }
        self.attempted_at = now;
        self.value = Some(result.clone());
        result
    }

    pub fn response(&self, snapshot: T) -> UsageResponse<T> {
        UsageResponse {
            snapshot,
            next_retry_at: (self.retry_at != i64::MAX).then_some(self.retry_at),
            // 返回缓存也代表一次新的身份检查，避免切回旧账号时被前端当成迟到结果。
            checked_at: now_ms(),
        }
    }
}

pub(crate) type SharedUsageCache<T> = Mutex<HashMap<u64, UsageCache<T>>>;

// 锁覆盖查询过程，后到的窗口会复用刚完成的请求，包括手动刷新。
pub(crate) fn query_cached<T: UsageSnapshot>(
    caches: &SharedUsageCache<T>,
    key: u64,
    revision: u64,
    requested_at: i64,
    force: bool,
    fetch: impl FnOnce() -> Result<T, String>,
) -> Result<UsageResponse<T>, String> {
    let mut caches = caches
        .lock()
        .map_err(|_| "Usage cache lock poisoned".to_string())?;
    if !caches.contains_key(&key) && caches.len() >= MAX_CACHE_ENTRIES {
        if let Some(oldest) = caches
            .iter()
            .min_by_key(|(_, entry)| entry.attempted_at)
            .map(|(key, _)| *key)
        {
            caches.remove(&oldest);
        }
    }
    let entry = caches.entry(key).or_default();
    if entry.revision == revision {
        if let Some(value) = entry.cached(requested_at, now_ms(), force) {
            return Ok(entry.response(value));
        }
    }
    let value = entry.update(fetch()?, now_ms());
    entry.revision = revision;
    Ok(entry.response(value))
}

pub(crate) fn fingerprint(value: impl Hash) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

// 只检查元数据，不输出凭据内容；本地快照变化可绕过原有退避。
pub(crate) fn file_revision(path: &Path) -> u64 {
    fingerprint(
        std::fs::metadata(path)
            .ok()
            .map(|metadata| (metadata.len(), metadata.modified().ok())),
    )
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Barrier,
    };

    #[derive(Clone, Serialize)]
    struct Snapshot {
        status: String,
        error: Option<String>,
        identity: u32,
        percent: Option<u32>,
        updated_at: i64,
    }
    impl UsageSnapshot for Snapshot {
        fn status(&self) -> &str {
            &self.status
        }
        fn with_failure(&self, failure: Self) -> Self {
            Self {
                status: failure.status,
                error: failure.error,
                ..self.clone()
            }
        }
        fn same_identity(&self, other: &Self) -> bool {
            self.identity == other.identity
        }
    }
    fn snapshot(status: &str, identity: u32) -> Snapshot {
        Snapshot {
            status: status.into(),
            identity,
            error: (status != "ok").then(|| "offline".into()),
            percent: (status == "ok").then_some(0),
            updated_at: 42,
        }
    }

    #[test]
    fn failure_backoff_is_capped_and_retains_success_timestamp() {
        let mut entry = UsageCache::default();
        entry.update(snapshot("ok", 1), 0);
        for (index, delay) in [180_000, 360_000, 720_000, 1_440_000, 1_800_000, 1_800_000]
            .into_iter()
            .enumerate()
        {
            let now = 10_000 + index as i64;
            let mut failure = snapshot("error", 1);
            failure.updated_at = 999;
            let result = entry.update(failure, now);
            assert_eq!(entry.retry_at - now, delay);
            assert_eq!(result.percent, Some(0));
            assert_eq!(result.updated_at, 42);
            assert_eq!(result.error.as_deref(), Some("offline"));
        }
        entry.update(snapshot("ok", 1), 1_000_000);
        assert_eq!(entry.failures, 0);
        assert_eq!(entry.retry_at, 1_000_000 + REFRESH_INTERVAL_MS);
    }

    #[test]
    fn unavailable_pauses_queries_but_manual_refresh_and_source_changes_work() {
        let caches = SharedUsageCache::default();
        let calls = AtomicUsize::new(0);
        let requested = now_ms();
        let first = query_cached(&caches, 1, 0, requested, false, || {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(snapshot("unavailable", 1))
        })
        .expect("first response");
        assert_eq!(first.next_retry_at, None);
        query_cached(&caches, 1, 0, requested + 100, false, || {
            panic!("automatic retry must pause")
        })
        .expect("cached");
        // 元数据变化绕过暂停，即使紧接着上次查询。
        let recovered = query_cached(&caches, 1, 1, requested + 100, false, || {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(snapshot("ok", 1))
        })
        .expect("new snapshot");
        assert_eq!(recovered.snapshot.status, "ok");
        assert!(recovered.next_retry_at.is_some());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let mut entry = UsageCache::default();
        entry.update(snapshot("unavailable", 1), 100);
        assert!(entry.cached(3_000, 3_000, false).is_some());
        assert!(entry.cached(3_000, 3_000, true).is_none());
    }

    #[test]
    fn changed_identity_cannot_reuse_successful_quota() {
        let mut entry = UsageCache::default();
        entry.update(snapshot("ok", 1), 0);
        let result = entry.update(snapshot("error", 2), 10_000);
        assert_eq!(result.percent, None);
        assert_eq!(result.identity, 2);
    }

    #[test]
    fn windows_share_one_query_and_different_keys_are_isolated() {
        let caches = Arc::new(SharedUsageCache::<Snapshot>::default());
        let barrier = Arc::new(Barrier::new(8));
        let calls = Arc::new(AtomicUsize::new(0));
        let requested = now_ms();
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let (caches, barrier, calls) = (caches.clone(), barrier.clone(), calls.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    query_cached(&caches, 1, 0, requested, true, || {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok(snapshot("ok", 1))
                    })
                    .expect("query")
                })
            })
            .collect();
        for thread in threads {
            assert_eq!(thread.join().expect("worker").snapshot.percent, Some(0));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let separate = query_cached(&caches, 2, 0, requested, false, || Ok(snapshot("error", 2)))
            .expect("other account");
        assert_eq!(separate.snapshot.percent, None);
    }

    #[test]
    fn response_metadata_does_not_replace_source_update_time() {
        let mut entry = UsageCache::default();
        let value = entry.update(snapshot("ok", 1), 1000);
        let serialized = serde_json::to_value(entry.response(value)).expect("serialize");
        assert_eq!(serialized["updated_at"], 42);
        assert!(serialized["checkedAt"].as_i64().expect("checked at") >= 1000);
        assert_eq!(serialized["nextRetryAt"], 181000);
    }
}
