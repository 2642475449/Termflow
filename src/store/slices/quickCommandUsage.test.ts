import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadQuickCommandUsage, recordQuickCommandUse } from "@/lib/api";
import { refreshQuickCommandUsage, useQuickCommandUsageStore as store } from "./quickCommandUsage";

vi.mock("@/lib/api", () => ({ loadQuickCommandUsage: vi.fn(), recordQuickCommandUse: vi.fn() }));

const { entries } = vi.hoisted(() => {
  const entries = new Map<string, string>();
  vi.stubGlobal("window", { localStorage: {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  } });
  return { entries };
});
const path = "E:/project";

beforeEach(() => {
  vi.clearAllMocks();
  entries.clear();
  store.setState({ usageByProject: {} });
  vi.mocked(recordQuickCommandUse).mockImplementation(async (_path, _id, usedAt) => usedAt);
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => vi.unstubAllGlobals());

it("persists usage by project and restores it after a restart", async () => {
  vi.spyOn(Date, "now").mockReturnValue(100);
  await store.getState().setCommandUsed(path, "build");
  await store.getState().setCommandUsed("E:/other", "build");
  expect(recordQuickCommandUse).toHaveBeenCalledWith(path, "build", 100);
  const saved = entries.get("termflow-quick-command-usage")!;
  store.setState({ usageByProject: {} });
  entries.set("termflow-quick-command-usage", saved);
  await store.persist.rehydrate();
  expect(store.getState().usageByProject).toEqual({ [path]: { build: 100 }, "E:/other": { build: 100 } });
});

it("merges a late database read without losing newer local use or other projects", async () => {
  let resolve!: (usage: Record<string, number>) => void;
  vi.mocked(loadQuickCommandUsage).mockImplementation(() => new Promise((done) => { resolve = done; }));
  const read = refreshQuickCommandUsage(path);
  store.getState().setProjectUsage(path, { build: 200 });
  store.getState().setProjectUsage("E:/other", { build: 300 });
  resolve({ build: 100, preview: 150 });
  await read;
  expect(store.getState().usageByProject).toEqual({ [path]: { build: 200, preview: 150 }, "E:/other": { build: 300 } });
});

it("does not roll back usage when an older write response arrives last", async () => {
  let resolve!: (timestamp: number) => void;
  vi.mocked(recordQuickCommandUse).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const clock = vi.spyOn(Date, "now").mockReturnValue(100);
  const first = store.getState().setCommandUsed(path, "build");
  clock.mockReturnValue(200);
  await store.getState().setCommandUsed(path, "build");
  resolve(100);
  await first;
  expect(store.getState().usageByProject[path].build).toBe(200);
});

it("keeps local usage and logs storage failures without failing a launched command", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(recordQuickCommandUse).mockRejectedValue(new Error("database unavailable"));
  await expect(store.getState().setCommandUsed(path, "build")).resolves.toBeUndefined();
  expect(store.getState().usageByProject[path].build).toBeGreaterThan(0);
  vi.mocked(loadQuickCommandUsage).mockRejectedValue(new Error("database unavailable"));
  await refreshQuickCommandUsage(path);
  expect(warn).toHaveBeenCalledTimes(2);
  expect(store.getState().usageByProject[path].build).toBeGreaterThan(0);
});

it("rejects malformed timestamps during hydration and accepts arbitrary command IDs", async () => {
  entries.set("termflow-quick-command-usage", JSON.stringify({ state: { usageByProject: {
    [path]: { valid: 100, negative: -1, fraction: 1.5, text: "200", zero: 0 }, bad: [],
  } }, version: 0 }));
  await store.persist.rehydrate();
  expect(store.getState().usageByProject).toEqual({ [path]: { valid: 100 }, bad: {} });
  store.getState().setProjectUsage(path, { constructor: 200, ["__proto__"]: 300 });
  expect(store.getState().usageByProject[path].constructor).toBe(200);
  expect(store.getState().usageByProject[path]["__proto__"]).toBe(300);
});

it("still writes SQLite when the local cache cannot be written", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("storage full"); });
  await expect(store.getState().setCommandUsed(path, "build")).resolves.toBeUndefined();
  expect(recordQuickCommandUse).toHaveBeenCalledWith(path, "build", expect.any(Number));
  expect(store.getState().usageByProject[path].build).toBeGreaterThan(0);
  expect(warn).toHaveBeenCalled();
});
