import "@wooorm/starry-night/style/core";
import { createStarryNight } from "@wooorm/starry-night";
import sourceC from "@wooorm/starry-night/source.c";
import sourceCpp from "@wooorm/starry-night/source.c++";
import sourceCss from "@wooorm/starry-night/source.css";
import sourceCs from "@wooorm/starry-night/source.cs";
import sourceDiff from "@wooorm/starry-night/source.diff";
import sourceDockerfile from "@wooorm/starry-night/source.dockerfile";
import sourceGo from "@wooorm/starry-night/source.go";
import sourceJava from "@wooorm/starry-night/source.java";
import sourceJavaScript from "@wooorm/starry-night/source.js";
import sourceJson from "@wooorm/starry-night/source.json";
import sourcePowerShell from "@wooorm/starry-night/source.powershell";
import sourcePython from "@wooorm/starry-night/source.python";
import sourceRust from "@wooorm/starry-night/source.rust";
import sourceShell from "@wooorm/starry-night/source.shell";
import sourceSql from "@wooorm/starry-night/source.sql";
import sourceToml from "@wooorm/starry-night/source.toml";
import sourceTs from "@wooorm/starry-night/source.ts";
import sourceTsx from "@wooorm/starry-night/source.tsx";
import sourceYaml from "@wooorm/starry-night/source.yaml";
import textHtml from "@wooorm/starry-night/text.html.basic";
import textMarkdown from "@wooorm/starry-night/text.md";
import onigurumaWasmUrl from "vscode-oniguruma/release/onig.wasm?url";
import type { Root } from "hast";
import {
  canHighlightWithStarryNight,
  getStarryNightLanguageFlag,
} from "./starryNightEligibility";

export {
  STARRY_NIGHT_MAX_CODE_CHARS,
  STARRY_NIGHT_MAX_CODE_LINES,
  canHighlightWithStarryNight,
  getStarryNightLanguageFlag,
} from "./starryNightEligibility";

const grammars = [
  sourceC,
  sourceCpp,
  sourceCss,
  sourceCs,
  sourceDiff,
  sourceDockerfile,
  sourceGo,
  sourceJava,
  sourceJavaScript,
  sourceJson,
  sourcePowerShell,
  sourcePython,
  sourceRust,
  sourceShell,
  sourceSql,
  sourceToml,
  sourceTs,
  sourceTsx,
  sourceYaml,
  textHtml,
  textMarkdown,
];

let highlighterPromise: ReturnType<typeof createStarryNight> | null = null;

function getHighlighter() {
  highlighterPromise ??= createStarryNight(grammars, {
    getOnigurumaUrlFetch: () => new URL(onigurumaWasmUrl, window.location.href),
  });
  return highlighterPromise;
}

export async function highlightWithStarryNight(
  code: string,
  language?: string,
): Promise<Root | null> {
  const flag = getStarryNightLanguageFlag(language);
  if (!flag || !canHighlightWithStarryNight(code)) return null;

  const highlighter = await getHighlighter();
  const scope = highlighter.flagToScope(flag);
  return scope ? highlighter.highlight(code, scope) : null;
}
