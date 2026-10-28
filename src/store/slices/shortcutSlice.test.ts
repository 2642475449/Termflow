import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SHORTCUTS } from "@/constants/shortcuts";
import { getAppShortcut } from "@/lib/appShortcuts";

const { configure } = vi.hoisted(() => ({ configure: vi.fn() }));
vi.mock("@/lib/api", () => ({ configureVoiceGlobalShortcut: configure }));
const values = new Map<string, string>();
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  values.clear();
  configure.mockResolvedValue(false);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  vi.stubGlobal("window", { localStorage: storage });
});
afterEach(() => vi.unstubAllGlobals());

it("persists customized and disabled shortcuts without persisting recording state", async () => {
  const { useShortcutStore: store } = await import("./shortcutSlice");
  store.getState().setShortcut("newSession", "Ctrl+Alt+N");
  store.getState().setShortcut("closeTab", "");
  await store.getState().setRecordingAction("nextTab");
  expect(configure).toHaveBeenCalledWith(null, false);
  const saved = JSON.parse(values.get("termflow-shortcuts") ?? "{}");
  expect(saved.state).toEqual({ overrides: { newSession: "Ctrl+Alt+N", closeTab: "" } });
  store.setState({ overrides: {} });
  values.set("termflow-shortcuts", JSON.stringify(saved));
  await store.persist.rehydrate();
  expect(store.getState().overrides).toEqual(saved.state.overrides);
});

it("cancels recording safely while suspension is pending and recovers after errors", async () => {
  const { useShortcutStore: store } = await import("./shortcutSlice");
  let complete: () => void = () => {};
  configure.mockReturnValueOnce(new Promise<void>((resolve) => { complete = resolve; }));
  const pending = store.getState().setRecordingAction("newSession");
  await store.getState().setRecordingAction(null);
  complete();
  await pending;
  expect(store.getState().recordingAction).toBeNull();
  expect(store.getState().preparing).toBe(false);
  configure.mockRejectedValueOnce(new Error("suspend failed"));
  await expect(store.getState().setRecordingAction("newSession")).rejects.toThrow("suspend failed");
  expect(store.getState().recordingAction).toBeNull();
});

it("restores every disabled binding by removing its override and preserves other customizations", async () => {
  const { useShortcutStore: store } = await import("./shortcutSlice");
  for (const { id, keys } of SHORTCUTS) {
    if (id === "voiceInput") continue;
    store.getState().setShortcut(id, "");
    expect(getAppShortcut(store.getState().overrides, id)).toBe("");
    store.getState().setDefaultShortcut(id);
    expect(getAppShortcut(store.getState().overrides, id)).toBe(keys);
    expect(store.getState().overrides).not.toHaveProperty(id);
  }
  store.getState().setShortcut("newSession", "F6");
  store.getState().setShortcut("closeTab", "");
  store.getState().setDefaultShortcut("closeTab");
  expect(store.getState().overrides).toEqual({ newSession: "F6" });
  store.getState().setDefaultShortcut();
  expect(store.getState().overrides).toEqual({});
});

it("does not let a delayed clear response overwrite restored defaults", async () => {
  const { useShortcutStore: store } = await import("./shortcutSlice");
  store.getState().setShortcut("closeTab", "");
  const clearingSnapshot = { ...store.getState().overrides };
  store.getState().setDefaultShortcut("closeTab");
  store.getState().setPersistedOverrides(clearingSnapshot);
  expect(getAppShortcut(store.getState().overrides, "closeTab")).toBe("Ctrl + W");
  expect(store.getState().pendingOverrides).toBe(true);
  store.getState().setPersistedOverrides({});
  expect(store.getState().pendingOverrides).toBe(false);
  store.getState().setPersistedOverrides({ newSession: "F9" });
  expect(store.getState().overrides).toEqual({ newSession: "F9" });
});

it("persists restored defaults and ignores stale startup hydration while editing", async () => {
  const { useShortcutStore: store } = await import("./shortcutSlice");
  store.getState().setShortcut("closeTab", "F8");
  store.getState().setPersistedOverrides({ closeTab: "" });
  expect(store.getState().overrides).toEqual({ closeTab: "F8" });
  store.getState().setDefaultShortcut("closeTab");
  const saved = values.get("termflow-shortcuts");
  expect(saved).toBeDefined();
  vi.resetModules();
  const { useShortcutStore: reloaded } = await import("./shortcutSlice");
  expect(reloaded.getState().overrides).toEqual({});
  expect(getAppShortcut(reloaded.getState().overrides, "closeTab")).toBe("Ctrl + W");
});
