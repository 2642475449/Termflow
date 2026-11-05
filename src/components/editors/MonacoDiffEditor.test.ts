// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  editors: [] as any[],
  models: [] as any[],
  createDiffEditor: vi.fn(),
  createModel: vi.fn(),
  setModelLanguage: vi.fn(),
  setTheme: vi.fn(),
}));
vi.mock("@/lib/monacoRuntime", () => ({ editor: runtime }));
import { MonacoDiffEditor } from "./MonacoDiffEditor";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  runtime.editors = [];
  runtime.models = [];
  vi.clearAllMocks();
  runtime.createDiffEditor.mockImplementation(() => {
    let attached: any = null;
    const instance = {
      getModel: () => attached,
      setModel: vi.fn((models) => { attached = models; }),
      updateOptions: vi.fn(),
      dispose: vi.fn(() => { expect(attached).toBeNull(); }),
    };
    runtime.editors.push(instance);
    return instance;
  });
  runtime.createModel.mockImplementation((value, language) => {
    let disposed = false;
    const model = {
      language,
      getValue: () => value,
      setValue: vi.fn((next) => { value = next; }),
      isDisposed: () => disposed,
      dispose: vi.fn(() => {
        // Reproduce Monaco's assertion if any live diff still observes this model.
        for (const instance of runtime.editors) {
          const models = instance.getModel();
          if (models?.original === model || models?.modified === model) {
            throw new Error("TextModel got disposed before DiffEditorWidget model got reset");
          }
        }
        expect(disposed).toBe(false);
        disposed = true;
      }),
    };
    runtime.models.push(model);
    return model;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("survives StrictMode, preview replacement, and switching to non-text content without leaking models", () => {
  const onMount = vi.fn();
  const render = (original: string, modified: string, language = "typescript") => act(() => root.render(
    createElement(StrictMode, null, createElement(MonacoDiffEditor, { original, modified, language, onMount })),
  ));
  render("before", "after");
  const liveEditor = runtime.editors.at(-1);
  render("other before", "other after", "json");
  expect(runtime.editors.at(-1)).toBe(liveEditor);
  expect(liveEditor.getModel().original.getValue()).toBe("other before");
  expect(liveEditor.getModel().modified.getValue()).toBe("other after");
  expect(runtime.setModelLanguage).toHaveBeenCalledWith(liveEditor.getModel().original, "json");
  act(() => root.render(createElement("img", { alt: "binary preview" })));
  render("reopened", "reopened changed");
  act(() => root.render(null));
  for (const model of runtime.models) expect(model.dispose).toHaveBeenCalledTimes(1);
  for (const instance of runtime.editors) expect(instance.dispose).toHaveBeenCalledTimes(1);
  expect(onMount).toHaveBeenCalled();
});

it("isolates models belonging to different tabs", () => {
  act(() => root.render(createElement("div", null,
    createElement(MonacoDiffEditor, { key: "a", original: "a", modified: "aa" }),
    createElement(MonacoDiffEditor, { key: "b", original: "b", modified: "bb" }),
  )));
  const second = runtime.editors[1];
  act(() => root.render(createElement("div", null,
    createElement(MonacoDiffEditor, { key: "b", original: "b", modified: "bb" }),
  )));
  expect(second.getModel().original.isDisposed()).toBe(false);
  expect(second.getModel().modified.getValue()).toBe("bb");
  expect(second.dispose).not.toHaveBeenCalled();
});

it("releases partially created resources when initialization fails", () => {
  runtime.createModel.mockImplementationOnce(() => { throw new Error("model initialization failed"); });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(() => act(() => root.render(createElement(MonacoDiffEditor)))).toThrow("model initialization failed");
  expect(runtime.editors[0].dispose).toHaveBeenCalledTimes(1);
  error.mockRestore();
});
