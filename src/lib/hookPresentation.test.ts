import { expect, it } from "vitest";
import type { HookInfo } from "@/types";
import { getHookCommandName, getHookSource, groupHooksBySource } from "./hookPresentation";

it("recognizes known script filenames across Windows and Unix paths without claiming unknown commands", () => {
  expect(getHookSource({ command: 'node "C:\\Users\\test\\.claude\\hooks\\termflow-hook.cjs" stop' })).toBe("termflow");
  expect(getHookSource({ command: '/tmp/orca-agent-hook.exe claude' })).toBe("orca");
  expect(getHookSource({ command: '"C:/Downloads/Pebrel/runtime/pebrel-hook.exe"' })).toBe("pebrel");
  expect(getHookSource({ command: 'node /tmp/my-termflow-hook.cjs' })).toBe("other");
  expect(getHookSource({ command: 'node /tmp/termflow-hook.cjs.backup' })).toBe("other");
  expect(getHookSource({ command: 'C:/Users/test/.pi/agent/extensions/termflow-agent-status.js' })).toBe("termflow");
});

it("groups every registration exactly once in stable source order and omits empty groups", () => {
  const rows = [
    { id: "a", command: "pebrel-hook.exe" },
    { id: "b", command: "node termflow-hook.cjs stop" },
    { id: "c", command: "custom-hook" },
    { id: "d", command: "node termflow-hook.cjs start" },
  ] as HookInfo[];
  const groups = groupHooksBySource(rows);
  expect(groups.map((group) => [group.source, group.hooks.map((hook) => hook.id)]))
    .toEqual([["termflow", ["b", "d"]], ["pebrel", ["a"]], ["other", ["c"]]]);
});

it("extracts a compact command filename without exposing full paths in the list", () => {
  expect(getHookCommandName({ command: 'node "C:\\My Tools\\termflow-hook.cjs" stop' })).toBe("termflow-hook.cjs");
  expect(getHookCommandName({ command: '"C:/My Tools/pebrel-hook.exe"' })).toBe("pebrel-hook.exe");
  expect(getHookCommandName({ command: 'custom-command --flag' })).toBe("custom-command");
  expect(getHookCommandName({ command: '"C:\\Program Files\\tool\\"' })).toBe("tool");
  expect(getHookCommandName({ command: '' })).toBe("");
});
