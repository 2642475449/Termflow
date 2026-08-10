import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const definitions = {
  claude: {
    command: "claude",
    args: [
      "-p",
      "Reply with exactly OK. Do not use tools.",
      "--tools",
      "",
      "--max-turns",
      "1",
      "--max-budget-usd",
      "0.10",
      "--no-session-persistence",
    ],
    expected: ["running", "completed"],
  },
  codex: {
    command: "codex",
    args: [
      "exec",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--json",
      "Reply with exactly OK. Do not use tools.",
    ],
    expected: ["running", "completed"],
  },
  qoder: {
    command: "qoderclicn",
    args: [
      "-p",
      "--input-format",
      "text",
      "--output-format",
      "text",
      "--permission-mode",
      "dont_ask",
      "--tools",
      "",
      "--no-session-persistence",
    ],
    stdin: "Reply with exactly OK. Do not use tools.",
    expected: ["running", "completed"],
  },
  antigravity: {
    command: "agy",
    args: [
      "-p",
      "Reply with exactly OK. Do not use tools.",
      "--print-timeout",
      "2m",
    ],
    expected: ["running", "completed"],
  },
  opencode: {
    command: "opencode",
    args: ["run", "Reply with exactly OK. Do not use tools.", "--format", "json"],
    expected: ["running", "completed"],
  },
};

const requested = process.argv.slice(2);
const agentIds = requested.length > 0 ? requested : Object.keys(definitions);
for (const agentId of agentIds) {
  if (!definitions[agentId]) throw new Error(`Unknown agent: ${agentId}`);
}

const token = randomBytes(24).toString("hex");
const eventsBySession = new Map();
const server = http.createServer((request, response) => {
  if (
    request.method !== "POST" ||
    request.url !== "/internal/session-events" ||
    request.headers["x-termflow-token"] !== token
  ) {
    response.writeHead(404).end();
    return;
  }

  let raw = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    if (raw.length < 1_000_000) raw += chunk;
  });
  request.on("end", () => {
    try {
      const payload = JSON.parse(raw);
      const sessionId = String(payload.session_id ?? "");
      const events = eventsBySession.get(sessionId) ?? [];
      // Deliberately retain only lifecycle fields. Hook payloads can contain
      // prompts and tool arguments and must never appear in validation output.
      events.push({
        agent: String(payload.agent ?? ""),
        state: String(payload.state ?? ""),
        eventType: String(payload.event_type ?? ""),
      });
      eventsBySession.set(sessionId, events);
      response.writeHead(204).end();
    } catch {
      response.writeHead(400).end();
    }
  });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Failed to bind ingest server");

function runAgent(agentId) {
  const definition = definitions[agentId];
  const sessionId = randomUUID();
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const child = spawn(
      definition.command,
      definition.args,
      {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TERMFLOW_SESSION_ID: sessionId,
        TERMFLOW_PROJECT_PATH: process.cwd(),
        TERMFLOW_INGEST_PORT: String(address.port),
        TERMFLOW_INGEST_TOKEN: token,
      },
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: [definition.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      }
    );

    if (definition.stdin) child.stdin.end(definition.stdin, "utf8");

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 4000) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 4000) stderr += chunk.toString();
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } else {
        child.kill("SIGKILL");
      }
      setTimeout(
        () =>
          finish({
            agentId,
            sessionId,
            exitCode: null,
            error: "Lifecycle validation timed out after 120 seconds",
            startedAt,
          }),
        1500
      );
    }, 120_000);
    child.on("error", (error) => {
      finish({ agentId, sessionId, exitCode: null, error: error.message, startedAt });
    });
    child.on("exit", (exitCode, signal) => {
      finish({
        agentId,
        sessionId,
        exitCode,
        signal,
        error: exitCode === 0 ? null : (stderr.trim() || stdout.trim()).slice(-1000),
        startedAt,
      });
    });
  });
}

const results = [];
for (const agentId of agentIds) {
  const processResult = await runAgent(agentId);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const events = eventsBySession.get(processResult.sessionId) ?? [];
  const observedStates = [...new Set(events.map((event) => event.state).filter(Boolean))];
  const expectedStates = definitions[agentId].expected;
  results.push({
    agent: agentId,
    processExitCode: processResult.exitCode,
    durationMs: Date.now() - processResult.startedAt,
    observedStates,
    observedEventTypes: [...new Set(events.map((event) => event.eventType).filter(Boolean))],
    lifecyclePassed:
      processResult.exitCode === 0 && expectedStates.every((state) => observedStates.includes(state)),
    error: processResult.error,
  });
}

await new Promise((resolve) => server.close(resolve));
server.closeAllConnections?.();
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
process.exitCode = results.every((result) => result.lifecyclePassed) ? 0 : 1;
