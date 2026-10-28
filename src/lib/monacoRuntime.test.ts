import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { getMonacoLanguage } from "./monaco";
import { TEXTMATE_LANGUAGES } from "./textmate";

vi.mock("./monacoRuntime", () => ({}));

it("provides a tokenizer for every file type recognized by the application", () => {
  const runtime = readFileSync(new URL("./monacoRuntime.ts", import.meta.url), "utf8");
  const languages = new Set([...Object.keys(TEXTMATE_LANGUAGES), "plaintext", "json", "c"]);
  for (const match of runtime.matchAll(/basic-languages\/([^/]+)\//g)) languages.add(match[1]);
  const mapping = readFileSync(new URL("./monaco.ts", import.meta.url), "utf8");
  const extensions = [...mapping.matchAll(/^\s+(\w+): "[\w]+",/gm)].map((match) => match[1]);
  for (const extension of extensions) expect(languages.has(getMonacoLanguage(`file.${extension}`)), extension).toBe(true);
  for (const file of ["Dockerfile", "Makefile", ".gitignore"]) expect(languages.has(getMonacoLanguage(file)), file).toBe(true);
});

it("keeps editor interactions and language services without importing the full language entry", () => {
  const runtime = readFileSync(new URL("./monacoRuntime.ts", import.meta.url), "utf8");
  expect(runtime).toContain("editor/editor.all.js");
  for (const language of ["typescript", "json", "html", "css"]) {
    expect(runtime).toContain(`language/${language}/monaco.contribution.js`);
  }
  expect(runtime).not.toContain("editor.main");
  expect(runtime).not.toMatch(/from ["']monaco-editor["']/);
});
