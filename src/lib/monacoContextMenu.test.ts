import { describe, expect, it } from "vitest";
import { getMonacoContextMenuAvailability } from "./monacoContextMenu";

const EDITABLE_DIRTY_FACTS = {
  hasModel: true,
  hasContent: true,
  readOnly: false,
  hasSelection: true,
  canUndo: true,
  canRedo: true,
  saveEnabled: true,
};

describe("getMonacoContextMenuAvailability", () => {
  it("enables editing actions for a dirty editable selection", () => {
    expect(getMonacoContextMenuAvailability(EDITABLE_DIRTY_FACTS)).toEqual({
      undo: true,
      redo: true,
      cut: true,
      copy: true,
      paste: true,
      selectAll: true,
      save: true,
    });
  });

  it("disables cut and copy without a selection", () => {
    expect(
      getMonacoContextMenuAvailability({
        ...EDITABLE_DIRTY_FACTS,
        hasSelection: false,
      }),
    ).toMatchObject({ cut: false, copy: false, paste: true });
  });

  it("only enables non-mutating actions for read-only editors", () => {
    expect(
      getMonacoContextMenuAvailability({
        ...EDITABLE_DIRTY_FACTS,
        readOnly: true,
      }),
    ).toEqual({
      undo: false,
      redo: false,
      cut: false,
      copy: true,
      paste: false,
      selectAll: true,
      save: false,
    });
  });

  it("handles independent undo and redo availability", () => {
    expect(
      getMonacoContextMenuAvailability({
        ...EDITABLE_DIRTY_FACTS,
        canUndo: false,
        canRedo: true,
      }),
    ).toMatchObject({ undo: false, redo: true });
  });

  it("disables all actions when no model is available", () => {
    expect(
      getMonacoContextMenuAvailability({
        ...EDITABLE_DIRTY_FACTS,
        hasModel: false,
        hasContent: false,
      }),
    ).toEqual({
      undo: false,
      redo: false,
      cut: false,
      copy: false,
      paste: false,
      selectAll: false,
      save: false,
    });
  });

  it("does not enable saving for a clean document", () => {
    expect(
      getMonacoContextMenuAvailability({
        ...EDITABLE_DIRTY_FACTS,
        saveEnabled: false,
      }),
    ).toMatchObject({ save: false });
  });
});
