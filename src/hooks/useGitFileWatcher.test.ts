import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const watcherMocks = vi.hoisted(() => ({
  cleanup: undefined as undefined | (() => void),
  unlisten: vi.fn(),
  listen: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("react", () => ({
  useEffect: (effect: () => void | (() => void)) => {
    watcherMocks.cleanup = effect() ?? undefined;
  },
  useRef: <T,>(value: T) => ({ current: value }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: watcherMocks.listen,
}));

vi.mock("@/lib/api", () => ({
  gitWatchStart: watcherMocks.start,
  gitWatchStop: watcherMocks.stop,
}));

import { useGitFileWatcher } from "./useGitFileWatcher";

const flushAsyncWork = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("useGitFileWatcher", () => {
  beforeEach(() => {
    watcherMocks.cleanup = undefined;
    watcherMocks.unlisten.mockReset();
    watcherMocks.listen.mockReset();
    watcherMocks.start.mockReset();
    watcherMocks.stop.mockReset();
    watcherMocks.listen.mockResolvedValue(watcherMocks.unlisten);
    watcherMocks.start.mockResolvedValue(undefined);
    watcherMocks.stop.mockResolvedValue(undefined);
  });

  afterEach(() => {
    watcherMocks.cleanup?.();
    watcherMocks.cleanup = undefined;
  });

  it("subscribes to frontend events before starting the backend watcher", async () => {
    const calls: string[] = [];
    const onFileChange = vi.fn();
    watcherMocks.listen.mockImplementation(async () => {
      calls.push("listen");
      return watcherMocks.unlisten;
    });
    watcherMocks.start.mockImplementation(async () => {
      calls.push("start");
    });

    useGitFileWatcher("D:/workspace/demo", onFileChange);
    await flushAsyncWork();

    expect(calls).toEqual(["listen", "start"]);
    expect(watcherMocks.listen).toHaveBeenCalledWith(
      "git:file-change",
      expect.any(Function),
    );

    const handler = watcherMocks.listen.mock.calls[0][1] as (event: {
      payload: { projectPath: string; kind: string };
    }) => void;
    handler({ payload: { projectPath: "D:/workspace/demo", kind: "modify" } });
    handler({ payload: { projectPath: "D:/workspace/other", kind: "modify" } });

    expect(onFileChange).toHaveBeenCalledOnce();
  });

  it("cleans up the frontend listener and backend watcher on unmount", async () => {
    useGitFileWatcher("D:/workspace/demo", vi.fn());
    await flushAsyncWork();

    watcherMocks.cleanup?.();
    await flushAsyncWork();

    expect(watcherMocks.unlisten).toHaveBeenCalledOnce();
    expect(watcherMocks.stop).toHaveBeenCalledWith("D:/workspace/demo");
  });

  it("stops a watcher that finishes starting after the effect has unmounted", async () => {
    let resolveStart: (() => void) | undefined;
    watcherMocks.start.mockImplementation(
      () => new Promise<void>((resolve) => {
        resolveStart = resolve;
      }),
    );

    useGitFileWatcher("D:/workspace/demo", vi.fn());
    await flushAsyncWork();
    expect(watcherMocks.start).toHaveBeenCalledOnce();

    watcherMocks.cleanup?.();
    resolveStart?.();
    await flushAsyncWork();

    expect(watcherMocks.unlisten).toHaveBeenCalledOnce();
    expect(watcherMocks.stop).toHaveBeenCalledWith("D:/workspace/demo");
  });
});