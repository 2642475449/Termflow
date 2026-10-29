import { expect, it, vi } from "vitest";
import { PersistentSettingsSync, persistentSettingsRevision } from "./persistentSettingsSync";

const initial = { voiceShortcut: "Ctrl+Shift+V", keyboardShortcuts: {}, terminalFontSize: 14, language: "zh_CN" };

it("preserves pending voice and unrelated settings during a remote shortcut broadcast", () => {
  const sync = new PersistentSettingsSync<typeof initial>();
  sync.initialize(initial);
  const current = { ...initial, voiceShortcut: "Ctrl+Alt+V", terminalFontSize: 22 };
  const applied = sync.receive({ voiceShortcut: initial.voiceShortcut, keyboardShortcuts: { newSession: "F6" } }, current, 1);
  expect(applied).not.toHaveProperty("voiceShortcut");
  expect(sync.changes({ ...current, ...applied })).toEqual({ voiceShortcut: "Ctrl+Alt+V", terminalFontSize: 22 });
});

it("merges remote fields during the debounce without acknowledging unrelated local edits", () => {
  const sync = new PersistentSettingsSync<typeof initial>();
  sync.initialize(initial);
  const current = { ...initial, terminalFontSize: 22 };
  const applied = sync.receive({ language: "en" }, current, 2);
  expect(applied).toEqual({ language: "en" });
  expect(sync.changes({ ...current, ...applied })).toEqual({ terminalFontSize: 22 });
  sync.acknowledge({ terminalFontSize: 22 }, 3);
  expect(sync.changes({ ...current, ...applied })).toEqual({});
});

it("ignores out-of-order broadcasts and save responses per field", () => {
  const sync = new PersistentSettingsSync<typeof initial>();
  sync.initialize(initial);
  const applied = sync.receive({ voiceShortcut: "F7" }, initial, 3);
  const current = { ...initial, ...applied };
  expect(sync.receive({ voiceShortcut: "F6" }, current, 2)).toEqual({});
  sync.acknowledge({ voiceShortcut: "F6" }, 1);
  expect(sync.changes(current)).toEqual({});
});

it("acknowledges only the submitted values when the user edits again in flight", () => {
  const sync = new PersistentSettingsSync<typeof initial>();
  sync.initialize(initial);
  const submitted = sync.changes({ ...initial, terminalFontSize: 18 });
  sync.acknowledge(submitted, 1);
  expect(sync.changes({ ...initial, terminalFontSize: 22 })).toEqual({ terminalFontSize: 22 });
});

it("serializes saves and reads the newest snapshot after the previous request completes", async () => {
  const sync = new PersistentSettingsSync<typeof initial>();
  sync.initialize(initial);
  let current = { ...initial, terminalFontSize: 18 };
  let finish!: (revision: number) => void;
  const write = vi.fn().mockImplementationOnce(() => new Promise<number>((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce(2);
  const first = sync.save(() => current, write);
  await Promise.resolve();
  current = { ...current, terminalFontSize: 22 };
  const second = sync.save(() => current, write);
  await Promise.resolve();
  expect(write).toHaveBeenCalledTimes(1);
  finish(1);
  await Promise.all([first, second]);
  expect(write.mock.calls.map(([snapshot]) => snapshot.terminalFontSize)).toEqual([18, 22]);
  expect(write.mock.calls[1][1]).toEqual(["terminalFontSize"]);
  expect(sync.changes(current)).toEqual({});
});

it("retries failed fields in the next queued save", async () => {
  const sync = new PersistentSettingsSync<typeof initial>();
  sync.initialize(initial);
  const current = { ...initial, voiceShortcut: "F7" };
  await expect(sync.save(() => current, async () => { throw new Error("offline"); })).rejects.toThrow("offline");
  const write = vi.fn().mockResolvedValue(1);
  await sync.save(() => current, write);
  expect(write).toHaveBeenCalledWith(current, ["voiceShortcut"]);
  expect(sync.changes(current)).toEqual({});
});

it("flushes a pending local field again when a newer broadcast overtakes its save response", async () => {
  const sync = new PersistentSettingsSync<typeof initial>();
  sync.initialize(initial);
  const current = { ...initial, voiceShortcut: "F7" };
  const write = vi.fn().mockImplementationOnce(async () => {
    expect(sync.receive({ voiceShortcut: "F8" }, current, 2)).toEqual({});
    return 1;
  }).mockResolvedValueOnce(3);
  await sync.save(() => current, write);
  expect(write).toHaveBeenCalledTimes(2);
  expect(sync.changes(current)).toEqual({});
});

it("accepts only bounded numeric revisions", () => {
  expect(persistentSettingsRevision({ revision: 3 })).toBe(3);
  for (const value of [null, {}, { revision: -1 }, { revision: Infinity }, { revision: "3" }]) {
    expect(persistentSettingsRevision(value)).toBeUndefined();
  }
});
