import { describe, expect, it } from "vitest";
import {
  applyUpdaterDownloadEvent,
  createUpdateProgress,
  formatUpdateBytes,
} from "./updateProgress";

describe("application update progress", () => {
  it("tracks downloaded bytes and calculates a bounded percentage", () => {
    const started = applyUpdaterDownloadEvent(createUpdateProgress(), {
      event: "Started",
      data: { contentLength: 1_000 },
    });
    const halfway = applyUpdaterDownloadEvent(started, {
      event: "Progress",
      data: { chunkLength: 500 },
    });
    const overrun = applyUpdaterDownloadEvent(halfway, {
      event: "Progress",
      data: { chunkLength: 800 },
    });

    expect(halfway).toMatchObject({ downloadedBytes: 500, totalBytes: 1_000, percent: 50 });
    expect(overrun.percent).toBe(100);
  });

  it("keeps byte progress when the server does not provide a content length", () => {
    const started = applyUpdaterDownloadEvent(createUpdateProgress(), {
      event: "Started",
      data: {},
    });
    const progressed = applyUpdaterDownloadEvent(started, {
      event: "Progress",
      data: { chunkLength: 2_048 },
    });

    expect(progressed).toMatchObject({ downloadedBytes: 2_048, totalBytes: null, percent: null });
  });

  it("switches to installing only after the download finishes", () => {
    const finished = applyUpdaterDownloadEvent(
      { phase: "downloading", downloadedBytes: 750, totalBytes: 1_000, percent: 75 },
      { event: "Finished" },
    );

    expect(finished).toEqual({
      phase: "installing",
      downloadedBytes: 1_000,
      totalBytes: 1_000,
      percent: 100,
    });
  });

  it("formats byte counts for progress details", () => {
    expect(formatUpdateBytes(512, "en-US")).toBe("512 B");
    expect(formatUpdateBytes(1_572_864, "en-US")).toBe("1.5 MB");
  });
});
