import { describe, expect, it } from "vitest";
import {
  consumeTerminalTitleInput,
  looksLikeInvalidAutoTitle,
  sanitizeSessionTitle,
  stripSessionTitlePrefix,
} from "./terminalTitle";

describe("terminalTitle", () => {
  it("strips common spoken prefixes", () => {
    expect(stripSessionTitlePrefix("请帮我修复登录问题")).toBe("修复登录问题");
    expect(stripSessionTitlePrefix("会话标题: 修复登录问题")).toBe("修复登录问题");
  });

  it("sanitizes fallback titles from first prompt", () => {
    expect(sanitizeSessionTitle("帮我看看我的系统有什么 bug")).toBe("看看我的系统有什么 bug");
    expect(sanitizeSessionTitle("第一行\n第二行")).toBe("第一行");
  });

  it("sanitizes ai result titles and keeps only the first line", () => {
    expect(sanitizeSessionTitle("Title: Login Feature", true)).toBe("Login Feature");
    expect(sanitizeSessionTitle("第一行标题\n第二行解释", true)).toBe("第一行标题");
  });

  it("rejects title-generation meta text", () => {
    expect(sanitizeSessionTitle("会话标题 会话标题生成请求", true)).toBeNull();
    expect(sanitizeSessionTitle("Session Title title generation request", true)).toBeNull();
  });

  it("rejects noisy repeated single-character titles", () => {
    expect(sanitizeSessionTitle("o o o o o")).toBeNull();
    expect(looksLikeInvalidAutoTitle("o o o o o")).toBe(true);
  });

  it("keeps normal titles", () => {
    expect(looksLikeInvalidAutoTitle("看看系统里有什么 bug")).toBe(false);
    expect(sanitizeSessionTitle("看看系统里有什么 bug")).toBe("看看系统里有什么 bug");
  });

  it("removes CSI ANSI escape sequences", () => {
    expect(sanitizeSessionTitle("\x1b[31m红色文字\x1b[0m标题")).toBe("红色文字 标题");
  });

  it("removes SS3 ANSI escape sequences", () => {
    expect(sanitizeSessionTitle("\x1bOO测试标题")).toBe("测试标题");
  });

  it("removes mixed ANSI sequences", () => {
    expect(sanitizeSessionTitle("\x1b[1m\x1bO粗体\x1b[0m标题")).toBe("粗体 标题");
  });

  it("ignores VT cursor key sequences while capturing terminal input", () => {
    expect(consumeTerminalTitleInput("", "\x1bOI排查会话标题")).toEqual({
      nextValue: "排查会话标题",
      pendingSequence: "",
      shouldCommit: false,
    });
    expect(consumeTerminalTitleInput("", "\x1b[A修复标签异常")).toEqual({
      nextValue: "修复标签异常",
      pendingSequence: "",
      shouldCommit: false,
    });
  });

  it("buffers incomplete escape sequences across input chunks", () => {
    const firstChunk = consumeTerminalTitleInput("", "\x1bO");
    expect(firstChunk).toEqual({
      nextValue: "",
      pendingSequence: "\x1bO",
      shouldCommit: false,
    });

    expect(consumeTerminalTitleInput(firstChunk.nextValue, "I优雅修复", firstChunk.pendingSequence)).toEqual({
      nextValue: "优雅修复",
      pendingSequence: "",
      shouldCommit: false,
    });
  });

  it("keeps edits and detects submit while capturing terminal input", () => {
    expect(consumeTerminalTitleInput("登录错", "\b误\r")).toEqual({
      nextValue: "登录误",
      pendingSequence: "",
      shouldCommit: true,
    });
  });

  it("rejects pure resource addresses as agent session titles", () => {
    expect(sanitizeSessionTitle("C:\\Users\\26424\\AppData\\Local\\Temp\\screenshot.png")).toBeNull();
    expect(sanitizeSessionTitle('"C:\\Users\\Some User\\My Project\\src\\App.tsx"')).toBeNull();
    expect(sanitizeSessionTitle("https://github.com/example/Termflow")).toBeNull();
    expect(sanitizeSessionTitle("/var/log/syslog")).toBeNull();
    expect(sanitizeSessionTitle("\\\\server\\share\\report.pdf")).toBeNull();
    expect(sanitizeSessionTitle("./scripts/build.sh")).toBeNull();
  });

  it("keeps task semantics around paths and urls", () => {
    expect(sanitizeSessionTitle("修复 src/components/Terminal.tsx 的粘贴问题")).toBe(
      "修复 Terminal.tsx 的粘贴问题"
    );
    expect(sanitizeSessionTitle("检查 https://github.com/example/Termflow 的构建配置")).toBe(
      "检查 Termflow 的构建配置"
    );
    expect(sanitizeSessionTitle('看看 "C:\\Users\\Some User\\proj\\App.tsx" 的问题')).toBe(
      "看看 App.tsx 的问题"
    );
  });

  it("keeps command tasks and drops standalone flags", () => {
    expect(sanitizeSessionTitle("git rebase 冲突怎么解决")).toBe("git rebase 冲突怎么解决");
    expect(sanitizeSessionTitle("npm install --legacy-peer-deps 为什么失败")).toBe(
      "npm install 为什么失败"
    );
  });

  it("rejects pure code blocks but keeps surrounding description", () => {
    expect(sanitizeSessionTitle("```ts")).toBeNull();
    expect(sanitizeSessionTitle("修复这个 ```x=1``` 的问题")).toBe("修复这个 的问题");
  });

  it("truncates at natural boundaries without splitting unicode", () => {
    expect(sanitizeSessionTitle("repair terminal paste issue for windows session")).toBe(
      "repair terminal paste"
    );
    const long = "这是一段非常长的中文标题没有任何标点符号需要被截断处理";
    expect(sanitizeSessionTitle(long)).toBe(long.slice(0, 24));
  });

  it("keeps terminal session naming behavior for resource-only input", () => {
    const title = sanitizeSessionTitle("C:\\Users\\26424\\x.log", false, "terminal");
    expect(title).not.toBeNull();
    expect(title?.startsWith("C:")).toBe(true);
  });

  it("clears buffered title input on line-discard keys", () => {
    expect(consumeTerminalTitleInput("draft", "\x15\r")).toEqual({
      nextValue: "",
      pendingSequence: "",
      shouldCommit: true,
    });
    expect(consumeTerminalTitleInput("draft", "\x03\r")).toEqual({
      nextValue: "",
      pendingSequence: "",
      shouldCommit: true,
    });
  });

  it("still names session from later input after invalid first input", () => {
    const first = consumeTerminalTitleInput("", "C:\\tmp\\screenshot.png\r");
    expect(first.shouldCommit).toBe(true);
    expect(sanitizeSessionTitle(first.nextValue)).toBeNull();

    const second = consumeTerminalTitleInput("", "修复登录流程\r");
    expect(second.shouldCommit).toBe(true);
    expect(sanitizeSessionTitle(second.nextValue)).toBe("修复登录流程");
  });
});
