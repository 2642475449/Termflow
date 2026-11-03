import { Button, Input, Modal } from "antd";
import { useTranslation } from "react-i18next";
import { projectPathKey } from "@/lib/openProjects";
import { PROJECT_ICON_COLORS, isProjectIconEmoji } from "@/lib/projectIcons";
import { useProjectIconsStore } from "@/store/slices/projectIcons";
import type { ProjectIconPreference } from "@/store/types";
import { ProjectIconGlyph } from "./ProjectIcon";

export function ProjectIconEditor({ onClosed }: { onClosed?: () => void }) {
  const { t } = useTranslation();
  const editor = useProjectIconsStore((state) => state.editor);
  const detected = useProjectIconsStore((state) => editor ? state.icons[projectPathKey(editor.project.path)]?.src : null);
  const update = useProjectIconsStore((state) => state.setEditorDraft);
  const close = useProjectIconsStore((state) => state.setEditorClosed);
  const save = useProjectIconsStore((state) => state.setEditorSaved);
  const upload = useProjectIconsStore((state) => state.setEditorImage);
  const busy = !!editor && (editor.saving || editor.importing || editor.loading || !editor.loaded);
  const invalid = !!editor && ((editor.draft.mode === "emoji" && !isProjectIconEmoji(editor.draft.emoji ?? "")) || (editor.draft.mode === "image" && !editor.draft.image));

  return (
    <Modal afterClose={onClosed} title={t("projectIcons.title")} open={!!editor} onCancel={close} onOk={() => void save()} confirmLoading={editor?.saving} okText={t("common.save")} cancelText={t("common.cancel")} okButtonProps={{ disabled: busy || invalid }} cancelButtonProps={{ disabled: editor?.saving }} closable={!editor?.saving} maskClosable={false} keyboard={!editor?.saving} width={440}>
      {editor ? (
        <div className="app-project-icon-editor" aria-busy={editor.loading || editor.saving || editor.importing}>
          <div className="app-project-icon-editor__preview">
            <ProjectIconGlyph key={editor.project.path} name={editor.project.name} color={editor.draft.color} preference={editor.draft} detected={detected} />
            <div className="min-w-0">
              <div className="truncate font-medium" title={editor.project.name}>{editor.project.name}</div>
              <div className="app-project-icon-editor__path" title={editor.project.path}>{editor.project.path}</div>
            </div>
          </div>
          <div className="app-project-icon-editor__modes" role="group" aria-label={t("projectIcons.mode")}>
            {(["auto", "initials", "emoji", "image"] as const).map((mode: ProjectIconPreference["mode"]) => <button key={mode} type="button" disabled={busy} aria-pressed={editor.draft.mode === mode} onClick={() => update({ mode })}>{t(`projectIcons.${mode}`)}</button>)}
          </div>
          {editor.draft.mode === "auto" ? <p className="app-project-icon-editor__hint">{t("projectIcons.autoHint")}</p> : null}
          {editor.draft.mode === "emoji" ? (
            <div>
              <label htmlFor="app-project-icon-emoji">{t("projectIcons.emojiLabel")}</label>
              <Input id="app-project-icon-emoji" value={editor.draft.emoji ?? ""} disabled={busy} maxLength={32} onChange={(event) => update({ emoji: event.target.value })} placeholder="🚀" aria-describedby="app-project-icon-emoji-hint" />
              <p id="app-project-icon-emoji-hint" className="app-project-icon-editor__hint">{t("projectIcons.emojiHint")}</p>
            </div>
          ) : null}
          {editor.draft.mode === "image" ? (
            <div>
              <Button block onClick={() => void upload()} loading={editor.importing} disabled={editor.saving || editor.loading || !editor.loaded}>{t(editor.draft.image ? "projectIcons.replaceImage" : "projectIcons.chooseImage")}</Button>
              <p className="app-project-icon-editor__hint">{t("projectIcons.imageHint")}</p>
            </div>
          ) : (
            <div>
              <p id="app-project-icon-colors-label" className="mb-2">{t(editor.draft.mode === "auto" ? "projectIcons.fallbackColor" : "projectIcons.color")}</p>
              <div className="app-project-icon-editor__colors" role="group" aria-labelledby="app-project-icon-colors-label">
                {PROJECT_ICON_COLORS.map((color, index) => (
                  <button key={color} type="button" className={`app-project-icon-editor__color app-project-icon--swatch-${index}`} aria-label={t(`projectIcons.colors.${color}`)} title={t(`projectIcons.colors.${color}`)} aria-pressed={editor.draft.color === index} disabled={busy} onClick={() => update({ color: index })}>
                    <span className={`app-project-icon app-project-icon--swatch-${index}`}>{editor.draft.color === index ? "✓" : ""}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {editor.error ? <p role="alert" className="text-[var(--cs-danger)]">{editor.error}</p> : null}
          <button type="button" className="app-project-icon-editor__reset" disabled={busy} onClick={() => update({ mode: "auto", emoji: undefined, image: undefined })}>{t("projectIcons.reset")}</button>
        </div>
      ) : null}
    </Modal>
  );
}
