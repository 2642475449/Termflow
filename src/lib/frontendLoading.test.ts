import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

it("keeps editor and syntax-highlighting runtimes out of the static startup graph", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const visited = new Set<string>();
  const eagerPackages = new Set<string>();

  function visit(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (clause?.isTypeOnly) continue;
        const bindings = clause?.namedBindings;
        if (!clause?.name && bindings && ts.isNamedImports(bindings)
          && bindings.elements.length > 0 && bindings.elements.every((item) => item.isTypeOnly)) continue;
      } else if (statement.isTypeOnly) {
        continue;
      }
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      eagerPackages.add(specifier.text);
      const resolved = ts.resolveModuleName(specifier.text, file, options, ts.sys).resolvedModule;
      if (resolved && !resolved.isExternalLibraryImport && /\.tsx?$/.test(resolved.resolvedFileName)) {
        visit(resolved.resolvedFileName);
      }
    }
  }

  // 检查整个入口依赖链，防止其他常驻弹窗再次绕过编辑器的 lazy 边界。
  visit(path.join(root, "src/main.tsx"));
  expect([...eagerPackages].filter((name) =>
    /^(monaco-editor|@monaco-editor\/react|@shikijs\/|@wooorm\/starry-night)/.test(name),
  )).toEqual([]);
});
