import { beforeEach, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { getPersistentSettings } from "./api";
import { startVoiceOverlayThemeSync, type PersistentThemeUpdate } from "./persistentTheme";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("./api", () => ({ getPersistentSettings: vi.fn() }));

const light: PersistentThemeUpdate = {
  lightTheme: "light-glass", darkTheme: "dark-starry", themeCategory: "light",
};
const dark: PersistentThemeUpdate = { ...light, themeCategory: "dark" };
let receive: (event: { payload: unknown }) => void;
const stop = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listen).mockImplementation(async (_event, handler) => {
    receive = (event) => handler({ event: "persistent-theme-updated", id: 1, ...event });
    return stop;
  });
  vi.mocked(getPersistentSettings).mockResolvedValue(light as Awaited<ReturnType<typeof getPersistentSettings>>);
});

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

it("loads the saved light theme without applying unrelated settings", async () => {
  vi.mocked(getPersistentSettings).mockResolvedValue({ ...light, language: "en" } as Awaited<ReturnType<typeof getPersistentSettings>>);
  const apply = vi.fn();
  const dispose = startVoiceOverlayThemeSync(apply);
  await flush();
  expect(apply).toHaveBeenCalledExactlyOnceWith(light);
  dispose();
  expect(stop).toHaveBeenCalledOnce();
});

it("follows light, dark and system theme changes and ignores invalid payloads", async () => {
  const apply = vi.fn();
  const dispose = startVoiceOverlayThemeSync(apply);
  await flush();
  for (const theme of [dark, { ...light, themeCategory: "system" }, light]) {
    receive({ payload: theme });
    expect(apply).toHaveBeenLastCalledWith(theme);
  }
  receive({ payload: { ...light, themeCategory: "invalid" } });
  expect(apply).toHaveBeenCalledTimes(4);
  dispose();
  receive({ payload: dark });
  expect(apply).toHaveBeenCalledTimes(4);
});

it("does not overwrite a theme event with an older loading snapshot", async () => {
  let resolveSettings!: (value: Awaited<ReturnType<typeof getPersistentSettings>>) => void;
  vi.mocked(getPersistentSettings).mockReturnValue(new Promise((resolve) => { resolveSettings = resolve; }));
  const apply = vi.fn();
  const dispose = startVoiceOverlayThemeSync(apply);
  await flush();
  receive({ payload: light });
  resolveSettings(dark as Awaited<ReturnType<typeof getPersistentSettings>>);
  await flush();
  expect(apply).toHaveBeenCalledExactlyOnceWith(light);
  dispose();
});

it("releases a late subscription after unmount without loading settings", async () => {
  let resolveListener!: (value: () => void) => void;
  vi.mocked(listen).mockReturnValue(new Promise((resolve) => { resolveListener = resolve; }));
  const apply = vi.fn();
  const dispose = startVoiceOverlayThemeSync(apply);
  dispose();
  resolveListener(stop);
  await flush();
  expect(stop).toHaveBeenCalledOnce();
  expect(getPersistentSettings).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
});

it("ignores a pending settings response after unmount", async () => {
  let resolveSettings!: (value: Awaited<ReturnType<typeof getPersistentSettings>>) => void;
  vi.mocked(getPersistentSettings).mockReturnValue(new Promise((resolve) => { resolveSettings = resolve; }));
  const apply = vi.fn();
  const dispose = startVoiceOverlayThemeSync(apply);
  await flush();
  dispose();
  resolveSettings(light as Awaited<ReturnType<typeof getPersistentSettings>>);
  await flush();
  expect(apply).not.toHaveBeenCalled();
});
