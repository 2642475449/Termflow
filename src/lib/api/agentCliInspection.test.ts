import { afterEach, expect, test, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: apiMocks.invoke,
}));

import { getCachedAgentClis, inspectAgentClis } from "./index";

const detectedAgents = [
  "claude",
  "codex",
  "antigravity",
  "opencode",
  "qoder",
  "pi",
].map((id) => ({
  id,
  name: id,
  command: id,
  installed: true,
  version: "0.154.0",
  executablePath: `C:/${id}.cmd`,
  checkedAt: Date.now(),
  error: null,
}));

afterEach(() => {
  vi.useRealTimers();
});

test("refreshes the cached CLI version after five hours", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-20T00:00:00Z"));
  const checkedAt = Date.now();
  const initialAgents = detectedAgents.map((agent) => ({ ...agent, checkedAt }));

  apiMocks.invoke
    .mockResolvedValueOnce(initialAgents)
    .mockImplementationOnce(async () =>
      detectedAgents.map((agent) =>
        agent.id === "codex"
          ? { ...agent, version: "0.155.1", checkedAt: Date.now() }
          : { ...agent, checkedAt: Date.now() },
      ),
    );

  await expect(inspectAgentClis({ forceRefresh: true })).resolves.toEqual(initialAgents);
  await expect(inspectAgentClis()).resolves.toEqual(initialAgents);

  vi.advanceTimersByTime(5 * 60 * 60 * 1000);
  expect(getCachedAgentClis()).toEqual(initialAgents);
  const refreshedAgents = await inspectAgentClis();
  expect(refreshedAgents.find((agent) => agent.id === "codex")?.version).toBe("0.155.1");

  expect(apiMocks.invoke).toHaveBeenCalledTimes(2);
  expect(apiMocks.invoke).toHaveBeenNthCalledWith(1, "inspect_agent_clis");
  expect(apiMocks.invoke).toHaveBeenNthCalledWith(2, "inspect_agent_clis");
});
