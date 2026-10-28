import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { UsageAgentId, UsageDataByAgent } from "@/lib/agentUsage";

const api = vi.hoisted(() => ({
  getCodexRateLimits: vi.fn(), getClaudeRateLimits: vi.fn(),
  getQoderUsage: vi.fn(), getAntigravityUsage: vi.fn(), isUsageWindowVisible: vi.fn(),
}));
vi.mock("@/lib/api", () => api);
import { refreshAgentUsage } from "./useAgentUsage";
import { useAgentUsageStore } from "@/store/slices/agentUsageSlice";

const window = { usedPercent: 20, windowMinutes: 300, resetsAt: null, resetDescription: null };
const fixtures: UsageDataByAgent = {
  codex: { session: window, weekly: null, updatedAt: 1, checkedAt: 1, status: "ok", error: null, accountId: "a", accountLabel: "a" },
  claude: { session: window, weekly: null, updatedAt: 1, checkedAt: 1, status: "ok", error: null },
  qoder: { userType: null, totalUsagePercentage: 20, expiresAt: null, userQuota: null, addOnQuota: null,
    orgResourcePackage: null, isQuotaExceeded: null, sessionCredits: null, updatedAt: 1, checkedAt: 1,
    status: "ok", error: null, accountLabel: "a" },
  antigravity: { windows: [{ id: "weekly", scope: "Gemini", window: "weekly", remainingPercent: 80, resetDescription: null }],
    updatedAt: 1, checkedAt: 1, status: "ok", error: null },
};
const request = (agent: UsageAgentId) => ({
  codex: api.getCodexRateLimits, claude: api.getClaudeRateLimits,
  qoder: api.getQoderUsage, antigravity: api.getAntigravityUsage,
})[agent];

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  useAgentUsageStore.setState({ views: {} });
});
afterEach(() => { vi.useRealTimers(); });

test.each<UsageAgentId>(["codex", "claude", "qoder", "antigravity"])("%s retains success on IPC failure, backs off and recovers", async (agent) => {
  const key = agent === "claude" ? "claude:session" : agent;
  const mock = request(agent);
  mock.mockResolvedValueOnce(fixtures[agent]);
  await refreshAgentUsage(agent, "session");
  mock.mockRejectedValueOnce(new Error("offline"));
  await refreshAgentUsage(agent, "session", true);
  let view = useAgentUsageStore.getState().views[key];
  expect(view.value).toEqual(fixtures[agent]);
  expect(view.error).toBe("offline");
  expect(view.transportRetryAt).toBe(190_000);
  expect(view.loading).toBe(false);
  await refreshAgentUsage(agent, "session");
  expect(mock).toHaveBeenCalledTimes(2);
  mock.mockResolvedValueOnce({ ...fixtures[agent], checkedAt: 20_000 });
  await refreshAgentUsage(agent, "session", true);
  view = useAgentUsageStore.getState().views[key];
  expect(view.error).toBeNull();
  expect(view.transportFailures).toBe(0);
});

test("concurrent background and manual refreshes count one failed attempt", async () => {
  let fail!: (error: Error) => void;
  api.getQoderUsage.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  const first = refreshAgentUsage("qoder");
  const second = refreshAgentUsage("qoder", undefined, true);
  fail(new Error("offline"));
  await Promise.all([first, second]);
  expect(api.getQoderUsage).toHaveBeenCalledTimes(1);
  expect(useAgentUsageStore.getState().views.qoder.transportFailures).toBe(1);
});

test("a late response from the previous Claude session cannot overwrite the current session", async () => {
  let finish!: (value: UsageDataByAgent["claude"]) => void;
  api.getClaudeRateLimits.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const old = refreshAgentUsage("claude", "old");
  api.getClaudeRateLimits.mockResolvedValueOnce({ ...fixtures.claude, updatedAt: 2, checkedAt: 2 });
  await refreshAgentUsage("claude", "new");
  finish(fixtures.claude);
  await old;
  expect(useAgentUsageStore.getState().views["claude:new"].value?.updatedAt).toBe(2);
  expect(useAgentUsageStore.getState().views["claude:old"].value?.updatedAt).toBe(1);
});

test("newer pushed data survives older responses and failed in-flight requests", async () => {
  let fail!: (error: Error) => void;
  api.getCodexRateLimits.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  const pending = refreshAgentUsage("codex");
  const state = useAgentUsageStore.getState();
  state.setResult("codex", { ...fixtures.codex, checkedAt: 100 });
  state.setResult("codex", { ...fixtures.codex, checkedAt: 50 });
  fail(new Error("old failure"));
  await pending;
  expect(useAgentUsageStore.getState().views.codex.value?.checkedAt).toBe(100);
  expect(useAgentUsageStore.getState().views.codex.error).toBeNull();
});
