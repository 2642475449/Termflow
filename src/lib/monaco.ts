import * as monaco from "monaco-editor";

export function getMonacoLanguage(filePath: string): string {
  const normalizedPath = filePath.replace(/[\\/]+$/, "");
  const fileName = normalizedPath.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() ?? "";
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";

  const directFileMap: Record<string, string> = {
    ".gitignore": "shell",
    "dockerfile": "dockerfile",
    "makefile": "makefile",
  };

  if (directFileMap[fileName]) {
    return directFileMap[fileName];
  }

  const extensionMap: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    md: "markdown",
    rs: "rust",
    py: "python",
    go: "go",
    java: "java",
    vue: "vue",
    c: "c",
    h: "cpp",
    cpp: "cpp",
    hpp: "cpp",
    css: "css",
    scss: "scss",
    less: "less",
    html: "html",
    htm: "html",
    xml: "xml",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    ps1: "powershell",
    bat: "bat",
    sql: "sql",
    txt: "plaintext",
    log: "plaintext",
    env: "shell",
    ini: "ini",
    conf: "ini",
    cfg: "ini",
    lock: "plaintext",
    csv: "plaintext",
  };

  return extensionMap[extension] ?? "plaintext";
}

export function getMonacoThemeName(isDark: boolean): string {
  if (typeof document === "undefined") return isDark ? "vs-dark" : "vs";
  const styles = getComputedStyle(document.documentElement);
  const color = (key: string) => styles.getPropertyValue(`--cs-code-${key}`).trim().replace(/^#/, "");
  const surfaceColor = (key: string, alpha = "") => {
    const value = styles.getPropertyValue(`--cs-${key}`).trim();
    return /^#[\da-f]{6}$/i.test(value) ? value + alpha : value;
  };
  const name = isDark ? "termflow-dark" : "termflow-light";
  monaco.editor.defineTheme(name, {
    base: isDark ? "vs-dark" : "vs", inherit: true,
    rules: [
      ...["keyword", "string", "number", "type", "function", "annotation"].map((token) => ({ token, foreground: color(token) })),
      { token: "comment", foreground: color("comment"), fontStyle: "" },
      { token: "constant", foreground: color("number") },
      { token: "property", foreground: color("annotation") },
      { token: "type.identifier", foreground: color("type") },
      { token: "tag", foreground: color("keyword") },
      { token: "attribute.name", foreground: color("annotation") },
    ],
    colors: Object.fromEntries(Object.entries({
      "editor.background": surfaceColor("bg-card-solid"),
      "editor.foreground": surfaceColor("text-primary"),
      "editorLineNumber.foreground": surfaceColor("text-tertiary"),
      "editorLineNumber.activeForeground": surfaceColor("primary"),
      "editorCursor.foreground": surfaceColor("primary"),
      "editorIndentGuide.background1": surfaceColor("border", "80"),
      "editorIndentGuide.activeBackground1": surfaceColor("primary", "66"),
      "editor.lineHighlightBackground": surfaceColor("primary", "06"),
      "editor.lineHighlightBorder": surfaceColor("primary", "00"),
      "editor.selectionBackground": surfaceColor("primary", "30"),
      "editor.inactiveSelectionBackground": surfaceColor("primary", "18"),
      "editor.selectionHighlightBackground": surfaceColor("primary", "18"),
      "editor.wordHighlightBackground": surfaceColor("primary", "18"),
      "editor.wordHighlightStrongBackground": surfaceColor("primary", "25"),
      "editor.wordHighlightTextBackground": surfaceColor("primary", "18"),
    }).filter(([, value]) => value)),
  });
  return name;
}

/** 等应用实际更新 CSS 主题后再同步 Monaco，涵盖同为亮色/深色的主题切换。 */
export function observeMonacoTheme(isDark: boolean): monaco.IDisposable {
  if (typeof document === "undefined") return { dispose() {} };
  const refresh = () => monaco.editor.setTheme(getMonacoThemeName(isDark));
  const observer = new MutationObserver(refresh);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  refresh();
  return { dispose: () => observer.disconnect() };
}

/**
 * Monaco 没有稳定的公共 API 用来移除内置命令面板 action，
 * 因此以实例级空操作覆盖默认 F1 快捷键。
 */
export function disableMonacoCommandPalette(
  editor: monaco.editor.IStandaloneCodeEditor,
  monacoApi: typeof monaco,
) {
  editor.addCommand(monacoApi.KeyCode.F1, () => {});
}

export function getMonacoTypography(fontSize: number) {
  return {
    fontFamily:
      "'Geist Mono', 'Cascadia Mono', 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
    fontSize,
    fontWeight: "400",
    lineHeight: Math.round(fontSize * 1.55),
    // Geist Mono's programming ligatures can be rasterized as long horizontal
    // strokes by WebView2 at fractional display scales (for example !==/===).
    // Keep the source operators as individual glyphs for stable rendering.
    fontLigatures: false,
  };
}

let richTokensRegistered = false;
export function registerRichCodeTokens() {
  if (richTokensRegistered) return;
  richTokensRegistered = true;
  void import("./textmate").then(({ installTextmate }) => installTextmate(monaco))
    .catch((error: unknown) => { console.error("TextMate initialization failed", error); });
}
