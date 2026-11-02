import { beforeEach, expect, it, vi } from "vitest";
import type { Session } from "@/types";

const mocks = vi.hoisted(() => ({
  session: {} as Session,
  cleanup: vi.fn(),
  spawn: vi.fn(),
  updateSession: vi.fn(),
  clearExit: vi.fn(),
  messageError: vi.fn(),
}));

vi.mock("react", () => ({ useCallback: (callback: unknown) => callback }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("antd", () => ({ message: { error: mocks.messageError } }));
vi.mock("@/lib/api", () => ({
  cleanupSessionProcess: mocks.cleanup,
  spawnPty: mocks.spawn,
  resolveRecentCodexSessionId: vi.fn(),
}));
vi.mock("@/store", () => {
  const state = () => ({
    defaultTerminalShell: "powershell",
    sessions: [mocks.session],
    updateSession: mocks.updateSession,
    clearTerminalExitCode: mocks.clearExit,
  });
  return { useAppStore: Object.assign((select: (value: ReturnType<typeof state>) => unknown) => select(state()), { getState: state }) };
});

import { useResumeSession } from "./useResumeSession";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session = { id: "terminal", path: "D:/project", name: "Terminal", createdAt: 1, active: false, agentId: "cmd" };
  mocks.cleanup.mockResolvedValue(undefined);
  mocks.spawn.mockResolvedValue(undefined);
  mocks.updateSession.mockImplementation((_id: string, updates: Partial<Session>) => Object.assign(mocks.session, updates));
});

it.each(["cmd", "powershell"] as const)("restarts %s as the same shell without launching an agent", async (shell) => {
  mocks.session.agentId = shell;
  await useResumeSession()(mocks.session.id);
  expect(mocks.spawn).toHaveBeenCalledOnce();
  expect(mocks.spawn.mock.calls[0][4]).toBe("");
  expect(mocks.spawn.mock.calls[0][6]).toBe(shell);
  expect(mocks.session.active).toBe(true);
  expect(mocks.clearExit).toHaveBeenCalledWith("terminal");
});

it("keeps the retained exit state when restarting fails", async () => {
  mocks.spawn.mockRejectedValueOnce(new Error("spawn failed"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await useResumeSession()(mocks.session.id);
    expect(mocks.session).toMatchObject({ active: false, status: "error" });
    expect(mocks.clearExit).not.toHaveBeenCalled();
    expect(mocks.messageError).toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});
