import { lazy, Suspense, useEffect, useState } from "react";
import { Alert, Button, Input, Segmented, Spin } from "antd";
import { SaveOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { validateSkillContent } from "@/lib/api";
import { skillMarkdownBody } from "@/lib/skills";
import { useSkillsStore, type SkillEditorDraft } from "@/store/slices/skillsSlice";
import type { SkillInfo } from "@/types";

const MarkdownPreview = lazy(() => import("@/components/markdown/MarkdownPreview"));

interface SkillContentEditorProps {
  editorKey: string;
  editor: SkillEditorDraft;
  skill: SkillInfo;
  saving: boolean;
  conflict: boolean;
  onSave: () => void;
  onReload: () => void;
}

export function SkillContentEditor({ editorKey, editor, skill, saving, conflict, onSave, onReload }: SkillContentEditorProps) {
  const { t } = useTranslation();
  const [view, setView] = useState("preview");
  const [retry, setRetry] = useState(0);
  const dirty = editor.draft !== editor.original;
  const validating = editor.validatedContent !== editor.draft;
  const invalid = validating || !!editor.validation?.issues.length;

  useEffect(() => {
    let cancelled = false;
    const content = editor.draft;
    const timer = window.setTimeout(() => {
      void validateSkillContent(content, skill.folderName).then((validation) => {
        if (!cancelled) useSkillsStore.getState().setEditorValidation(editorKey, content, validation);
      }).catch(() => {
        if (!cancelled) useSkillsStore.getState().setEditorValidation(editorKey, content,
          { issues: ["validationUnavailable"], name: "", description: "" });
      });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [editorKey, editor.draft, skill.folderName, retry]);

  return <div className="app-skill-editor">
    <div className="app-skill-editor-toolbar">
      <Segmented value={view} onChange={setView} options={[
        { value: "preview", label: t("settings.skills.editor.preview") },
        { value: "source", label: t("settings.skills.editor.source") },
      ]} />
      <div className="flex items-center gap-2 flex-wrap">
        {dirty && <span className="app-skills-secondary text-xs">{t("settings.skills.editor.unsaved")}</span>}
        <Button size="small" disabled={saving} onClick={onReload}>{t("settings.skills.editor.reload")}</Button>
        <Button type="primary" size="small" icon={<SaveOutlined />} disabled={!dirty || invalid || conflict} loading={saving} onClick={onSave}>
          {t("settings.shared.save")}
        </Button>
      </div>
    </div>
    {conflict && <Alert type="warning" showIcon message={t("settings.skills.editor.conflict")} />}
    {!!editor.validation?.issues.length && <Alert type="error" showIcon message={t("settings.skills.editor.validationTitle")}
      description={<ul className="list-disc pl-4">{editor.validation.issues.map((issue) => <li key={issue}>
        {t(`settings.skills.editor.issues.${issue}`, { folder: skill.folderName })}
      </li>)}</ul>}
      action={editor.validation.issues.includes("validationUnavailable") ? <Button size="small" onClick={() => setRetry((value) => value + 1)}>{t("common.refresh")}</Button> : undefined} />}
    {view === "source" ? <Input.TextArea className="app-skill-source-editor" spellCheck={false} disabled={saving}
      aria-label={t("settings.skills.editor.source")} value={editor.draft}
      onChange={(event) => useSkillsStore.getState().setEditorDraft(editorKey, event.target.value)}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          if (dirty && !invalid && !saving && !conflict) onSave();
        }
      }} /> : <Suspense fallback={<div className="flex justify-center py-10"><Spin /></div>}>
        <MarkdownPreview content={skillMarkdownBody(editor.draft)} emptyText={t("settings.skills.editor.emptyBody")}
          className="app-skill-markdown-preview" enableImagePreview={false} />
      </Suspense>}
  </div>;
}
