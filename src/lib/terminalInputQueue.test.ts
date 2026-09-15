import { describe, expect, it } from "vitest";
import { createTerminalInputQueue } from "./terminalInputQueue";

describe("createTerminalInputQueue", () => {
  it("waits for each character write before sending later characters or Enter", async () => {
    const enqueue = createTerminalInputQueue();
    const started: string[] = [];
    const written: string[] = [];
    let finishFirst: () => void = () => undefined;
    const firstWrite = new Promise<void>((resolve) => { finishFirst = resolve; });
    const pending = ["你", "好", "好", "。", "\r"].map((text, index) =>
      enqueue(async () => {
        started.push(text);
        if (index === 0) await firstWrite;
        written.push(text);
      }),
    );
    await Promise.resolve();
    expect(started).toEqual(["你"]);
    expect(written).toEqual([]);
    finishFirst();
    await Promise.all(pending);
    expect(written).toEqual(["你", "好", "好", "。", "\r"]);
  });

  it("reports a failed write and continues with subsequent input", async () => {
    const enqueue = createTerminalInputQueue();
    const failure = new Error("write failed");
    const failed = enqueue(() => { throw failure; });
    const written: string[] = [];
    const next = enqueue(async () => { written.push("后续文字"); });
    await expect(failed).rejects.toBe(failure);
    await next;
    expect(written).toEqual(["后续文字"]);
  });

  it("does not block another terminal while one terminal is waiting", async () => {
    const first = createTerminalInputQueue();
    const second = createTerminalInputQueue();
    let release: () => void = () => undefined;
    const blocked = first(() => new Promise<void>((resolve) => { release = resolve; }));
    let completed = false;
    await second(async () => { completed = true; });
    expect(completed).toBe(true);
    release();
    await blocked;
  });
});
