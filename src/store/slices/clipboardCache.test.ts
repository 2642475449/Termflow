import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupClipboardCache, getClipboardCacheStatus, syncClipboardSessions } from "@/lib/api";
import { useAppStore } from "@/store";
import { refreshClipboardCache, startClipboardSessionSync, useClipboardCacheStore } from "./clipboardCache";

vi.mock("@/lib/api", () => ({
  cleanupClipboardCache: vi.fn(), getClipboardCacheStatus: vi.fn(), syncClipboardSessions: vi.fn(),
}));
vi.mock("@/store", async () => {
  const { create } = await import("zustand");
  return { useAppStore: create(() => ({
    sessions: [] as { id: string }[],
    projectSessions: {} as Record<string, { id: string }[]>,
    projectArchivedSessions: {} as Record<string, { id: string }[]>,
  })) };
});

function session(id: string) {
  return { id, path: "/project", name: id, createdAt: 0, active: false };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useAppStore.setState({ sessions: [], projectSessions: {}, projectArchivedSessions: {} });
  useClipboardCacheStore.setState({ pendingRemoved: {}, syncError: null, error: null, loading: false, cleaning: false });
  vi.mocked(syncClipboardSessions).mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("clipboard cache state", () => {
  it("does not acknowledge a newer deletion using an older response", () => {
    useClipboardCacheStore.getState().setPendingRemoved(["a"]);
    const old = useClipboardCacheStore.getState().pendingRemoved;
    useClipboardCacheStore.getState().setPendingRemoved(["a"]);
    useClipboardCacheStore.getState().setAcknowledged(old);
    expect(useClipboardCacheStore.getState().pendingRemoved.a).toBeDefined();
  });

  it("keeps archived sessions and synchronizes permanent deletion", async () => {
    useAppStore.setState({ projectSessions: { "/project": [session("a")] } });
    const stop = startClipboardSessionSync();
    try {
      await vi.advanceTimersByTimeAsync(0);
      useAppStore.setState({ projectSessions: {}, projectArchivedSessions: { "/project": [session("a")] } });
      await vi.advanceTimersByTimeAsync(0);
      expect(syncClipboardSessions).toHaveBeenCalledTimes(1);
      useAppStore.setState({ projectArchivedSessions: {} });
      await vi.advanceTimersByTimeAsync(0);
      expect(syncClipboardSessions).toHaveBeenLastCalledWith([], ["a"]);
      expect(useClipboardCacheStore.getState().pendingRemoved).toEqual({});
    } finally { stop(); }
  });

  it("replays persisted deletions, preserves them on failure and retries", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    useClipboardCacheStore.setState({ pendingRemoved: { deleted: 1 } });
    vi.mocked(syncClipboardSessions).mockRejectedValueOnce(new Error("offline"));
    const stop = startClipboardSessionSync();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(useClipboardCacheStore.getState().pendingRemoved).toEqual({ deleted: 1 });
      expect(useClipboardCacheStore.getState().syncError).toContain("offline");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(syncClipboardSessions).toHaveBeenLastCalledWith([], ["deleted"]);
      expect(useClipboardCacheStore.getState().pendingRemoved).toEqual({});
      expect(useClipboardCacheStore.getState().syncError).toBeNull();
    } finally { stop(); }
  });

  it("restores references instead of replaying deletion for a present session", async () => {
    useClipboardCacheStore.setState({ pendingRemoved: { restored: 1 } });
    useAppStore.setState({ projectArchivedSessions: { "/project": [session("restored")] } });
    const stop = startClipboardSessionSync();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(syncClipboardSessions).toHaveBeenLastCalledWith(["restored"], []);
      expect(useClipboardCacheStore.getState().pendingRemoved).toEqual({});
    } finally { stop(); }
  });

  it("reports cleanup failures and resets busy state for retry", async () => {
    vi.mocked(cleanupClipboardCache).mockRejectedValueOnce(new Error("file locked"));
    await expect(refreshClipboardCache(true)).rejects.toThrow("file locked");
    expect(useClipboardCacheStore.getState().cleaning).toBe(false);
    expect(useClipboardCacheStore.getState().error).toContain("file locked");
    expect(getClipboardCacheStatus).not.toHaveBeenCalled();
  });
});
