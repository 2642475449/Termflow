import { describe, expect, it, vi } from "vitest";
import type { TabEntity } from "@/store";
import { archiveSessionRuntime, closeTabRuntime } from "./tabClose";

function tab(overrides: Partial<TabEntity> = {}): TabEntity {
  return {
    id: "tab-1",
    kind: "session",
    resourceId: "session-1",
    title: "PowerShell",
    closable: true,
    pinned: false,
    dirty: false,
    preview: false,
    createdAt: 1,
    lastActivatedAt: 1,
    ...overrides,
  };
}

describe("closeTabRuntime", () => {
  it("closes the PTY for PowerShell and cmd session tabs", async () => {
    const closeSession = vi.fn(async () => undefined);

    await closeTabRuntime(tab({ resourceId: "powershell-session" }), closeSession);
    await closeTabRuntime(tab({ resourceId: "cmd-session" }), closeSession);

    expect(closeSession).toHaveBeenNthCalledWith(1, "powershell-session");
    expect(closeSession).toHaveBeenNthCalledWith(2, "cmd-session");
  });

  it("does not touch a runtime for non-session tabs", async () => {
    const closeSession = vi.fn(async () => undefined);
    await closeTabRuntime(tab({ kind: "file", resourceId: "README.md" }), closeSession);
    expect(closeSession).not.toHaveBeenCalled();
  });
});

describe("archiveSessionRuntime", () => {
  it("stops the PTY before archiving the session", async () => {
    const calls: string[] = [];
    const closeSession = vi.fn(async () => {
      calls.push("close");
    });
    const archiveSession = vi.fn(() => {
      calls.push("archive");
    });

    await archiveSessionRuntime("session-1", archiveSession, closeSession);

    expect(closeSession).toHaveBeenCalledWith("session-1");
    expect(archiveSession).toHaveBeenCalledWith("session-1");
    expect(calls).toEqual(["close", "archive"]);
  });

  it("keeps the session visible when stopping the PTY fails", async () => {
    const closeError = new Error("close failed");
    const closeSession = vi.fn(async () => {
      throw closeError;
    });
    const archiveSession = vi.fn();

    await expect(
      archiveSessionRuntime("session-1", archiveSession, closeSession),
    ).rejects.toBe(closeError);

    expect(archiveSession).not.toHaveBeenCalled();
  });
});
