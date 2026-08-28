import { describe, expect, it } from "vitest";
import type { Session } from "@/types";
import {
  getAgentUserResponseBaseline,
  getCheckpointedAgentUserResponseBaseline,
  isAgentUserResponseBaselineCurrent,
} from "./agentUserResponse";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-a",
    path: "E:/project",
    name: "Agent",
    createdAt: 1,
    agentId: "codex",
    active: true,
    status: "waiting",
    statusRevision: 4,
    lastEventType: "permission_request",
    ...overrides,
  };
}

describe("agent user response baseline", () => {
  it.each(["permission_request", "waiting_input"] as const)(
    "captures a revisioned %s wait",
    (eventType) => {
      expect(getAgentUserResponseBaseline(session({ lastEventType: eventType }))).toEqual({
        revision: 4,
        eventType,
      });
    },
  );

  it("does not infer from an ordinary idle wait", () => {
    expect(getAgentUserResponseBaseline(session({ lastEventType: "session_started" }))).toBeNull();
  });

  it("routes a waiting input as an Agent response only while a checkpoint turn is active", () => {
    expect(getCheckpointedAgentUserResponseBaseline(session({
      checkpointActiveTurnId: "turn-a",
      lastEventType: "waiting_input",
    }))).toEqual({
      revision: 4,
      eventType: "waiting_input",
    });
    expect(getCheckpointedAgentUserResponseBaseline(session({
      checkpointActiveTurnId: null,
      lastEventType: "waiting_input",
    }))).toBeNull();
  });

  it("rejects a baseline after a provider transition wins the race", () => {
    const baseline = getAgentUserResponseBaseline(session())!;
    expect(isAgentUserResponseBaselineCurrent(session({ statusRevision: 5 }), baseline)).toBe(false);
    expect(isAgentUserResponseBaselineCurrent(session({ status: "running" }), baseline)).toBe(false);
  });
});
