import { describe, expect, it } from "vitest";
import { summarizeGitRemoteError } from "./gitRemoteError";

describe("summarizeGitRemoteError", () => {
  it("classifies interrupted pack downloads without retaining progress spam", () => {
    const progress = Array.from(
      { length: 80 },
      (_, index) => `Receiving objects: 8% (${6700 + index}/75382), 14.00 MiB | 30.00 KiB/s`,
    ).join("\r");
    const result = summarizeGitRemoteError(
      `${progress}\rerror: RPC failed; curl 56 schannel: server closed abruptly\n` +
        "fatal: early EOF\nfatal: fetch-pack: invalid index-pack output",
    );

    expect(result.kind).toBe("networkInterrupted");
    expect(result.detail).not.toContain("Receiving objects");
    expect(result.detail.length).toBeLessThanOrEqual(180);
  });

  it("recognizes authentication and repository errors", () => {
    expect(summarizeGitRemoteError("fatal: Authentication failed").kind).toBe(
      "authenticationFailed",
    );
    expect(summarizeGitRemoteError("remote: Repository not found").kind).toBe(
      "repositoryNotFound",
    );
  });

  it("recognizes local changes that block a pull", () => {
    const result = summarizeGitRemoteError(
      "error: Your local changes to the following files would be overwritten by merge:\n" +
        "  src/locales/zh-CN.json\nPlease commit your changes or stash them before you merge.",
    );

    expect(result.kind).toBe("localChangesWouldBeOverwritten");
  });

  it("keeps only a capped key line for unknown failures", () => {
    const result = summarizeGitRemoteError(`Receiving objects: 20%\nfatal: ${"x".repeat(300)}`, 80);
    expect(result.kind).toBe("generic");
    expect(result.detail).toMatch(/^fatal:/);
    expect(result.detail.length).toBeLessThanOrEqual(80);
  });
});
