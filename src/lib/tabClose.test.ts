import { describe, expect, it, vi } from "vitest";
import type { TabEntity } from "@/store";
import { archiveSessionRuntime, closeTabRuntime, confirmCloseTab } from "./tabClose";
import { useSkillMarketplaceStore } from "@/store/slices/skillMarketplaceSlice";
import { message } from "@/lib/toast";
import i18n from "@/i18n";

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

it("keeps a marketplace tab open while installation is running", async () => {
  const info = vi.spyOn(message, "info").mockImplementation(() => undefined);
  try {
    const marketTab = tab({ kind: "skill-market" });
    useSkillMarketplaceStore.getState().setInstalling(true);
    expect(await confirmCloseTab(marketTab, i18n.t.bind(i18n))).toBe(false);
    expect(info).toHaveBeenCalledOnce();
    useSkillMarketplaceStore.getState().setInstalling(false);
    expect(await confirmCloseTab(marketTab, i18n.t.bind(i18n))).toBe(true);
  } finally {
    useSkillMarketplaceStore.getState().setInstalling(false);
    info.mockRestore();
  }
});

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
