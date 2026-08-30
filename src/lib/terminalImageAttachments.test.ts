import { describe, expect, it } from "vitest";
import { quotePathForShell, resolveDroppedImageAttachments } from "./terminalImageAttachments";

describe("quotePathForShell", () => {
  it("wraps the path in double quotes", () => {
    expect(quotePathForShell("C:/images/a.png")).toBe('"C:/images/a.png"');
  });

  it("escapes embedded double quotes", () => {
    expect(quotePathForShell('C:/images/"shot".png')).toBe('"C:/images/\\"shot\\".png"');
  });
});

describe("resolveDroppedImageAttachments", () => {
  it("builds attachments from preview data in input order", async () => {
    const readPreview = async (path: string) => ({ dataUrl: `data:image/png;base64,${path}` });
    const result = await resolveDroppedImageAttachments(
      ["C:/images/a.png", "D:\\shots\\b.jpg"],
      readPreview
    );

    expect(result.failedCount).toBe(0);
    expect(result.accepted).toEqual([
      {
        id: "C:/images/a.png",
        src: "data:image/png;base64,C:/images/a.png",
        alt: "a.png",
        insertedText: '"C:/images/a.png"',
      },
      {
        id: "D:\\shots\\b.jpg",
        src: "data:image/png;base64,D:\\shots\\b.jpg",
        alt: "b.jpg",
        insertedText: '"D:\\shots\\b.jpg"',
      },
    ]);
  });

  it("counts failures without blocking other attachments", async () => {
    const readPreview = async (path: string) => {
      if (path.endsWith("broken.png")) {
        throw new Error("read failed");
      }
      return { dataUrl: "data:image/png;base64,ok" };
    };

    const result = await resolveDroppedImageAttachments(
      ["C:/images/a.png", "C:/images/broken.png", "C:/images/b.png"],
      readPreview
    );

    expect(result.failedCount).toBe(1);
    expect(result.accepted.map((item) => item.id)).toEqual([
      "C:/images/a.png",
      "C:/images/b.png",
    ]);
  });

  it("deduplicates repeated paths before resolving", async () => {
    const calls: string[] = [];
    const readPreview = async (path: string) => {
      calls.push(path);
      return { dataUrl: "data:image/png;base64,ok" };
    };

    const result = await resolveDroppedImageAttachments(
      ["C:/images/a.png", "C:/images/a.png"],
      readPreview
    );

    expect(calls).toEqual(["C:/images/a.png"]);
    expect(result.accepted).toHaveLength(1);
    expect(result.failedCount).toBe(0);
  });

  it("returns empty results for an empty path list", async () => {
    const result = await resolveDroppedImageAttachments([], async () => ({ dataUrl: "" }));

    expect(result.accepted).toEqual([]);
    expect(result.failedCount).toBe(0);
  });
});
