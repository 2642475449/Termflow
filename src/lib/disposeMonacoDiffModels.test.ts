import { expect, it, vi } from "vitest";
import type { editor } from "monaco-editor";
import { disposeMonacoDiffModels } from "./disposeMonacoDiffModels";

it("detaches both models before disposing either, and releases each model once", () => {
  let attached = true;
  const dispose = () => { expect(attached).toBe(false); };
  const models = { original: { dispose: vi.fn(dispose) }, modified: { dispose: vi.fn(dispose) } };
  const instance = {
    getModel: () => attached ? models : null,
    setModel: vi.fn(() => { attached = false; }),
  } as unknown as editor.IStandaloneDiffEditor;

  disposeMonacoDiffModels(instance);
  // The React wrapper's subsequent cleanup sees no attached models.
  expect(instance.getModel()).toBeNull();
  disposeMonacoDiffModels(instance);
  expect(models.original.dispose).toHaveBeenCalledTimes(1);
  expect(models.modified.dispose).toHaveBeenCalledTimes(1);
  expect(instance.setModel).toHaveBeenCalledWith(null);
});
