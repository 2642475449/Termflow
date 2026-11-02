import { describe, expect, it } from "vitest";
import {
  canWriteRemoteSession,
  decodeRemoteOutput,
  EMPTY_REMOTE_HOST_DRAFT,
  isRemoteConnectionBusy,
  isRemoteHost,
  reconcileRemoteRead,
  remoteHostDraft,
  remoteErrorText,
  validateRemoteHostDraft,
  type RemoteConnection,
  type RemoteHostDraft,
  type RemoteSession,
  type RemoteSessionRead,
} from "./remote";

function draft(patch: Partial<RemoteHostDraft> = {}): RemoteHostDraft {
  return { ...EMPTY_REMOTE_HOST_DRAFT, name: "Linux", target: "development", ...patch };
}

function session(patch: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id: "session-1", instanceId: "instance-1", agentId: "codex", cwd: "/srv/project",
    title: "Codex", pid: 42, processState: "running", taskState: "waiting", revision: 1,
    createdAt: 1000, exitCode: null, hookObserved: false, outputStart: 0, outputEnd: 4,
    rows: 30, cols: 90, ...patch,
  };
}

function connection(state: RemoteConnection["state"]): RemoteConnection {
  return { hostId: "host-1", state, authOutput: "", authRevision: 0 };
}

function read(patch: Partial<RemoteSessionRead> = {}): RemoteSessionRead {
  return {
    sessionId: "session-1", instanceId: "instance-1", offset: 0, nextOffset: 4,
    data: "dGVzdA==", truncated: false, session: session(), ...patch,
  };
}

describe("remote workspace helpers", () => {
  it("accepts SSH aliases, user hosts and IPv6 without shell splitting", () => {
    for (const target of ["development", "user@host.example", "192.0.2.10", "2001:db8::1", "user@[2001:db8::1]"]) {
      expect(validateRemoteHostDraft(draft({ target }))).toBeNull();
    }
    expect(validateRemoteHostDraft(draft({ port: " 2222 ", identityFile: "C:/Keys/project key" }))).toBeNull();
  });

  it("rejects unnamed hosts, option-like targets and target whitespace", () => {
    expect(validateRemoteHostDraft(draft({ name: "  " }))).toBe("remote.errors.nameRequired");
    for (const target of ["", "-oProxyCommand=anything", "user@host command", "host\nother", "host\tother", "host\0other"]) {
      expect(validateRemoteHostDraft(draft({ target }))).toBe("remote.errors.targetInvalid");
    }
  });

  it("validates port range and identity file control characters", () => {
    for (const port of ["", "1", "22", "65535"]) {
      expect(validateRemoteHostDraft(draft({ port }))).toBeNull();
    }
    for (const port of ["0", "65536", "22.5", "-22", "abc", "22 extra"]) {
      expect(validateRemoteHostDraft(draft({ port }))).toBe("remote.errors.portInvalid");
    }
    for (const identityFile of ["key\nfile", "key\rfile", "key\0file"]) {
      expect(validateRemoteHostDraft(draft({ identityFile }))).toBe("remote.errors.identityInvalid");
    }
  });

  it("creates independent form drafts and preserves optional SSH settings", () => {
    const first = remoteHostDraft();
    first.name = "changed";
    expect(remoteHostDraft().name).toBe("");
    expect(remoteHostDraft({ id: "host-1", name: "Linux", target: "user@host", port: 2222, identityFile: "/keys/id" })).toEqual({
      id: "host-1", name: "Linux", target: "user@host", port: "2222", identityFile: "/keys/id",
    });
  });

  it("distinguishes connection progress from connected and disconnected states", () => {
    for (const state of ["connecting", "authenticating", "deploying"] as const) {
      expect(isRemoteConnectionBusy(connection(state))).toBe(true);
    }
    for (const state of ["connected", "disconnected", "error"] as const) {
      expect(isRemoteConnectionBusy(connection(state))).toBe(false);
    }
    expect(isRemoteConnectionBusy()).toBe(false);
  });

  it("only accepts terminal input with a live process and connected transport", () => {
    expect(canWriteRemoteSession(connection("connected"), session({ taskState: "waiting" }))).toBe(true);
    expect(canWriteRemoteSession(connection("connected"), session({ taskState: "completed" }))).toBe(true);
    expect(canWriteRemoteSession(connection("connected"), session({ processState: "exited" }))).toBe(false);
    for (const state of ["connecting", "authenticating", "deploying", "disconnected", "error"] as const) {
      expect(canWriteRemoteSession(connection(state), session())).toBe(false);
    }
    expect(canWriteRemoteSession(undefined, session())).toBe(false);
    expect(canWriteRemoteSession(connection("connected"), undefined)).toBe(false);
  });

  it("keeps ANSI and split UTF-8 as raw bytes for xterm", () => {
    const original = new TextEncoder().encode("\u001b[32m你好🌊\u001b[0m");
    const split = 8;
    const left = decodeRemoteOutput(Buffer.from(original.subarray(0, split)).toString("base64"));
    const right = decodeRemoteOutput(Buffer.from(original.subarray(split)).toString("base64"));
    expect(Uint8Array.from([...left, ...right])).toEqual(original);
    expect(decodeRemoteOutput("")).toEqual(new Uint8Array());
  });

  it("appends only the expected stream and cursor", () => {
    const expected = { sessionId: "session-1", instanceId: "instance-1", cursor: 0 };
    expect(reconcileRemoteRead(read(), expected)).toBe("append");
    expect(reconcileRemoteRead(read({ sessionId: "other" }), expected)).toBe("ignore");
    expect(reconcileRemoteRead(read({ instanceId: "old-instance" }), expected)).toBe("ignore");
    expect(reconcileRemoteRead(read({ offset: -1 }), expected)).toBe("ignore");
    expect(reconcileRemoteRead(read({ offset: 4, nextOffset: 3 }), expected)).toBe("ignore");
    expect(reconcileRemoteRead(read(), { ...expected, cursor: 4 })).toBe("ignore");
  });

  it("resets a truncated stream or explicit output gap", () => {
    const expected = { sessionId: "session-1", instanceId: "instance-1", cursor: 0 };
    expect(reconcileRemoteRead(read({ truncated: true }), expected)).toBe("reset");
    expect(reconcileRemoteRead(read({ offset: 10, nextOffset: 14 }), expected)).toBe("reset");
    expect(reconcileRemoteRead(read({ truncated: true, instanceId: "old" }), expected)).toBe("ignore");
  });

  it("rejects non-integral or unsafe byte offsets", () => {
    const expected = { sessionId: "session-1", instanceId: "instance-1", cursor: 0 };
    for (const nextOffset of [Number.POSITIVE_INFINITY, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(reconcileRemoteRead(read({ nextOffset }), expected)).toBe("ignore");
    }
  });

  it("validates persisted public host records before rehydrating", () => {
    const host = { id: "host-1", name: "Linux", target: "user@host" };
    expect(isRemoteHost(host)).toBe(true);
    expect(isRemoteHost({ ...host, port: 65535, identityFile: "/keys/id" })).toBe(true);
    for (const port of [0, -1, 65536, 22.5, Number.NaN, "22", null]) {
      expect(isRemoteHost({ ...host, port })).toBe(false);
    }
    for (const invalid of [null, undefined, "host", [], {}, { ...host, id: 1 }, { ...host, name: null }, { ...host, target: false }, { ...host, identityFile: 42 }]) {
      expect(isRemoteHost(invalid)).toBe(false);
    }
  });

  it("maps known transport errors while preserving unrecognized diagnostics", () => {
    expect(remoteErrorText(new Error("remote_python_required"))).toBe("remote.errors.pythonRequired");
    expect(remoteErrorText("remote_transport_failed: connection lost")).toBe("remote.errors.transportFailed");
    expect(remoteErrorText("remote_invalid_ssh_port")).toBe("remote.errors.portInvalid");
    expect(remoteErrorText("remote_future_error")).toBe("remote.errors.connectionFailed");
    expect(remoteErrorText("working directory is not a directory")).toBe("remote.errors.directoryInvalid");
    expect(remoteErrorText("server has running sessions; stop them explicitly first")).toBe("remote.errors.serverHasSessions");
    expect(remoteErrorText(new Error("Detailed custom diagnostic"))).toBe("Detailed custom diagnostic");
    expect(remoteErrorText(42)).toBe("42");
  });
});
