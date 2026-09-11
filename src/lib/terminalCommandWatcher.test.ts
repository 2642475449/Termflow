import { describe, expect, it } from "vitest";
import { createTerminalCommandWatcher } from "./terminalCommandWatcher";

describe("createTerminalCommandWatcher", () => {
  it("completes only a valid OSC 133 C to D lifecycle", () => {
    const watcher = createTerminalCommandWatcher();

    expect(watcher.getStatus()).toBe("unavailable");
    expect(watcher.consumeOsc133("A", 10)).toBeNull();
    expect(watcher.getStatus()).toBe("idle");
    expect(watcher.consumeOsc133("D;0", 20)).toBeNull();
    expect(watcher.consumeOsc133("C", 100)).toBeNull();
    expect(watcher.getStatus()).toBe("running");
    expect(watcher.consumeOsc133("D;0", 30_250)).toEqual({
      commandId: 1,
      durationMs: 30_150,
      exitCode: 0,
    });
    expect(watcher.getStatus()).toBe("idle");
  });

  it("replaces a malformed running lifecycle instead of inventing a completion", () => {
    const watcher = createTerminalCommandWatcher();

    watcher.consumeOsc133("C", 100);
    watcher.consumeOsc133("C", 500);

    expect(watcher.consumeOsc133("D;3", 800)).toEqual({
      commandId: 2,
      durationMs: 300,
      exitCode: 3,
    });
    expect(watcher.consumeOsc133("D;3", 900)).toBeNull();
  });

  it("keeps an unavailable result unknown and accepts only safe integer exit codes", () => {
    const watcher = createTerminalCommandWatcher();

    expect(watcher.consumeOsc133("C", 0)).toBeNull();
    expect(watcher.consumeOsc133("D;not-a-code", 50)).toEqual({
      commandId: 1,
      durationMs: 50,
      exitCode: null,
    });

    watcher.consumeOsc133("C", 100);
    expect(watcher.consumeOsc133("D;9007199254740992", 150)?.exitCode).toBeNull();
  });

  it("does not turn prompt markers or silence into a completion", () => {
    const watcher = createTerminalCommandWatcher();

    watcher.consumeOsc133("C", 100);
    expect(watcher.consumeOsc133("A", 5_000)).toBeNull();
    expect(watcher.getStatus()).toBe("running");
    watcher.reset();
    expect(watcher.getStatus()).toBe("idle");
  });
});
