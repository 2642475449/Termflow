// Reused by Claude and Codex UserPromptSubmit hooks; preserve their existing status reporting.
const termflowContextEvent = typeof hookName === 'string' ? hookName : normalizedEvent;
const termflowContextReady = (async () => {
  if (typeof agent === 'string' && !['claude', 'codex'].includes(agent)) return;
  if (termflowContextEvent !== 'userpromptsubmit' || !process.env.TERMFLOW_RUNTIME_HELPER) return;
  try {
    const helper = require(process.env.TERMFLOW_RUNTIME_HELPER);
    const context = await helper.getContext({ prompt: input.prompt });
    if (context) await new Promise((resolve) => process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context.text },
    }) + '\n', resolve));
  } catch {}
})();
let termflowHookFinished = false;
const finishTermflowHook = () => {
  if (termflowHookFinished) return;
  termflowHookFinished = true;
  termflowContextReady.finally(() => process.exit(0));
};
