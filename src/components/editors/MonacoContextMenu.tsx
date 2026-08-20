import {
  CopyOutlined,
  EditOutlined,
  RedoOutlined,
  SaveOutlined,
  ScissorOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import { Dropdown, type MenuProps } from "antd";
import * as monaco from "monaco-editor";
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  getMonacoContextMenuAvailability,
  type MonacoContextMenuFacts,
} from "@/lib/monacoContextMenu";
import {
  isMonacoContextMenuCommand,
  runMonacoContextMenuCommand,
  type MonacoContextMenuCommand,
} from "@/lib/monacoContextMenuActions";

type MonacoContextMenuAction = MonacoContextMenuCommand | "save";

interface MonacoContextMenuSaveAction {
  enabled: boolean;
  run: () => void;
}

interface MonacoContextMenuProps {
  children: ReactNode;
  className?: string;
  getEditors: () => readonly monaco.editor.IStandaloneCodeEditor[];
  saveAction?: MonacoContextMenuSaveAction;
}

function getEditorFacts(
  editor: monaco.editor.IStandaloneCodeEditor,
  saveEnabled: boolean,
): MonacoContextMenuFacts {
  const model = editor.getModel();
  const selections = editor.getSelections() ?? [];

  return {
    hasModel: model !== null,
    hasContent: Boolean(model?.getValueLength()),
    readOnly: editor.getOption(monaco.editor.EditorOption.readOnly),
    hasSelection: selections.some((selection) => !selection.isEmpty()),
    canUndo: model?.canUndo() ?? false,
    canRedo: model?.canRedo() ?? false,
    saveEnabled,
  };
}

function MonacoContextMenu({
  children,
  className,
  getEditors,
  saveAction,
}: MonacoContextMenuProps) {
  const { t } = useTranslation();
  const activeEditorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [open, setOpen] = useState(false);
  const [facts, setFacts] = useState<MonacoContextMenuFacts | null>(null);

  const availability = useMemo(
    () =>
      facts
        ? getMonacoContextMenuAvailability(facts)
        : getMonacoContextMenuAvailability({
            hasModel: false,
            hasContent: false,
            readOnly: true,
            hasSelection: false,
            canUndo: false,
            canRedo: false,
            saveEnabled: false,
          }),
    [facts],
  );

  const menuItems = useMemo<MenuProps["items"]>(
    () => [
      {
        key: "undo",
        icon: <UndoOutlined />,
        label: t("editorContextMenu.undo"),
        extra: "Ctrl+Z",
        disabled: !availability.undo,
      },
      {
        key: "redo",
        icon: <RedoOutlined />,
        label: t("editorContextMenu.redo"),
        extra: "Ctrl+Y",
        disabled: !availability.redo,
      },
      { type: "divider" },
      {
        key: "cut",
        icon: <ScissorOutlined />,
        label: t("editorContextMenu.cut"),
        extra: "Ctrl+X",
        disabled: !availability.cut,
      },
      {
        key: "copy",
        icon: <CopyOutlined />,
        label: t("editorContextMenu.copy"),
        extra: "Ctrl+C",
        disabled: !availability.copy,
      },
      {
        key: "paste",
        icon: <EditOutlined />,
        label: t("editorContextMenu.paste"),
        extra: "Ctrl+V",
        disabled: !availability.paste,
      },
      { type: "divider" },
      {
        key: "selectAll",
        label: t("editorContextMenu.selectAll"),
        extra: "Ctrl+A",
        disabled: !availability.selectAll,
      },
      { type: "divider" },
      {
        key: "save",
        icon: <SaveOutlined />,
        label: t("editorContextMenu.save"),
        extra: "Ctrl+S",
        disabled: !availability.save,
      },
    ],
    [availability, t],
  );

  function findTargetEditor(target: EventTarget | null) {
    if (!(target instanceof Node)) return null;
    return (
      getEditors().find((editor) => editor.getContainerDomNode().contains(target)) ?? null
    );
  }

  function handleContextMenuCapture(event: ReactMouseEvent<HTMLDivElement>) {
    const editor = findTargetEditor(event.target);
    activeEditorRef.current = editor;
    setFacts(editor ? getEditorFacts(editor, saveAction?.enabled ?? false) : null);
  }

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen && !activeEditorRef.current) return;
    setOpen(nextOpen);
    if (!nextOpen) {
      // Ant Design may report the dropdown as closed before the menu item's
      // click handler runs. Keep the editor ref so cut/copy/paste can still
      // dispatch their Monaco action; the next context-menu capture replaces it.
      setFacts(null);
    }
  }

  function handleMenuClick({ key }: { key: string }) {
    const action = key as MonacoContextMenuAction;
    const editor = activeEditorRef.current;
    setOpen(false);

    if (action === "save") {
      if (availability.save) saveAction?.run();
      return;
    }

    if (editor && isMonacoContextMenuCommand(action)) {
      runMonacoContextMenuCommand(editor, action);
    }
  }

  return (
    <Dropdown
      trigger={["contextMenu"]}
      open={open}
      menu={{ items: menuItems, onClick: handleMenuClick }}
      onOpenChange={handleOpenChange}
    >
      <div className={className} onContextMenuCapture={handleContextMenuCapture}>
        {children}
      </div>
    </Dropdown>
  );
}

export default MonacoContextMenu;
