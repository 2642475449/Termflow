import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import {
  FilePathLinkProvider,
  detectTerminalFilePaths,
  parseTerminalFilePath,
  resolveTerminalFilePath,
} from "./FilePathLinkProvider";

type ProvidedLinks = Parameters<Parameters<FilePathLinkProvider["provideLinks"]>[1]>[0];

async function writeRealTerminal(terminal: Terminal, text: string): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(text, resolve));
}

async function expectRealBufferFileLink(terminal: Terminal, expectedPath: string): Promise<void> {
  const validated: string[] = [];
  const provider = new FilePathLinkProvider(terminal, () => undefined, async (candidate) => {
    validated.push(candidate.filePath);
    return candidate.filePath === expectedPath;
  });
  const first = await new Promise<ProvidedLinks>((resolve) => provider.provideLinks(1, resolve));
  expect(first, JSON.stringify(validated)).toHaveLength(1);
  expect(first?.[0]?.text).toBe(expectedPath);
  for (let row = 2; row <= first![0].range.end.y; row += 1) {
    const links = await new Promise<ProvidedLinks>((resolve) => provider.provideLinks(row, resolve));
    expect(links?.map((link) => ({ text: link.text, range: link.range }))).toEqual([
      { text: expectedPath, range: first![0].range },
    ]);
  }
}

describe("terminal file path links", () => {
  it("reassembles real xterm soft wraps without inserting null padding before wide characters", async () => {
    const terminal = new Terminal({ cols: 10, rows: 15, allowProposedApi: true });
    try {
      const path = "C:/aaaaaa测/file.txt";
      await writeRealTerminal(terminal, path);
      expect(terminal.buffer.active.getLine(0)?.getCell(9)?.getChars()).toBe("");
      expect(terminal.buffer.active.getLine(0)?.getCell(9)?.getWidth()).toBe(1);
      expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(true);
      expect(terminal.buffer.active.getLine(1)?.getCell(0)?.getWidth()).toBe(2);
      await expectRealBufferFileLink(terminal, path);
    } finally {
      terminal.dispose();
    }
  });

  it("preserves real spaces beside wide-character wrap padding and at the last column", async () => {
    for (const path of ["C:/aaaaa 测/file.txt", "C:/aaaaaa 测/file.txt"]) {
      const terminal = new Terminal({ cols: 10, rows: 15, allowProposedApi: true });
      try {
        await writeRealTerminal(terminal, path);
        const firstLine = terminal.buffer.active.getLine(0);
        const realSpaceColumn = path.indexOf(" ");
        expect(firstLine?.getCell(realSpaceColumn)?.getChars()).toBe(" ");
        await expectRealBufferFileLink(terminal, path);
      } finally {
        terminal.dispose();
      }
    }
  });

  it("preserves full ASCII rows, wide characters fitting the last two columns, and emoji wraps", async () => {
    for (const path of ["C:/aaaaaa/long-file.custom", "C:/aaaaa测/file.txt", "C:/aaaaaa🧪/file.txt"]) {
      const terminal = new Terminal({ cols: 10, rows: 15, allowProposedApi: true });
      try {
        await writeRealTerminal(terminal, path);
        await expectRealBufferFileLink(terminal, path);
      } finally {
        terminal.dispose();
      }
    }
  });

  it("keeps long quoted CJK paths linked across every real buffer row and terminal resize", async () => {
    const terminal = new Terminal({ cols: 52, rows: 30, allowProposedApi: true });
    const path = `E:/project/${"目录/".repeat(40)}🧪测试.txt`;
    try {
      // xterm 默认不重排仍包含光标的逻辑行；输出完成后换行再验证历史行重排。
      await writeRealTerminal(terminal, `T19 "${path}"\r\n`);
      await expectRealBufferFileLink(terminal, path);
      for (const cols of [17, 10, 53]) {
        terminal.resize(cols, 30);
        await expectRealBufferFileLink(terminal, path);
      }
    } finally {
      terminal.dispose();
    }
  });

  it("keeps hard newlines separate even when a wide character starts the following row", async () => {
    const terminal = new Terminal({ cols: 10, rows: 15, allowProposedApi: true });
    try {
      await writeRealTerminal(terminal, "C:/aaaaaa\r\n测/file.txt");
      expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(false);
      const provider = new FilePathLinkProvider(terminal, () => undefined);
      const first = await new Promise<ProvidedLinks>((resolve) => provider.provideLinks(1, resolve));
      const second = await new Promise<ProvidedLinks>((resolve) => provider.provideLinks(2, resolve));
      expect(first?.map((link) => link.text)).toEqual(["C:/aaaaaa"]);
      expect(second?.map((link) => link.text)).toEqual(["测/file.txt"]);
    } finally {
      terminal.dispose();
    }
  });

  it("detects complete filenames for arbitrary extensions and compound suffixes", () => {
    const paths = [
      "xingmi_confession.mp3", "movie.MP4", "archive.7z", "backup.tar.gz",
      "notes.txt.bak", "src/lib/new.customext", "schema.json5", "项目/报告.自定义",
      "audio/xingmi_confession_en.mp3", ".gitignore", ".env.local",
      "/tmp/report(final).unknown", "report(final).custom", "src/path(with-parentheses)/README",
      "src/path(backup.json)/README", "/tmp/report(v1.2).custom",
    ];
    for (const path of paths) {
      expect(detectTerminalFilePaths(path)).toEqual([
        { filePath: path, text: path, startIndex: 0 },
      ]);
    }
  });

  it("detects extensionless files and directories with explicit path context", () => {
    const paths = ["./LICENSE", "../Makefile", "src/README", "src/components", "/tmp/README", "~/Downloads/song.mp3", "~/.config/tool/config"];
    for (const path of paths) {
      expect(detectTerminalFilePaths(path)).toEqual([
        { filePath: path, text: path, startIndex: 0 },
      ]);
    }
    expect(detectTerminalFilePaths('"README"')).toEqual([
      { filePath: "README", text: "README", startIndex: 1 },
    ]);
    expect(detectTerminalFilePaths("[配置](资料/配置)")).toEqual([
      { filePath: "资料/配置", text: "资料/配置", startIndex: 5 },
    ]);
    expect(detectTerminalFilePaths("README is ready; version 1.8.35")).toEqual([]);
  });

  it("preserves unknown extensions in quoted and spaced absolute filenames", () => {
    const path = String.raw`D:\folder with spaces\音频 (final).customformat`;
    expect(detectTerminalFilePaths(`生成 ${path} 完成`)).toEqual([
      { filePath: path, text: path, startIndex: 3 },
    ]);
    expect(detectTerminalFilePaths('"folder with spaces/README"')).toEqual([
      { filePath: "folder with spaces/README", text: "folder with spaces/README", startIndex: 1 },
    ]);
  });

  it("keeps line and column suffixes after complete filenames and excludes sentence punctuation", () => {
    expect(detectTerminalFilePaths("See src/custom.generated:12:7.")).toEqual([
      { filePath: "src/custom.generated", text: "src/custom.generated:12:7", startIndex: 4, line: 12, column: 7 },
    ]);
  });

  it("excludes unquoted sentence and table boundaries from complete absolute filenames", () => {
    const paths = [String.raw`C:\example.txt`, String.raw`C:\folder with spaces\example.custom`, String.raw`C:\7.project\folder with spaces\archive.tar.gz`, String.raw`\\server\share\example.txt`];
    const endings = ["; open next", ", open next", ": open next", ". open next", "! open next", '") next', "` next", "] next", ".) next", "|next", "│next", "║next"];
    for (const path of paths) {
      for (const ending of endings) {
        expect(detectTerminalFilePaths(`${path}${ending}`), `${path}${ending}`).toEqual([
          { filePath: path, text: path, startIndex: 0 },
        ]);
      }
      expect(detectTerminalFilePaths(`[${path}]`)).toEqual([
        { filePath: path, text: path, startIndex: 1 },
      ]);
    }
  });

  it("preserves punctuation belonging to an explicitly quoted filename", () => {
    const paths = [String.raw`C:\folder with spaces\example.txt;`, String.raw`C:\folder\first;second.custom`, String.raw`C:\folder\one,two.txt`];
    for (const path of paths) {
      for (const quote of ['"', "'", "`"]) {
        expect(detectTerminalFilePaths(`${quote}${path}${quote}`)).toEqual([
          { filePath: path, text: path, startIndex: 1 },
        ]);
      }
    }
  });

  it("decodes raw file URLs while preserving their displayed text and offsets", () => {
    const uri = "file:///C:/audio%20folder/%E6%B5%8B%E8%AF%95.mp3";
    expect(detectTerminalFilePaths(`打开 ${uri}。`)).toEqual([
      { filePath: "C:/audio folder/测试.mp3", text: uri, startIndex: 3 },
    ]);
    expect(detectTerminalFilePaths("[音频](file:///C:/audio/song(1).mp3)")).toEqual([
      { filePath: "C:/audio/song(1).mp3", text: "file:///C:/audio/song(1).mp3", startIndex: 5 },
    ]);
  });

  it("does not expose local path fragments inside other or invalid file URLs", () => {
    for (const uri of [
      "https://example.com/src/custom.extension", "ftp://server/src/README",
      "file:///C:/bad%ZZ.txt", "file:///C:/report.pdf?download=1",
    ]) {
      expect(detectTerminalFilePaths(`查看 ${uri}`)).toEqual([]);
    }
  });

  it("detects a Markdown target with spaces and nested filename parentheses", () => {
    const path = "folder with spaces/report (final).pdf";
    const text = `[示例](${path})`;
    expect(detectTerminalFilePaths(text)).toEqual([
      expect.objectContaining({ filePath: path, text: path, startIndex: 5 }),
    ]);
  });

  it("passes the complete quoted path to validation and maps only its content", async () => {
    const path = String.raw`E:\7.project\shengzhi\folder with spaces\report (final).pdf`;
    const terminal = {
      cols: 100,
      buffer: {
        active: {
          length: 1,
          getLine: () => ({ isWrapped: false, translateToString: () => `"${path}"` }),
        },
      },
    } as unknown as Terminal;
    const validated: string[] = [];
    const provider = new FilePathLinkProvider(terminal, () => undefined, async (candidate) => {
      validated.push(candidate.filePath);
      return candidate.filePath === path;
    });
    const links = await new Promise<Parameters<Parameters<typeof provider.provideLinks>[1]>[0]>((resolve) => {
      provider.provideLinks(1, resolve);
    });
    expect(validated).toEqual([path]);
    expect(links).toHaveLength(1);
    expect(links?.[0]?.range).toEqual({ start: { x: 2, y: 1 }, end: { x: path.length + 1, y: 1 } });
  });

  it("preserves quoted paths with Chinese, spaces and parentheses", () => {
    const paths = [
      String.raw`E:\7.project\shengzhi\中文目录\测试文件.txt`,
      String.raw`E:\7.project\shengzhi\folder with spaces\report (final).pdf`,
      String.raw`C:\Users\26424\Documents\测试报告（最终版）.docx`,
      "folder with spaces/report (final).pdf",
    ];
    for (const path of paths) {
      for (const quote of ['"', "'", "`"]) {
        const line = `文件 ${quote}${path}${quote} 后面文字`;
        expect(detectTerminalFilePaths(line)).toEqual([
          expect.objectContaining({ filePath: path, text: path, startIndex: 4 }),
        ]);
      }
    }
  });

  it("detects complete unquoted Windows and UNC files containing spaces", () => {
    const paths = [
      String.raw`E:\7.project\shengzhi\folder with spaces\report (final).pdf`,
      String.raw`\\localhost\share\中文目录\test file.txt`,
      String.raw`C:\Users\26424\Documents\测试报告（最终版）.docx`,
    ];
    for (const path of paths) {
      expect(detectTerminalFilePaths(path)).toEqual([
        expect.objectContaining({ filePath: path, text: path, startIndex: 0 }),
      ]);
    }
  });

  it("does not expose suffixes inside quoted URLs as file paths", () => {
    expect(detectTerminalFilePaths('"https://example.com/folder with spaces/report.pdf"')).toEqual([]);
  });

  it("detects common file path formats", () => {
    const cases = [
      "src/components/Terminal.tsx:361:10",
      String.raw`D:\workspace\demo\src\main.rs:42`,
      "/workspace/demo/app.py:8",
      "package.json",
      "docs/guide.pdf:12",
      "assets/screenshot.webp",
      String.raw`D:\3.project\Termflow\src\locales`,
      "src/components/",
    ];
    expect(cases.map((line) => detectTerminalFilePaths(line)[0]?.filePath)).toEqual([
      "src/components/Terminal.tsx",
      String.raw`D:\workspace\demo\src\main.rs`,
      "/workspace/demo/app.py",
      "package.json",
      "docs/guide.pdf",
      "assets/screenshot.webp",
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

  it("includes the complete final wide glyph and handles surrogate pairs in link ranges", () => {
    const text = "🧪 ./资料/报告.文档";
    const cells: Array<{ chars: string; width: number }> = [];
    for (const chars of text) {
      const width = chars === "🧪" || /[\u4e00-\u9fff]/.test(chars) ? 2 : 1;
      cells.push({ chars, width });
      if (width === 2) cells.push({ chars: "", width: 0 });
    }
    const terminal = {
      cols: cells.length,
      buffer: { active: { length: 1, getLine: () => ({
        isWrapped: false,
        translateToString: () => text,
        getCell: (index: number) => {
          const cell = cells[index];
          return cell ? { getChars: () => cell.chars, getWidth: () => cell.width } : undefined;
        },
      }) } },
    } as unknown as Terminal;
    const provider = new FilePathLinkProvider(terminal, () => undefined);
    let providedLinks: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];
    provider.provideLinks(1, (links) => { providedLinks = links; });
    expect(providedLinks?.[0]?.text).toBe("./资料/报告.文档");
    expect(providedLinks?.[0]?.range).toEqual({
      start: { x: 4, y: 1 }, end: { x: cells.length, y: 1 },
    });
  });

  it("preserves text selections and Alt mouse events instead of opening their links", () => {
    const activated: string[] = [];
    let selected = true;
    const terminal = {
      cols: 80, hasSelection: () => selected,
      buffer: { active: { length: 1, getLine: () => ({ isWrapped: false, translateToString: () => "song.mp3" }) } },
    } as unknown as Terminal;
    const provider = new FilePathLinkProvider(terminal, (path) => { activated.push(path.filePath); });
    let providedLinks: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];
    provider.provideLinks(1, (links) => { providedLinks = links; });
    const link = providedLinks?.[0];
    expect(link).toBeDefined();
    link?.activate({ button: 0, ctrlKey: false } as MouseEvent, link.text);
    expect(activated).toEqual([]);
    selected = false;
    link?.activate({ button: 0, altKey: true } as MouseEvent, link.text);
    expect(activated).toEqual([]);
    link?.activate({ button: 0, altKey: false } as MouseEvent, link.text);
    expect(activated).toEqual(["song.mp3"]);
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
    const activated: Array<{ path: string; openDirectly: boolean }> = [];
    const provider = new FilePathLinkProvider(terminal, (path, openDirectly) => {
      activated.push({ path: path.filePath, openDirectly });
    });
    let providedLinks: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];

    provider.provideLinks(1, (links) => {
      providedLinks = links;
    });

    const link = providedLinks?.[0];
    expect(link).toBeDefined();

    link?.activate({ button: 0, ctrlKey: false } as MouseEvent, link.text);
    link?.activate({ button: 1, ctrlKey: true } as MouseEvent, link.text);
    expect(activated).toEqual([{ path: "src/Terminal.tsx", openDirectly: false }]);
  });

  it("marks Ctrl or Cmd left clicks for direct opening", async () => {
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
    const directOpenRequests: boolean[] = [];
    const provider = new FilePathLinkProvider(terminal, (_path, openDirectly) => {
      directOpenRequests.push(openDirectly);
    });
    let providedLinks: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];

    provider.provideLinks(1, (links) => {
      providedLinks = links;
    });

    const link = providedLinks?.[0];
    expect(link).toBeDefined();
    link?.activate({ button: 0, ctrlKey: true, metaKey: false } as MouseEvent, link.text);
    await Promise.resolve();
    link?.activate({ button: 0, ctrlKey: false, metaKey: true } as MouseEvent, link.text);
    expect(directOpenRequests).toEqual([true, true]);
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
