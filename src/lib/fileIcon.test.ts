import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { getFileExtension, getFileIcon, getFileIconByName } from "./fileIcon";

function getSvg(fileName: string): string {
  const element = getFileIconByName(fileName).icon as ReactElement<{
    dangerouslySetInnerHTML: { __html: string };
  }>;
  return element.props.dangerouslySetInnerHTML.__html;
}

describe("fileIcon", () => {
  it("extracts ordinary extensions but not dotfiles", () => {
    expect(getFileExtension("component.TSX")).toBe("tsx");
    expect(getFileExtension(".gitignore")).toBe("");
    expect(getFileExtension("README")).toBe("");
  });

  it("uses Seti's exact file-name associations", () => {
    expect(getSvg("package.json")).not.toBe(getSvg("unknown-file"));
    expect(getSvg(".gitignore")).not.toBe(getSvg("unknown-file"));
  });

  it("uses distinct artwork for common languages", () => {
    expect(getSvg("index.ts")).not.toBe(getSvg("main.py"));
    expect(getSvg("main.py")).not.toBe(getSvg("main.rs"));
    expect(getSvg("index.html")).not.toBe(getSvg("styles.css"));
  });

  it("uses a dedicated JSP file logo", () => {
    const element = getFileIconByName("form.JSP").icon as ReactElement<{
      className: string;
      dangerouslySetInnerHTML: { __html: string };
    }>;
    expect(element.props.className).toContain("app-jsp-file-icon");
    expect(element.props.dangerouslySetInnerHTML.__html).toContain(">JSP</text>");
    expect(element.props.dangerouslySetInnerHTML.__html).not.toBe(getSvg("unknown-file"));
    expect(getFileIconByName("form.JSP").color).toBe("#c65353");
  });

  it("uses a clear markup-file glyph for XML instead of Seti's RSS-like artwork", () => {
    const element = getFileIconByName("report.XML").icon as ReactElement<{
      className: string;
      dangerouslySetInnerHTML: { __html: string };
    }>;
    expect(element.props.className).toContain("app-xml-file-icon");
    expect(element.props.dangerouslySetInnerHTML.__html).toContain("<svg");
    expect(element.props.dangerouslySetInnerHTML.__html).not.toBe(getSvg("feed.rss"));
    expect(getFileIconByName("report.XML").color).toBe("#c87532");
  });

  it("uses the compact vector M-down-arrow glyph for Markdown", () => {
    const element = getFileIconByName("NOTES.md").icon as ReactElement<{
      className: string;
      dangerouslySetInnerHTML: { __html: string };
    }>;
    expect(element.props.className).toContain("app-markdown-file-icon");
    expect(element.props.dangerouslySetInnerHTML.__html).toContain("<svg");
    expect(element.props.dangerouslySetInnerHTML.__html).not.toContain(">M<");
    expect(getFileIconByName("guide.mdx").color).toBe(getFileIconByName("NOTES.md").color);
    expect(getFileIconByName("manual.markdown").color).toBe(getFileIconByName("NOTES.md").color);
  });

  it("uses a dedicated PowerPoint logo for presentation files", () => {
    const element = getFileIconByName("proposal.PPTX").icon as ReactElement<{
      className: string;
      dangerouslySetInnerHTML: { __html: string };
    }>;
    expect(element.props.className).toContain("app-powerpoint-file-icon");
    expect(element.props.dangerouslySetInnerHTML.__html).toContain("<svg");
    expect(element.props.dangerouslySetInnerHTML.__html).not.toBe(getSvg("unknown-file"));
    expect(getFileIconByName("slides.ppt").color).toBe("#d24726");
    expect(getFileIconByName("show.ppsx").color).toBe("#d24726");
  });

  it("keeps folders visually consistent and changes the expanded glyph", () => {
    const src = getFileIcon("src", true);
    const nodeModules = getFileIcon("node_modules", true);
    const expanded = getFileIcon("src", true, true);
    expect(src.color).toBe(nodeModules.color);
    expect(src.icon).not.toEqual(expanded.icon);
  });

  it("returns a default Seti icon for unknown files", () => {
    expect(getSvg("unknown.one-extension")).toBe(getSvg("unknown.another-extension"));
  });
});
