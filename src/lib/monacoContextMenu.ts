export interface MonacoContextMenuFacts {
  hasModel: boolean;
  hasContent: boolean;
  readOnly: boolean;
  hasSelection: boolean;
  canUndo: boolean;
  canRedo: boolean;
  saveEnabled: boolean;
}

export interface MonacoContextMenuAvailability {
  undo: boolean;
  redo: boolean;
  cut: boolean;
  copy: boolean;
  paste: boolean;
  selectAll: boolean;
  save: boolean;
}

export function getMonacoContextMenuAvailability(
  facts: MonacoContextMenuFacts,
): MonacoContextMenuAvailability {
  const canEdit = facts.hasModel && !facts.readOnly;

  return {
    undo: canEdit && facts.canUndo,
    redo: canEdit && facts.canRedo,
    cut: canEdit && facts.hasSelection,
    copy: facts.hasModel && facts.hasSelection,
    paste: canEdit,
    selectAll: facts.hasModel && facts.hasContent,
    save: canEdit && facts.saveEnabled,
  };
}
