use super::Database;
use rusqlite::{params, Connection};

pub const PENDING_IMAGE_TTL_MS: i64 = 24 * 60 * 60 * 1000;
pub const IMAGE_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Debug)]
pub struct ClipboardObject {
    pub file_name: String,
    pub size_bytes: u64,
}

#[derive(Debug, Default)]
pub struct ClipboardTotals {
    pub total: u64,
    pub protected: u64,
    pub legacy: u64,
    pub reclaimable: u64,
    pub count: u64,
}

fn refresh_unreferenced(conn: &Connection, now: i64) -> rusqlite::Result<()> {
    conn.execute("UPDATE terminal_image_objects SET unreferenced_at_ms = NULL
        WHERE EXISTS (SELECT 1 FROM terminal_image_references r WHERE r.file_name = terminal_image_objects.file_name AND r.released_at_ms IS NULL)", [])?;
    conn.execute("UPDATE terminal_image_objects SET unreferenced_at_ms = ?1
        WHERE legacy = 0 AND unreferenced_at_ms IS NULL AND NOT EXISTS
        (SELECT 1 FROM terminal_image_references r WHERE r.file_name = terminal_image_objects.file_name AND r.released_at_ms IS NULL)", [now])?;
    Ok(())
}

impl Database {
    pub fn clipboard_session_available(&self, session_id: &str) -> Result<bool, String> {
        self.conn.lock().query_row("SELECT NOT EXISTS(SELECT 1 FROM terminal_image_deleted_sessions WHERE session_id = ?1)", [session_id], |row| row.get(0)).map_err(|e| e.to_string())
    }

    pub fn clipboard_register(
        &self,
        session_id: &str,
        reference_id: &str,
        file_name: &str,
        size: u64,
        now: i64,
    ) -> Result<(), String> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let deleted: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM terminal_image_deleted_sessions WHERE session_id = ?1)", [session_id], |row| row.get(0)).map_err(|e| e.to_string())?;
        if deleted {
            return Err("terminal.clipboardSessionChanged".into());
        }
        tx.execute("INSERT INTO terminal_image_objects(file_name, size_bytes) VALUES (?1, ?2)
            ON CONFLICT(file_name) DO UPDATE SET size_bytes = excluded.size_bytes, unreferenced_at_ms = NULL", params![file_name, size as i64]).map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO terminal_image_references(id, session_id, file_name, created_at_ms) VALUES (?1, ?2, ?3, ?4)", params![reference_id, session_id, file_name, now]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn clipboard_retain(&self, session_id: &str, reference_id: &str) -> Result<(), String> {
        let changed = self
            .conn
            .lock()
            .execute(
                "UPDATE terminal_image_references SET retained = 1
            WHERE id = ?1 AND session_id = ?2 AND released_at_ms IS NULL
            AND NOT EXISTS (SELECT 1 FROM terminal_image_deleted_sessions WHERE session_id = ?2)",
                params![reference_id, session_id],
            )
            .map_err(|e| e.to_string())?;
        if changed != 1 {
            return Err("terminal.clipboardSessionChanged".into());
        }
        Ok(())
    }

    /// 只释放明确删除的会话；窗口未加载的项目不能被视作删除。
    pub fn clipboard_sync_sessions(
        &self,
        present: &[String],
        removed: &[String],
        now: i64,
    ) -> Result<(), String> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for id in removed {
            tx.execute(
                "INSERT OR IGNORE INTO terminal_image_deleted_sessions(session_id) VALUES (?1)",
                [id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute("UPDATE terminal_image_references SET released_at_ms = COALESCE(released_at_ms, ?1) WHERE session_id = ?2", params![now, id]).map_err(|e| e.to_string())?;
        }
        for id in present {
            tx.execute(
                "DELETE FROM terminal_image_deleted_sessions WHERE session_id = ?1",
                [id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE terminal_image_references SET released_at_ms = NULL WHERE session_id = ?1",
                [id],
            )
            .map_err(|e| e.to_string())?;
        }
        refresh_unreferenced(&tx, now).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn clipboard_expire_pending(&self, now: i64) -> Result<(), String> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM terminal_image_references WHERE retained = 0 AND created_at_ms <= ?1",
            [now - PENDING_IMAGE_TTL_MS],
        )
        .map_err(|e| e.to_string())?;
        refresh_unreferenced(&tx, now).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn clipboard_totals(&self) -> Result<ClipboardTotals, String> {
        self.conn.lock().query_row("SELECT COALESCE(SUM(size_bytes),0),
            COALESCE(SUM(CASE WHEN legacy = 1 OR unreferenced_at_ms IS NULL THEN size_bytes ELSE 0 END),0),
            COALESCE(SUM(CASE WHEN legacy = 1 THEN size_bytes ELSE 0 END),0),
            COALESCE(SUM(CASE WHEN legacy = 0 AND unreferenced_at_ms IS NOT NULL THEN size_bytes ELSE 0 END),0), COUNT(*)
            FROM terminal_image_objects", [], |row| Ok(ClipboardTotals {
                total: row.get(0)?, protected: row.get(1)?, legacy: row.get(2)?, reclaimable: row.get(3)?, count: row.get(4)?,
            })).map_err(|e| e.to_string())
    }

    pub fn clipboard_objects(&self, cutoff: Option<i64>) -> Result<Vec<ClipboardObject>, String> {
        let conn = self.conn.lock();
        let mut statement = conn
            .prepare(
                "SELECT file_name, size_bytes FROM terminal_image_objects
            WHERE ?1 IS NULL OR (legacy = 0 AND unreferenced_at_ms <= ?1)",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([cutoff], |row| {
                Ok(ClipboardObject {
                    file_name: row.get(0)?,
                    size_bytes: row.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn clipboard_adopt_legacy(&self, file_name: &str, size: u64) -> Result<(), String> {
        self.conn.lock().execute("INSERT INTO terminal_image_objects(file_name, size_bytes, legacy) VALUES (?1, ?2, 1)
            ON CONFLICT(file_name) DO UPDATE SET size_bytes = excluded.size_bytes", params![file_name, size as i64]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn clipboard_remove_object(&self, file_name: &str) -> Result<(), String> {
        self.conn
            .lock()
            .execute(
                "DELETE FROM terminal_image_objects WHERE file_name = ?1",
                [file_name],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_images_stay_protected_until_every_session_is_deleted() -> Result<(), String> {
        let db = Database::open_in_memory();
        db.clipboard_register("a", "ref-a", "image.png", 10, 0)?;
        db.clipboard_register("b", "ref-b", "image.png", 10, 0)?;
        db.clipboard_retain("a", "ref-a")?;
        db.clipboard_retain("b", "ref-b")?;
        db.clipboard_sync_sessions(&[], &["a".into()], 10)?;
        assert_eq!(db.clipboard_totals()?.protected, 10);
        db.clipboard_sync_sessions(&[], &["b".into()], 20)?;
        assert_eq!(db.clipboard_totals()?.reclaimable, 10);
        assert!(db.clipboard_objects(Some(19))?.is_empty());
        assert_eq!(db.clipboard_objects(Some(20))?.len(), 1);
        db.clipboard_sync_sessions(&["b".into()], &[], 30)?;
        assert_eq!(db.clipboard_totals()?.protected, 10);
        Ok(())
    }

    #[test]
    fn pending_images_expire_but_retained_and_legacy_images_do_not() -> Result<(), String> {
        let db = Database::open_in_memory();
        db.clipboard_register("a", "pending", "pending.png", 10, 0)?;
        db.clipboard_register("a", "retained", "retained.png", 20, 0)?;
        db.clipboard_retain("a", "retained")?;
        db.clipboard_adopt_legacy("legacy.png", 30)?;
        db.clipboard_expire_pending(PENDING_IMAGE_TTL_MS + 1)?;
        let totals = db.clipboard_totals()?;
        assert_eq!(
            (
                totals.total,
                totals.protected,
                totals.reclaimable,
                totals.legacy
            ),
            (60, 50, 10, 30)
        );
        assert_eq!(db.clipboard_objects(Some(i64::MAX))?.len(), 1);
        Ok(())
    }

    #[test]
    fn deleted_session_rejects_late_saves_and_retains() -> Result<(), String> {
        let db = Database::open_in_memory();
        db.clipboard_register("a", "ref", "image.png", 10, 0)?;
        db.clipboard_sync_sessions(&[], &["a".into()], 1)?;
        assert!(db
            .clipboard_register("a", "late", "late.png", 10, 2)
            .is_err());
        assert!(db.clipboard_retain("a", "ref").is_err());
        assert_eq!(db.clipboard_totals()?.count, 1);
        Ok(())
    }
}
