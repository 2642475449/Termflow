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
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    rs: "rust",
    py: "python",
    go: "go",
    java: "java",
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
    toml: "ini",
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
  return isDark ? "vs-dark" : "vs";
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
