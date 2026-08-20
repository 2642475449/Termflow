import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendContentOverviewOutput,
  beginContentOverviewTurn,
  cleanTerminalOverviewText,
  extractContentOverview,
  generateContentOverview,
  getContentOverviewSnapshot,
  navigateToContentOverviewSection,
  registerContentOverviewNavigator,
  registerContentOverviewOutputSource,
} from "./contentOverview";

describe("contentOverview", () => {
  beforeEach(() => {
    beginContentOverviewTurn("test-session");
  });

  it("cleans ANSI sequences, overwritten status lines, and spinner noise", () => {
    const result = cleanTerminalOverviewText(
      "\u001b[32mHeading\u001b[0m\rUpdated heading\n⠋\nThinking...\nUseful content",
    );

    expect(result).toBe("Updated heading\nUseful content");
  });

  it("extracts headings and concise bullet points", () => {
    const result = extractContentOverview(`
# Architecture
The application keeps each session isolated and uses a bounded output buffer.
- Output is normalized locally before extraction.
- Navigation resolves the closest matching terminal row.
## Validation
Tests cover cleaning, extraction, and navigation behavior.
Deployment notes
The packaged application should be restarted before testing WebView interactions.
    `);

    expect(result.summary).toContain("bounded output buffer");
    expect(result.keyPoints).toEqual([
      "Output is normalized locally before extraction.",
      "Navigation resolves the closest matching terminal row.",
    ]);
    expect(result.sections.map((section) => section.title)).toEqual([
      "Architecture",
      "Validation",
      "Deployment notes",
    ]);
  });

  it("only generates after the current turn reaches the length threshold", () => {
    appendContentOverviewOutput("test-session", "short response");
    expect(getContentOverviewSnapshot("test-session").canGenerate).toBe(false);
    expect(generateContentOverview("test-session")).toBeNull();

    beginContentOverviewTurn("test-session");
    appendContentOverviewOutput("test-session", `# Result\n${"Long enough sentence. ".repeat(100)}`);
    expect(getContentOverviewSnapshot("test-session").canGenerate).toBe(true);
    expect(generateContentOverview("test-session")?.sections[0]?.title).toBe("Result");
  });

  it("routes section navigation to the registered terminal", () => {
    const navigate = vi.fn(() => true);
    const unregister = registerContentOverviewNavigator("test-session", navigate);

    expect(navigateToContentOverviewSection("test-session", "Architecture")).toBe(true);
    expect(navigate).toHaveBeenCalledWith("Architecture");

    unregister();
    expect(navigateToContentOverviewSection("test-session", "Architecture")).toBe(false);
  });

  it("captures shared session output once and hands ownership to the next pane", () => {
    const firstPane = registerContentOverviewOutputSource("test-session");
    const secondPane = registerContentOverviewOutputSource("test-session");
    const belowThreshold = "word ".repeat(190);

    firstPane.append(belowThreshold);
    secondPane.append(belowThreshold);
    expect(getContentOverviewSnapshot("test-session").canGenerate).toBe(false);

    firstPane.dispose();
    secondPane.append(belowThreshold);
    expect(getContentOverviewSnapshot("test-session").canGenerate).toBe(true);
    secondPane.dispose();
  });
});
