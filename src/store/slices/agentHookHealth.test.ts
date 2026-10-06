import { beforeEach, expect, it, vi } from "vitest";
import { ensureAgentStatusHook, type AgentHookStatus } from "@/lib/api";
import { useAgentHookHealthStore } from "./agentHookHealth";

vi.mock("@/lib/api", () => ({ ensureAgentStatusHook: vi.fn() }));
const configured: AgentHookStatus = {
  agent: "codex", configured: true, configPath: "custom/hooks.json",
  codexActivation: { disabled: false, configurationId: "one" },
};
beforeEach(() => {
  vi.resetAllMocks();
  useAgentHookHealthStore.setState({ status: "unknown", configurationId: undefined, configPath: undefined, observedAt: undefined, error: undefined, checking: false });
});

it("requires a callback and invalidates evidence when the configuration changes", () => {
  const store = useAgentHookHealthStore.getState();
  store.setConfiguration(configured);
  expect(useAgentHookHealthStore.getState().status).toBe("pending");
  store.setObserved(100);
  store.setConfiguration(configured);
  expect(useAgentHookHealthStore.getState().status).toBe("observed");
  store.setConfiguration({ ...configured, codexActivation: { disabled: false, configurationId: "two" } });
  expect(useAgentHookHealthStore.getState().status).toBe("pending");
  expect(useAgentHookHealthStore.getState().observedAt).toBeUndefined();
});

it("does not let old callbacks override an explicit disable or configuration failure", () => {
  const store = useAgentHookHealthStore.getState();
  store.setConfiguration({ ...configured, codexActivation: { disabled: true, configurationId: "disabled" } });
  store.setObserved(100);
  expect(useAgentHookHealthStore.getState().status).toBe("disabled");
  store.setError("invalid config");
  store.setObserved(200);
  expect(useAgentHookHealthStore.getState().status).toBe("error");
  store.setConfiguration(configured);
  expect(useAgentHookHealthStore.getState().status).toBe("pending");
  store.setObserved(300);
  store.setConfiguration({ ...configured, configured: false });
  store.setConfiguration(configured);
  expect(useAgentHookHealthStore.getState().status).toBe("pending");
});

it("isolates other agents and does not persist verification across app restarts", () => {
  useAgentHookHealthStore.getState().setConfiguration({ ...configured, agent: "claude" });
  expect(useAgentHookHealthStore.getState().status).toBe("unknown");
  expect(useAgentHookHealthStore.getInitialState().observedAt).toBeUndefined();
});

it("deduplicates refreshes and exposes recoverable check errors", async () => {
  let finish!: (status: AgentHookStatus) => void;
  vi.mocked(ensureAgentStatusHook).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const pending = useAgentHookHealthStore.getState().setCheck();
  await useAgentHookHealthStore.getState().setCheck();
  expect(ensureAgentStatusHook).toHaveBeenCalledTimes(1);
  finish(configured);
  await pending;
  expect(useAgentHookHealthStore.getState().status).toBe("pending");
  vi.mocked(ensureAgentStatusHook).mockRejectedValue(new Error("unreadable"));
  await useAgentHookHealthStore.getState().setCheck();
  expect(useAgentHookHealthStore.getState()).toMatchObject({ status: "error", checking: false, error: "unreadable" });
});
