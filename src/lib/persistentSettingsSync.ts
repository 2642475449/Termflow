function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function persistentSettingsRevision(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || !("revision" in value)) return undefined;
  return typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0
    ? value.revision : undefined;
}

/** 每窗口独立的落库基线；业务设置仍由原有 Store 持有。 */
export class PersistentSettingsSync<T extends object> {
  private baseline: Partial<T> = {};
  private revisions = new Map<keyof T, number>();
  private saving: Promise<unknown> = Promise.resolve();

  initialize(settings: T): void {
    this.baseline = { ...settings };
    this.revisions.clear();
  }

  changes(current: T): Partial<T> {
    const patch: Partial<T> = {};
    for (const key of Object.keys(current) as (keyof T)[]) {
      if (current[key] !== undefined && !equal(current[key], this.baseline[key])) patch[key] = current[key];
    }
    return patch;
  }

  receive(patch: Partial<T>, current: T, revision?: number): Partial<T> {
    const applied: Partial<T> = {};
    for (const key of Object.keys(patch) as (keyof T)[]) {
      if (revision !== undefined && revision < (this.revisions.get(key) ?? 0)) continue;
      const dirty = !equal(current[key], this.baseline[key]);
      if (!dirty || equal(current[key], patch[key])) applied[key] = patch[key];
      this.baseline[key] = patch[key];
      if (revision !== undefined) this.revisions.set(key, revision);
    }
    return applied;
  }

  acknowledge(patch: Partial<T>, revision: number): void {
    for (const key of Object.keys(patch) as (keyof T)[]) {
      if (revision < (this.revisions.get(key) ?? 0)) continue;
      this.baseline[key] = patch[key];
      this.revisions.set(key, revision);
    }
  }

  save(read: () => T, write: (snapshot: T, fields: (keyof T)[]) => Promise<number>): Promise<T | undefined> {
    const task = this.saving.then(async () => {
      let saved: T | undefined;
      while (true) {
        const snapshot = read();
        const patch = this.changes(snapshot);
        const fields = Object.keys(patch) as (keyof T)[];
        if (!fields.length) return saved;
        const revision = await write(snapshot, fields);
        this.acknowledge(patch, revision);
        saved = snapshot;
        // 保存途中仍可能编辑或收到更高修订号；继续落库剩余修改，不能只等下一次 UI 变更。
      }
    });
    // 一次失败不能阻塞后续保存；失败字段仍保留在 changes 中。
    this.saving = task.catch(() => {});
    return task;
  }
}
