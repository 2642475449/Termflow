import { beforeEach, expect, it, vi } from "vitest";
import { checkAgentLatestVersion } from "@/lib/api";
import { useAgentVersionsStore } from "./agentVersions";

vi.mock("@/lib/api", () => ({ checkAgentLatestVersion: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  useAgentVersionsStore.setState({ versions: {} });
});

it("caches successful checks and allows explicit refresh", async () => {
  vi.mocked(checkAgentLatestVersion).mockResolvedValue("1.2.3");
  await useAgentVersionsStore.getState().setVersionChecks();
  expect(checkAgentLatestVersion).toHaveBeenCalledTimes(6);
  await useAgentVersionsStore.getState().setVersionChecks();
  expect(checkAgentLatestVersion).toHaveBeenCalledTimes(6);
  await useAgentVersionsStore.getState().setVersionChecks(true);
  expect(checkAgentLatestVersion).toHaveBeenCalledTimes(12);
});

it("isolates failures and retries failed agents without discarding successful checks", async () => {
  vi.mocked(checkAgentLatestVersion).mockImplementation(async (id) => {
    if (id === "codex") throw new Error("offline");
    return "1.2.3";
  });
  await useAgentVersionsStore.getState().setVersionChecks();
  expect(useAgentVersionsStore.getState().versions.codex?.status).toBe("error");
  expect(useAgentVersionsStore.getState().versions.claude?.latest).toBe("1.2.3");
  vi.mocked(checkAgentLatestVersion).mockResolvedValue("1.2.4");
  await useAgentVersionsStore.getState().setVersionChecks();
  expect(checkAgentLatestVersion).toHaveBeenCalledTimes(7);
  expect(useAgentVersionsStore.getState().versions.codex?.latest).toBe("1.2.4");
});

it("deduplicates checks while requests are pending", async () => {
  let finish!: (version: string) => void;
  const pending = new Promise<string>((resolve) => { finish = resolve; });
  vi.mocked(checkAgentLatestVersion).mockReturnValue(pending);
  const first = useAgentVersionsStore.getState().setVersionChecks();
  await useAgentVersionsStore.getState().setVersionChecks(true);
  expect(checkAgentLatestVersion).toHaveBeenCalledTimes(6);
  finish("1.2.3");
  await first;
  expect(useAgentVersionsStore.getState().versions.pi?.status).toBe("success");
});
