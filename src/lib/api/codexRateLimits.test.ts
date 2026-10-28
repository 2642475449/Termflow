import { beforeEach, expect, test, vi } from "vitest";
import type { ClaudeRateLimits, CodexRateLimits } from "@/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
import { getAntigravityUsage, getClaudeRateLimits, getCodexRateLimits, getQoderUsage } from "./index";

beforeEach(() => { vi.resetAllMocks(); });

test("automatic and forced refreshes share the in-flight request and recover after rejection", async () => {
  let rejectRequest!: (error: Error) => void;
  mocks.invoke.mockImplementationOnce(() => new Promise((_, reject) => { rejectRequest = reject; }));
  const automatic = getCodexRateLimits();
  const manual = getCodexRateLimits({ forceRefresh: true });
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  const rejected = Promise.allSettled([automatic, manual]);
  rejectRequest(new Error("offline"));
  expect((await rejected).map((result) => result.status)).toEqual(["rejected", "rejected"]);

  const value: CodexRateLimits = {
    session: null, weekly: null, updatedAt: 1, error: null,
    status: "ok", accountLabel: "account", accountId: "1",
  };
  mocks.invoke.mockResolvedValueOnce(value);
  await expect(getCodexRateLimits({ forceRefresh: true })).resolves.toEqual(value);
  expect(mocks.invoke).toHaveBeenLastCalledWith("get_codex_rate_limits", { forceRefresh: true });
});

test.each([
  ["get_qoder_usage", getQoderUsage],
  ["get_antigravity_usage", getAntigravityUsage],
] as const)("%s shares forced and automatic queries", async (command, request) => {
  let finish!: (value: unknown) => void;
  mocks.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const automatic = request();
  const manual = request({ forceRefresh: true });
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(mocks.invoke).toHaveBeenCalledWith(command, { forceRefresh: false });
  finish({ status: "unavailable" });
  await Promise.all([automatic, manual]);
});

test("Claude coalesces requests per session and keeps different sessions separate", async () => {
  let finish!: (value: ClaudeRateLimits) => void;
  mocks.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const first = getClaudeRateLimits("one");
  const forced = getClaudeRateLimits("one", { forceRefresh: true });
  const value: ClaudeRateLimits = { session: null, weekly: null, updatedAt: 0, status: "unavailable", error: null };
  mocks.invoke.mockResolvedValueOnce(value);
  await getClaudeRateLimits("two");
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
  expect(mocks.invoke).toHaveBeenLastCalledWith("get_claude_rate_limits", { sessionId: "two", forceRefresh: false });
  finish(value);
  await Promise.all([first, forced]);
});
