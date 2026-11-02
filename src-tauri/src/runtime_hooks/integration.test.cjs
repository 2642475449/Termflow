// Execute the generated provider integration against a local runtime without calling a model.
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const [mode, source, helperPath] = process.argv.slice(2);
const prompt = '看看下面的报错，帮我处理';
const log = '你好: 无法将“你好”项识别为 cmdlet，进程已退出，退出码 1';
const calls = [];
let stallRuntime = false;
const server = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    assert.equal(req.headers['x-termflow-token'], 'test-runtime-token');
    assert.ok(!body.includes(prompt), 'the raw user prompt must stay inside the agent');
    const value = JSON.parse(body);
    calls.push({ path: req.url, value });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/v1/runtime') {
      assert.equal(value.method, 'context.read');
      assert.equal(value.params.project, 'E:/example/project');
      assert.equal(value.params.sessionId, 'agent-session');
      if (stallRuntime) return;
      res.end(JSON.stringify({ protocolVersion: 1, ok: true, data: {
        projectPath: value.params.project, selectionSource: 'active_runner',
        selectedRun: { id: 'visible-run-id', label: '你好', exitCode: 1 },
        availableRuns: [], output: value.params.includeOutput ? { text: log, nextCursor: 'next-cursor' } : null,
      } }));
    } else {
      assert.equal(req.url, '/internal/session-events');
      res.end('{}');
    }
  });
});

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, {
    TERMFLOW_INGEST_PORT: String(server.address().port), TERMFLOW_INGEST_TOKEN: 'test-runtime-token',
    TERMFLOW_PROJECT_PATH: 'E:/example/project', TERMFLOW_SESSION_ID: 'agent-session',
    TERMFLOW_RUNTIME_HELPER: helperPath, TERMFLOW_CLI: 'E:/Termflow/termflow.cmd',
  });
  const helper = require(helperPath);
  if (mode === 'pi') {
    const events = new Map();
    (await import(pathToFileURL(source).href)).default({ on: (name, handler) => events.set(name, handler) });
    const event = { messageType: 'user', prompt, systemPrompt: 'original system prompt',
      systemPromptOptions: { promptGuidelines: ['existing user guideline'] } };
    const result = await events.get('before_agent_start')(event);
    assert.equal(result.message.display, false);
    assert.ok(result.message.content.includes(log));
    assert.ok(result.message.content.includes('visible-run-id'));
    assert.equal(result.systemPrompt, undefined, 'preserve the agent system prompt composition');
    assert.equal(event.systemPromptOptions.promptGuidelines[0], 'existing user guideline');
    assert.ok(event.systemPromptOptions.promptGuidelines.includes(helper.guidance));
    await events.get('before_agent_start')(event);
    assert.equal(event.systemPromptOptions.promptGuidelines.length, 2, 'do not duplicate instructions');
    const fallback = await events.get('before_agent_start')({ prompt, systemPrompt: 'older Pi prompt' });
    assert.ok(fallback.systemPrompt.startsWith('older Pi prompt\n'));
    const count = calls.length;
    assert.equal(await events.get('before_agent_start')({ messageType: 'custom' }), undefined);
    assert.equal(calls.length, count, 'custom extension messages must not recursively fetch logs');
  } else if (mode === 'opencode') {
    const plugin = await (await import(pathToFileURL(source).href)).TermflowStatusPlugin({});
    const output = { system: ['original system prompt'] };
    await plugin['experimental.chat.system.transform']({}, output);
    assert.equal(output.system.length, 1, 'preserve a single system message for compatible providers');
    assert.ok(output.system[0].startsWith('original system prompt\n'));
    assert.ok(output.system[0].includes('visible-run-id'));
    assert.ok(!output.system[0].includes(log), 'the system hook only includes metadata');
  } else if (mode === 'helper') {
    assert.ok((await helper.getContext({ prompt })).text.includes(log));
    assert.equal(calls.at(-1).value.params.includeOutput, true);
    assert.ok(!(await helper.getContext({ prompt: '把这个按钮改成蓝色' })).text.includes(log));
    assert.equal(calls.at(-1).value.params.includeOutput, false);
    stallRuntime = true;
    const started = Date.now();
    assert.ok((await helper.getContext({ prompt })).text.includes('Live runtime context is unavailable'));
    assert.ok(Date.now() - started < 5000, 'an unavailable runtime must not hold up the request');
    delete process.env.TERMFLOW_SESSION_ID;
    assert.equal(await helper.getContext({ prompt }), null, 'inert outside a Termflow agent session');
  } else {
    const args = mode === 'claude' ? ['UserPromptSubmit'] : [mode];
    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [source, ...args], { windowsHide: true });
      let stdout = '', stderr = '';
      const timeout = setTimeout(() => { child.kill(); reject(new Error('hook did not finish')); }, 4000);
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
      child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt }));
    });
    assert.equal(output.code, 0, output.stderr);
    if (mode === 'qoder') {
      assert.equal(output.stdout, '', 'keep the existing Qoder stdout protocol');
      assert.ok(!calls.some((call) => call.path === '/api/v1/runtime'));
      assert.ok(calls.some((call) => call.path === '/internal/session-events'));
      return;
    }
    const context = JSON.parse(output.stdout).hookSpecificOutput;
    assert.equal(context.hookEventName, 'UserPromptSubmit');
    assert.ok(context.additionalContext.includes(log));
    assert.ok(context.additionalContext.includes('visible-run-id'));
    assert.ok(calls.some((call) => call.path === '/internal/session-events'), 'preserve status reporting');
  }
  const runtimeCalls = calls.filter((call) => call.path === '/api/v1/runtime');
  assert.ok(runtimeCalls.length > 0);
  if (!['helper', 'opencode'].includes(mode)) {
    assert.ok(runtimeCalls.every((call) => call.value.params.includeOutput === true));
  }
}

main().then(() => server.close()).catch((error) => {
  console.error(error);
  server.close();
  process.exitCode = 1;
});
