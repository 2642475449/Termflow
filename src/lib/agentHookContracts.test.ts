import { readFileSync } from "node:fs";
import * as crypto from "node:crypto";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

// 执行后端实际安装的脚本，验证原生事件到 IPC 载荷的完整映射，不调用模型。
const rust = readFileSync(new URL("../../src-tauri/src/commands/claude_config.rs", import.meta.url), "utf8");
const script = rust.split("fn build_hook_script_content() -> String {")[1].split('r#"')[1].split('"#')[0];

function replay(event: string, input: Record<string, unknown> = {}) {
  const payloads: Array<Record<string, unknown>> = [];
  const exited = new Error("script exited");
  const request = {
    on: () => request,
    write: (body: string) => { payloads.push(JSON.parse(body) as Record<string, unknown>); },
    end: () => {},
    destroy: () => {},
  };
  try {
    runInNewContext(script, {
      require: (name: string) => {
        if (name === "fs") return { readFileSync: () => JSON.stringify(input) };
        if (name === "http") return { request: () => request };
        if (name === "crypto") return crypto;
        throw new Error(`Unexpected import: ${name}`);
      },
      Buffer,
      process: {
        argv: ["node", "hook.cjs", event.toLowerCase()],
        env: { TERMFLOW_INGEST_PORT: "12345", TERMFLOW_INGEST_TOKEN: "test-token", TERMFLOW_SESSION_ID: "test-session", TERMFLOW_PROJECT_PATH: "test-project" },
        cwd: () => "test-project",
        exit: () => { throw exited; },
      },
    }, { timeout: 1000 });
  } catch (error) {
    if (error !== exited) throw error;
  }
  return payloads;
}

it.each([
  ["StopFailure", "error", "process_error"],
  ["PermissionDenied", "running", "permission_denied"],
  ["Elicitation", "waiting", "waiting_input"],
  ["ElicitationResult", "running", "working"],
  ["SessionEnd", "waiting", "session_end"],
])("maps %s without forwarding sensitive provider content", (event, state, eventType) => {
  const payloads = replay(event, { prompt: "private prompt", error: "secret credential", tool_name: "Bash", tool_input: { command: "private command" }, tool_use_id: "tool-123" });
  expect(payloads).toHaveLength(1);
  expect(payloads[0]).toMatchObject({ agent: "claude", state, event_type: eventType, session_id: "test-session" });
  const serialized = JSON.stringify(payloads);
  expect(serialized).not.toContain("private");
  expect(serialized).not.toContain("secret credential");
});

it("retains permission correlation after a denial", () => {
  const input = { tool_name: "Bash", tool_input: { command: "test" }, tool_use_id: "tool-123" };
  const request = replay("PermissionRequest", input)[0];
  expect(replay("PermissionDenied", input)[0].payload).toEqual(request.payload);
});

it("does not report a child failure or exit as a parent failure or exit", () => {
  expect(replay("StopFailure", { agent_id: "child" })).toEqual([]);
  expect(replay("SessionEnd", { agent_id: "child" })).toEqual([]);
  expect(replay("UnknownFutureEvent")).toEqual([]);
});
