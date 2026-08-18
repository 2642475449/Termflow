import { describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import {
  FilePathLinkProvider,
  detectTerminalFilePaths,
  parseTerminalFilePath,
  resolveTerminalFilePath,
} from "./FilePathLinkProvider";

describe("terminal file path links", () => {
  it("detects common file path formats", () => {
    const cases = [
      "src/components/Terminal.tsx:361:10",
      String.raw`D:\workspace\demo\src\main.rs:42`,
      "/workspace/demo/app.py:8",
      "package.json",
      "docs/guide.pdf:12",
      String.raw`D:\3.project\Termflow\src\locales`,
      "src/components/",
    ];
    expect(cases.map((line) => detectTerminalFilePaths(line)[0]?.filePath)).toEqual([
      "src/components/Terminal.tsx",
      String.raw`D:\workspace\demo\src\main.rs`,
      "/workspace/demo/app.py",
      "package.json",
      "docs/guide.pdf",
      String.raw`D:\3.project\Termflow\src\locales`,
      "src/components/",
    ]);
  });

  it("extracts optional line and column numbers", () => {
    expect(parseTerminalFilePath("src/main.ts:12:7")).toEqual({
      filePath: "src/main.ts", line: 12, column: 7,
    });
    expect(parseTerminalFilePath("src/main.ts:12")).toEqual({
      filePath: "src/main.ts", line: 12,
    });
  });

  it("does not turn URL path suffixes into file links", () => {
    expect(detectTerminalFilePaths("https://example.com/src/main.ts")).toEqual([]);
  });

  it("does not treat slash-separated Chinese prose as an absolute directory", () => {
    expect(detectTerminalFilePaths(
      "已缴费用户再次选课时应复用/更新原记录，而不是无条件新增；前端按钮在提交后应置灰防连点。",
    )).toEqual([]);
  });

  it("detects Chinese file paths without excluding their characters", () => {
    expect(detectTerminalFilePaths("资料/更新记录.md:8")).toEqual([
      expect.objectContaining({
        text: "资料/更新记录.md:8",
        filePath: "资料/更新记录.md",
        line: 8,
      }),
    ]);
  });

  it("detects a Windows directory inside terminal table output", () => {
    const line = String.raw`│ D:\3.project\Termflow\src\locales │ 国际化资源目录 │`;
    expect(detectTerminalFilePaths(line)).toEqual([
      expect.objectContaining({
        text: String.raw`D:\3.project\Termflow\src\locales`,
        filePath: String.raw`D:\3.project\Termflow\src\locales`,
      }),
    ]);
  });

  it("resolves relative paths against the terminal working directory", () => {
    expect(resolveTerminalFilePath("./src/../package.json", String.raw`D:\workspace\demo`))
      .toBe(String.raw`D:\workspace\demo\package.json`);
    expect(resolveTerminalFilePath("../lib/main.ts", "/workspace/demo/app"))
      .toBe("/workspace/demo/lib/main.ts");
  });

  it("maps xterm's 1-based link row to the 0-based buffer row", () => {
    let requestedLine = -1;
    const terminal = {
      cols: 80,
      buffer: {
        active: {
          length: 1,
          getLine(index: number) {
            requestedLine = index;
            return { isWrapped: false, translateToString: () => "src/Terminal.tsx" };
          },
        },
      },
    } as unknown as Terminal;
    const provider = new FilePathLinkProvider(terminal, () => undefined);
    let providedLinks: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];

    provider.provideLinks(7, (links) => {
      providedLinks = links;
    });

    expect(requestedLine).toBe(6);
    expect(providedLinks?.[0]?.range).toEqual({
      start: { x: 1, y: 7 },
      end: { x: 16, y: 7 },
    });
    expect(providedLinks?.[0]?.decorations).toEqual({
      pointerCursor: true,
      underline: true,
    });
  });

  it("maps string indices to terminal columns after wide Chinese characters", () => {
    const text = String.raw`模块 路径 src/components/Terminal.tsx`;
    const cells = [
      { chars: "模", width: 2 },
      { chars: "", width: 0 },
      { chars: "块", width: 2 },
      { chars: "", width: 0 },
      { chars: " ", width: 1 },
      { chars: "路", width: 2 },
      { chars: "", width: 0 },
      { chars: "径", width: 2 },
      { chars: "", width: 0 },
      ...Array.from(" src/components/Terminal.tsx", (chars) => ({ chars, width: 1 })),
    ];
    const terminal = {
      cols: cells.length,
      buffer: {
        active: {
          length: 1,
          getLine() {
            return {
              isWrapped: false,
              translateToString: () => text,
              getCell(index: number) {
                const cell = cells[index];
                return cell
                  ? { getChars: () => cell.chars, getWidth: () => cell.width }
                  : undefined;
              },
            };
          },
        },
      },
    } as unknown as Terminal;
    const provider = new FilePathLinkProvider(terminal, () => undefined);
    let providedLinks: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];

    provider.provideLinks(1, (links) => {
      providedLinks = links;
    });

    expect(providedLinks?.[0]?.range).toEqual({
      start: { x: 11, y: 1 },
      end: { x: 37, y: 1 },
    });
  });

  it("only activates file path links on left click", () => {
    const terminal = {
      cols: 80,
      buffer: {
        active: {
          length: 1,
          getLine() {
            return { isWrapped: false, translateToString: () => "src/Terminal.tsx" };
          },
        },
      },
    } as unknown as Terminal;
    const activated: string[] = [];
    const provider = new FilePathLinkProvider(terminal, (path) => {
      activated.push(path.filePath);
    });
    let providedLinks: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];

    provider.provideLinks(1, (links) => {
      providedLinks = links;
    });

    const link = providedLinks?.[0];
    expect(link).toBeDefined();

    link?.activate({ button: 0, ctrlKey: false } as MouseEvent, link.text);
    link?.activate({ button: 1, ctrlKey: true } as MouseEvent, link.text);
    expect(activated).toEqual(["src/Terminal.tsx"]);
  });

  it("deduplicates concurrent left clicks for the same link", async () => {
    const terminal = {
      cols: 80,
      buffer: {
        active: {
          length: 1,
          getLine() {
            return { isWrapped: false, translateToString: () => "src/Terminal.tsx" };
          },
        },
      },
    } as unknown as Terminal;
    let activationCount = 0;
    let finishActivation: (() => void) | undefined;
    const pendingActivation = new Promise<void>((resolve) => {
      finishActivation = resolve;
    });
    const provider = new FilePathLinkProvider(terminal, async () => {
      activationCount += 1;
      await pendingActivation;
    });
    let providedLinks: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];

    provider.provideLinks(1, (links) => {
      providedLinks = links;
    });
    const link = providedLinks?.[0];
    expect(link).toBeDefined();

    link?.activate({ button: 0, ctrlKey: false } as MouseEvent, link.text);
    link?.activate({ button: 0, ctrlKey: false } as MouseEvent, link.text);
    expect(activationCount).toBe(1);

    finishActivation?.();
    await pendingActivation;
    await Promise.resolve();
    link?.activate({ button: 0, ctrlKey: false } as MouseEvent, link.text);
    expect(activationCount).toBe(2);
  });

  it("only exposes file links that pass asynchronous existence validation", async () => {
    const terminal = {
      cols: 80,
      buffer: {
        active: {
          length: 1,
          getLine() {
            return {
              isWrapped: false,
              translateToString: () => "src/Terminal.tsx missing.ts",
            };
          },
        },
      },
    } as unknown as Terminal;
    const provider = new FilePathLinkProvider(
      terminal,
      () => undefined,
      async (path) => path.filePath === "src/Terminal.tsx",
    );

    const links = await new Promise<Parameters<Parameters<typeof provider.provideLinks>[1]>[0]>((resolve) => {
      provider.provideLinks(1, resolve);
    });

    expect(links).toHaveLength(1);
    expect(links?.[0]?.text).toBe("src/Terminal.tsx");
  });

  it("reassembles a file path split across soft-wrapped rows", () => {
    const rows = [
      { isWrapped: false, text: String.raw`Finished 1 bundle at: D:\3.project\Termflow\src-tauri\target\release\bundle\nsis\Termf` },
      { isWrapped: true, text: "low_1.8.8_x64-setup.exe" },
    ];
    const terminal = {
      cols: rows[0].text.length,
      buffer: {
        active: {
          length: rows.length,
          getLine(index: number) {
            const row = rows[index];
            return row
              ? { isWrapped: row.isWrapped, translateToString: () => row.text }
              : undefined;
          },
        },
      },
    } as unknown as Terminal;
    const activated: string[] = [];
    const provider = new FilePathLinkProvider(terminal, (path) => activated.push(path.filePath));
    let firstRowLinks: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];
    let secondRowLinks: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];

    provider.provideLinks(1, (links) => {
      firstRowLinks = links;
    });
    provider.provideLinks(2, (links) => {
      secondRowLinks = links;
    });

    const expectedPath = String.raw`D:\3.project\Termflow\src-tauri\target\release\bundle\nsis\Termflow_1.8.8_x64-setup.exe`;
    expect(firstRowLinks?.[0]?.text).toBe(expectedPath);
    expect(secondRowLinks?.[0]?.text).toBe(expectedPath);
    expect(firstRowLinks?.[0]?.range).toEqual({
      start: { x: rows[0].text.indexOf("D:\\") + 1, y: 1 },
      end: { x: rows[1].text.length, y: 2 },
    });

    secondRowLinks?.[0]?.activate(
      { button: 0, ctrlKey: false } as MouseEvent,
      secondRowLinks[0].text,
    );
    expect(activated).toEqual([expectedPath]);
  });
});
