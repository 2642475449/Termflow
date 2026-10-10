import { createHighlighterCore } from "@shikijs/core";
import { createOnigurumaEngine } from "@shikijs/engine-oniguruma";
import type * as Monaco from "monaco-editor";
import java from "@shikijs/langs/java";
import typescript from "@shikijs/langs/typescript";
import tsx from "@shikijs/langs/tsx";
import javascript from "@shikijs/langs/javascript";
import jsx from "@shikijs/langs/jsx";
import json from "@shikijs/langs/json";
import html from "@shikijs/langs/html";
import css from "@shikijs/langs/css";
import scss from "@shikijs/langs/scss";
import less from "@shikijs/langs/less";
import xml from "@shikijs/langs/xml";
import yaml from "@shikijs/langs/yaml";
import toml from "@shikijs/langs/toml";
import markdown from "@shikijs/langs/markdown";
import python from "@shikijs/langs/python";
import rust from "@shikijs/langs/rust";
import go from "@shikijs/langs/go";
import c from "@shikijs/langs/c";
import cpp from "@shikijs/langs/cpp";
import sql from "@shikijs/langs/sql";
import shellscript from "@shikijs/langs/shellscript";
import powershell from "@shikijs/langs/powershell";
import bat from "@shikijs/langs/bat";
import dockerfile from "@shikijs/langs/dockerfile";
import makefile from "@shikijs/langs/makefile";
import vue from "@shikijs/langs/vue";

// 语法和 WASM 均内置，仅延迟读取应用自身的资源。
export const TEXTMATE_LANGUAGES = {
  java: java,
  typescript: typescript,
  tsx: tsx,
  javascript: javascript,
  jsx: jsx,
  json: json,
  html: html,
  css: css,
  scss: scss,
  less: less,
  xml: xml,
  yaml: yaml,
  toml: toml,
  markdown: markdown,
  python: python,
  rust: rust,
  go: go,
  c: c,
  cpp: cpp,
  sql: sql,
  shell: shellscript,
  powershell: powershell,
  bat: bat,
  dockerfile: dockerfile,
  makefile: makefile,
  vue: vue,
};
export function createTextmateHighlighter() {
  return createHighlighterCore({
    themes: [],
    langs: Object.values(TEXTMATE_LANGUAGES),
    engine: createOnigurumaEngine(import("@shikijs/engine-oniguruma/wasm-inlined")),
  });
}
type Highlighter = Awaited<ReturnType<typeof createTextmateHighlighter>>;
type Grammar = ReturnType<Highlighter["getLanguage"]>;
type Stack = ReturnType<Grammar["tokenizeLine"]>["ruleStack"];

export function textmateTokenScope(scopes: string[]): string {
  // 字符串与注释优先，避免其中的词被误认为普通代码。
  if (scopes.some((s) => s.startsWith("comment"))) {
    return scopes.some((s) => /(?:tag|annotation)/.test(s)) ? "annotation" : "comment";
  }
  for (const scope of [...scopes].reverse()) {
    if (/^(?:string)/.test(scope)) return "string";
    if (/annotation|decorator/.test(scope)) return "annotation";
    if (/entity.name.function|support.function/.test(scope)) return "function";
    if (/entity.name.type|entity.name.class|support.type|support.class|storage.type/.test(scope)) return "type";
    if (/constant.numeric/.test(scope)) return "number";
    if (/constant|variable.other.enummember/.test(scope)) return "constant";
    if (/^(?:keyword|storage.modifier)/.test(scope)) return "keyword";
    if (/entity.name.tag/.test(scope)) return "keyword";
    if (/entity.other.attribute-name/.test(scope)) return "annotation";
    if (/variable.other.property|variable.other.object.property|variable.other.field/.test(scope)) return "property";
  }
  return "";
}

class TextmateState implements Monaco.languages.IState {
  constructor(readonly stack: Stack | null = null) {}
  clone() { return new TextmateState(this.stack); }
  equals(other: Monaco.languages.IState) {
    return other instanceof TextmateState && (this.stack === other.stack || !!(this.stack && other.stack && this.stack.equals(other.stack)));
  }
}
export function createTextmateProvider(grammar: Grammar): Monaco.languages.TokensProvider {
  return {
    getInitialState: () => new TextmateState(),
    tokenize(line, state) {
      const previous = state as TextmateState;
      if (line.length > 20000) return { tokens: [{ startIndex: 0, scopes: "" }], endState: previous };
      const result = grammar.tokenizeLine(line, previous.stack, 100);
      return {
        tokens: result.tokens.map((token) => ({ startIndex: token.startIndex, scopes: textmateTokenScope(token.scopes) })),
        endState: new TextmateState(result.ruleStack),
      };
    },
  };
}
export async function installTextmate(monaco: typeof Monaco) {
  const highlighter = await createTextmateHighlighter();
  const installers = new Map<string, () => void>();
  const pending = new Map<string, Promise<void>>();
  for (const [id, grammar] of Object.entries(TEXTMATE_LANGUAGES)) {
    const entry = monaco.languages.getLanguages().find((language) => language.id === id);
    if (!entry) monaco.languages.register({ id });
    // 等内置 provider 完成注册后再替换，防止首次打开文件时被覆盖。
    const lazyEntry = entry as (Monaco.languages.ILanguageExtensionPoint & { loader?: () => Promise<unknown> }) | undefined;
    const install = () => {
      if (pending.has(id)) return;
      const task = Promise.resolve().then(() => lazyEntry?.loader?.()).then(() => {
        monaco.languages.setTokensProvider(id, createTextmateProvider(highlighter.getLanguage(grammar[0].name)));
      }).catch((error: unknown) => {
        pending.delete(id);
        console.error(`TextMate language initialization failed: ${id}`, error);
      });
      pending.set(id, task);
    };
    installers.set(id, install);
    monaco.languages.onLanguage(id, install);
  }
  // onLanguage 只触发一次，不会补发异步加载高亮前已经激活的语言。
  // 同时覆盖现有模型、重新打开的模型以及语言切换，并按语言去重安装。
  const installForModel = (model: Monaco.editor.ITextModel) => installers.get(model.getLanguageId())?.();
  monaco.editor.onDidCreateModel(installForModel);
  monaco.editor.onDidChangeModelLanguage(({ model }) => installForModel(model));
  monaco.editor.getModels().forEach(installForModel);
}
