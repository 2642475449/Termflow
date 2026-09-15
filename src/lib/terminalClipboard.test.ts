import { describe, expect, it, vi } from "vitest";
import {
  createTerminalPasteGate,
  encodeClipboardImage,
  formatClipboardImageReference,
  MAX_CLIPBOARD_IMAGE_BYTES,
  readTerminalClipboard,
  readTerminalPasteEvent,
} from "./terminalClipboard";

function clipboardItem(blobs: Record<string, Blob>): ClipboardItem {
  return {
    types: Object.keys(blobs),
    presentationStyle: "unspecified",
    getType: async (type) => blobs[type],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

describe("terminal clipboard", () => {
  it("prefers the screenshot to text even when text is in an earlier item", async () => {
    const blob = new Blob(["png"], { type: "image/png" });
    const clipboard = {
      read: vi.fn().mockResolvedValue([
        clipboardItem({ "text/plain": new Blob(["source URL"]) }),
        clipboardItem({ "image/png": blob }),
      ]),
      readText: vi.fn(),
    };
    expect(await readTerminalClipboard(clipboard)).toEqual({ kind: "image", blob });
    expect(clipboard.readText).not.toHaveBeenCalled();
  });

  it("falls back to text when rich clipboard reading is unavailable", async () => {
    const clipboard = { read: vi.fn().mockRejectedValue(new Error("permission")), readText: vi.fn().mockResolvedValue("hello") };
    expect(await readTerminalClipboard(clipboard)).toEqual({ kind: "text", text: "hello" });
    clipboard.readText.mockResolvedValue("");
    await expect(readTerminalClipboard(clipboard)).rejects.toThrow("terminal.clipboardReadFailed");
    clipboard.readText.mockRejectedValue(new Error("denied"));
    await expect(readTerminalClipboard(clipboard)).rejects.toThrow("denied");
  });

  it("does not silently downgrade a failed image read to text", async () => {
    const item = clipboardItem({ "image/png": new Blob() });
    item.getType = async () => { throw new Error("image unavailable"); };
    await expect(readTerminalClipboard({ read: async () => [item], readText: async () => "text" }))
      .rejects.toThrow("image unavailable");
  });

  it("reads plain text and recognizes an empty clipboard", async () => {
    expect(await readTerminalClipboard({ read: async () => [], readText: vi.fn() })).toEqual({ kind: "empty" });
    expect(await readTerminalClipboard({
      read: async () => [clipboardItem({ "text/plain": new Blob(["a\nb"]) })], readText: vi.fn(),
    })).toEqual({ kind: "text", text: "a\nb" });
  });

  it("captures native paste image data before reading attached text", () => {
    const blob = new Blob(["image"], { type: "image/png" });
    // node 测试使用最小 DataTransfer 替身，不依赖 DOM。
    const data = { items: [{ type: "image/png", getAsFile: () => blob }], getData: vi.fn() } as unknown as DataTransfer;
    expect(readTerminalPasteEvent(data)).toEqual({ kind: "image", blob });
    expect(data.getData).not.toHaveBeenCalled();
  });

  it("encodes binary payloads without corruption and rejects oversized images before IPC", async () => {
    expect(await encodeClipboardImage(new Blob([new Uint8Array([0, 255, 128])], { type: "image/png" }))).toBe("AP+A");
    await expect(encodeClipboardImage(new Blob([new Uint8Array(MAX_CLIPBOARD_IMAGE_BYTES + 1)], { type: "image/png" })))
      .rejects.toThrow("terminal.clipboardImageTooLarge");
    await expect(encodeClipboardImage(new Blob(["svg"], { type: "image/svg+xml" })))
      .rejects.toThrow("terminal.clipboardImageUnsupported");
  });

  it("formats agent-specific references with separators and quoted Windows paths", () => {
    expect(formatClipboardImageReference("antigravity", "C:\\Users\\Test User\\image.png"))
      .toBe(' @"C:/Users/Test User/image.png" ');
    expect(formatClipboardImageReference("claude", "C:\\cache\\image.png")).toBe(" @C:/cache/image.png ");
    expect(formatClipboardImageReference("codex", "C:\\cache\\image.png")).toBe(" C:/cache/image.png ");
    expect(formatClipboardImageReference("qoder", "/tmp/image.png")).toBe(" /tmp/image.png ");
  });

  it("keeps slow screenshot saves before later typing, paste and Enter", async () => {
    const received: string[] = [];
    const first = deferred<string>();
    const second = deferred<string>();
    const gate = createTerminalPasteGate({
      input: (data) => received.push(data),
      paste: (text) => gate.input(`[paste:${text}]`),
      error: vi.fn(),
    });
    gate.input("before");
    const firstPaste = gate.paste(() => first.promise);
    gate.input("question");
    const secondPaste = gate.paste(() => second.promise);
    gate.input("\r");
    second.resolve("second");
    expect(received).toEqual(["before"]);
    first.resolve("first");
    await firstPaste;
    await secondPaste;
    await gate.paste(async () => "");
    expect(received).toEqual(["before", "[paste:first]", "question", "[paste:second]", "\r"]);
  });

  it("reports save errors and allows subsequent input and pastes", async () => {
    const input = vi.fn();
    const error = vi.fn();
    const gate = createTerminalPasteGate({ input, paste: input, error });
    const saving = deferred<string>();
    const paste = gate.paste(() => saving.promise);
    gate.input("after");
    saving.reject(new Error("disk full"));
    await paste;
    await gate.paste(async () => "next");
    expect(error).toHaveBeenCalledWith(new Error("disk full"));
    expect(input.mock.calls).toEqual([["after"], ["next"]]);
  });

  it("never writes late clipboard results into a disposed terminal", async () => {
    const input = vi.fn();
    const saving = deferred<string>();
    const gate = createTerminalPasteGate({ input, paste: input, error: vi.fn() });
    const paste = gate.paste(() => saving.promise);
    gate.input("\r");
    gate.dispose();
    saving.resolve("image path");
    await paste;
    expect(input).not.toHaveBeenCalled();
  });
});
