import type { Root, RootContent } from "hast";
import { getTextmateHighlighter, textmateTokenScope } from "@/lib/textmate";
import { canHighlightWithMarkdownCode, getMarkdownCodeLanguageFlag } from "./markdownHighlightEligibility";

export async function highlightWithMarkdownCode(code: string, language?: string): Promise<Root | null> {
  const flag = getMarkdownCodeLanguageFlag(language);
  if (!flag || !canHighlightWithMarkdownCode(code)) return null;
  const highlighter = await getTextmateHighlighter();
  // Shiki 注册语法自身的别名；额外兼容旧 Markdown 高亮器接受的名称。
  const aliases: Record<string, string> = { shell: "shellscript", sh: "shellscript", patch: "diff" };
  const id = aliases[flag] ?? flag;
  if (!highlighter.getLoadedLanguages().includes(id)) return null;
  const grammar = highlighter.getLanguage(id);
  let stack: ReturnType<typeof grammar.tokenizeLine>["ruleStack"] | null = null;
  const children: RootContent[] = [];
  const lines = code.split("\n");
  for (const [index, line] of lines.entries()) {
    const result = grammar.tokenizeLine(line, stack, 100);
    stack = result.ruleStack;
    for (const token of result.tokens) {
      // TextMate 的末尾 token 可能包含虚拟换行，必须按原文截取。
      const value = line.slice(token.startIndex, token.endIndex);
      if (!value) continue;
      const diffScope = token.scopes.find((scope) => /^markup\.(inserted|deleted|changed)/.test(scope));
      const scope = diffScope?.split(".")[1] ?? textmateTokenScope(token.scopes);
      children.push(scope ? {
        type: "element", tagName: "span",
        properties: { className: [`app-code-${scope}`] },
        children: [{ type: "text", value }],
      } : { type: "text", value });
    }
    if (index < lines.length - 1) children.push({ type: "text", value: "\n" });
  }
  return { type: "root", children };
}
