import { beforeEach, expect, test, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  checkApplicationUpdate: vi.fn(),
  closeApplicationUpdate: vi.fn(),
  downloadApplicationUpdate: vi.fn(),
  installApplicationUpdate: vi.fn(),
  savePersistentSettings: vi.fn(),
  resolveNetworkProxySettings: vi.fn(async () => ({
    mode: "disabled",
    source: "disabled",
    httpProxy: null,
    httpsProxy: null,
    noProxy: "localhost,127.0.0.1,::1",
    warning: null,
  })),
}));

vi.mock("@/store", () => ({
  getPersistentSettingsSnapshot: vi.fn(() => ({})),
}));

import {
  checkForApplicationUpdate,
  clearPendingUpdateVersion,
  consumeInstalledUpdateVersion,
  markPendingUpdateVersion,
  resetApplicationUpdaterForTests,
} from "./applicationUpdater";
import {
  checkApplicationUpdate,
  downloadApplicationUpdate,
} from "@/lib/api";
import { useApplicationUpdateStore } from "@/store/slices/applicationUpdate";

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetApplicationUpdaterForTests();
});

test("reports a completed update once on the matching version", () => {
  const storage = createStorage();
  markPendingUpdateVersion(storage, "1.8.23");
  expect(consumeInstalledUpdateVersion(storage, "1.8.23")).toBe("1.8.23");
  expect(consumeInstalledUpdateVersion(storage, "1.8.23")).toBeNull();
});

test("discards a stale marker when the installer did not change the version", () => {
  const storage = createStorage();
  markPendingUpdateVersion(storage, "1.8.23");
  expect(consumeInstalledUpdateVersion(storage, "1.8.22")).toBeNull();
  expect(consumeInstalledUpdateVersion(storage, "1.8.23")).toBeNull();
});

test("clears a failed installation marker", () => {
  const storage = createStorage();
  markPendingUpdateVersion(storage, "1.8.23");
  clearPendingUpdateVersion(storage);
  expect(consumeInstalledUpdateVersion(storage, "1.8.23")).toBeNull();
});

test("keeps one update resource while downloading and exposes byte progress", async () => {
  const update = {
    currentVersion: "1.8.22",
    version: "1.8.23",
    body: "Notes",
  };
  vi.mocked(checkApplicationUpdate).mockResolvedValue(update as never);
  vi.mocked(downloadApplicationUpdate).mockImplementation(async (received, onEvent) => {
    expect(received).toBe(update);
    onEvent({ event: "Started", data: { contentLength: 100 } });
    onEvent({ event: "Progress", data: { chunkLength: 40 } });
    onEvent({ event: "Progress", data: { chunkLength: 60 } });
    onEvent({ event: "Finished" });
  });

  await expect(checkForApplicationUpdate()).resolves.toEqual({
    status: "available",
    currentVersion: "1.8.22",
    version: "1.8.23",
  });
  await vi.waitFor(() => {
    expect(useApplicationUpdateStore.getState()).toMatchObject({
      phase: "ready",
      downloadedBytes: 100,
      totalBytes: 100,
      percent: 100,
    });
  });
  expect(downloadApplicationUpdate).toHaveBeenCalledTimes(1);
});
