import { beforeAll, expect, it, vi } from "vitest";
import { createTextmateHighlighter, createTextmateProvider, installTextmate, textmateTokenScope } from "./textmate";

let highlighter: Awaited<ReturnType<typeof createTextmateHighlighter>>;
beforeAll(async () => { highlighter = await createTextmateHighlighter(); }, 30000);

it("bundles Java and component grammars without remote loaders", () => {
  expect(highlighter.getLoadedLanguages()).toEqual(expect.arrayContaining(["java", "tsx", "vue", "rust", "python"]));
});
it("distinguishes Java annotations, methods and strings", () => {
  const grammar = highlighter.getLanguage("java");
  const scopes = (line: string) => grammar.tokenizeLine(line, null).tokens.map((token) => textmateTokenScope(token.scopes));
  expect(scopes('@Autowired')).toContain("annotation");
  expect(scopes('public void saveRecord() {')).toContain("function");
  expect(scopes('String value = "hello";')).toContain("string");
});
it("preserves multiline comment state between lines", () => {
  const provider = createTextmateProvider(highlighter.getLanguage("java"));
  const first = provider.tokenize('/* start', provider.getInitialState());
  const second = provider.tokenize('saveRecord() inside comment', first.endState);
  expect(second.tokens.every((token) => token.scopes === "comment")).toBe(true);
  expect(first.endState.equals(first.endState.clone())).toBe(true);
});
it("recognizes TSX tags and attributes", () => {
  const result = highlighter.getLanguage("tsx").tokenizeLine('const view = <button title="Save">Save</button>;', null);
  expect(result.tokens.some((token) => textmateTokenScope(token.scopes) === "annotation")).toBe(true);
  expect(result.tokens.some((token) => textmateTokenScope(token.scopes) === "string")).toBe(true);
});

it("installs providers after the built-in language loader completes", async () => {
  const listeners = new Map<string, () => void>();
  const loader = vi.fn(async () => {});
  const setTokensProvider = vi.fn();
  const api = { languages: {
    getLanguages: () => [{ id: "java", loader }],
    register: vi.fn(),
    onLanguage: (id: string, callback: () => void) => { listeners.set(id, callback); },
    setTokensProvider,
  } };
  await installTextmate(api as unknown as typeof import("monaco-editor"));
  expect(setTokensProvider).not.toHaveBeenCalled();
  listeners.get("java")?.();
  await vi.waitFor(() => expect(setTokensProvider).toHaveBeenCalledWith("java", expect.any(Object)));
  expect(loader).toHaveBeenCalledOnce();
});
