import { expect, it } from "vitest";
import { compareAgentVersion } from "./agentVersions";

it.each([
  ["codex-cli 0.153.2", "0.153.4", "updateAvailable"],
  ["2.1.263 (Claude Code)", "2.1.263", "upToDate"],
  ["v1.10.0", "1.9.0", "ahead"],
  ["1.2.3-beta.2", "1.2.3-beta.10", "updateAvailable"],
  ["1.2.3-beta", "1.2.3", "updateAvailable"],
  ["1.2.3", "1.2.3-beta", "ahead"],
  ["1.2.3+build.42", "1.2.3", "upToDate"],
  [null, "1.2.3", "unknown"],
  ["unexpected output", "1.2.3", "unknown"],
  ["1.2.3.4", "1.2.3", "unknown"],
] as const)("compares %s with %s", (local, latest, result) => {
  expect(compareAgentVersion(local, latest)).toBe(result);
});
