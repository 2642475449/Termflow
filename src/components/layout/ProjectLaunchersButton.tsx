import { useEffect, useState } from "react";
import { Button, Input, Modal, Tooltip, message } from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/store";
import type { ProjectLauncher } from "@/lib/projectLaunchers";
import { insertLauncherExample, loadLaunchers, persistLaunchers, resetLaunchersProject, runLauncher, useProjectLaunchersStore } from "@/store/slices/projectLaunchers";

export function ProjectLaunchersButton() {
  const { t } = useTranslation();
  const projectPath = useAppStore((state) => state.currentProject?.path);
  const state = useProjectLaunchersStore();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<ProjectLauncher | null>(null);
  const busy = state.loading || state.saving || state.running;

  useEffect(() => {
    resetLaunchersProject();
    setOpen(false);
    setSelected(null);
    setEditing(false);
  }, [projectPath]);

  function show() {
    if (!projectPath) return;
    setSelected(null);
    setEditing(false);
    setOpen(true);
    void loadLaunchers(projectPath);
  }

  async function save() {
    try {
      if (await persistLaunchers()) {
        setEditing(false);
        message.success(t("projectLaunchers.saved"));
      }
    } catch (error) {
      message.error(t("projectLaunchers.failed", { error: String(error) }));
    }
  }

  async function run() {
    if (!selected) return;
    try {
      await runLauncher(selected);
      setSelected(null);
      setOpen(false);
    } catch (error) {
      message.error(t("projectLaunchers.failed", { error: String(error) }));
    }
  }

  return <>
    <Tooltip title={t("projectLaunchers.title")}>
      <button type="button" disabled={busy} className="app-rail-button flex h-8 w-8 items-center justify-center rounded-md" aria-label={t("projectLaunchers.title")} onClick={show}>
        <PlayCircleOutlined />
      </button>
    </Tooltip>
    <Modal open={open} title={t("projectLaunchers.title")} width={720}
      closable={!busy} maskClosable={!busy} keyboard={!busy} onCancel={() => setOpen(false)}
      footer={editing ? <>
        <Button disabled={busy} onClick={() => setEditing(false)}>{t("common.cancel")}</Button>
        <Button type="primary" loading={state.saving} disabled={busy || !!state.error} onClick={() => void save()}>{t("common.save")}</Button>
      </> : selected ? <>
        <Button disabled={busy} onClick={() => setSelected(null)}>{t("common.cancel")}</Button>
        <Button type="primary" loading={state.running} disabled={busy} onClick={() => void run()}>{t("projectLaunchers.run")}</Button>
      </> : <>
        <Button disabled={busy} onClick={() => projectPath && void loadLaunchers(projectPath)}>{t("projectLaunchers.reload")}</Button>
        {state.error && <Button onClick={() => {
          if (projectPath) useAppStore.getState().openFileTab(`${projectPath}/.termflow/launchers.json`, { preview: false });
          setOpen(false);
        }}>{t("projectLaunchers.openFile")}</Button>}
        <Button disabled={busy || !!state.error} onClick={() => {
          insertLauncherExample(t("projectLaunchers.exampleName"), t("projectLaunchers.exampleTerminal"));
          setEditing(true);
        }}>{t("projectLaunchers.edit")}</Button>
      </>}>
      <div className="app-project-launchers flex flex-col gap-3 text-[var(--cs-text-primary)]">
        <p className="text-[var(--cs-text-secondary)]">{t("projectLaunchers.description")}</p>
        {state.loading && <p>{t("projectLaunchers.loading")}</p>}
        {state.error && <p role="alert" className="break-words text-[var(--cs-danger)]">{t("projectLaunchers.failed", { error: state.error })}</p>}
        {editing ? <>
          <p className="text-[var(--cs-text-secondary)]">{t("projectLaunchers.editorHint")}</p>
          <Input.TextArea aria-label={t("projectLaunchers.edit")} value={state.draft} onChange={(event) => state.setDraft(event.target.value)} rows={18} disabled={busy} className="font-mono" />
        </> : selected ? <>
          <p>{t("projectLaunchers.preview", { name: selected.name })}</p>
          {selected.terminals.map((terminal, index) => <div key={index} className="rounded border border-[var(--cs-border)] p-3">
            <strong>{terminal.title}</strong>
            <p className="font-mono">{terminal.directory}</p>
            <pre className="whitespace-pre-wrap break-words">{terminal.command || t("projectLaunchers.emptyCommand")}</pre>
          </div>)}
        </> : !state.loading && !state.error && <>
          {!state.document.launchers.length && <p>{t("projectLaunchers.empty")}</p>}
          {state.document.launchers.map((launcher) => <Button key={launcher.id} disabled={busy} onClick={() => setSelected(launcher)}>
            {launcher.name} · {t("projectLaunchers.terminalCount", { count: launcher.terminals.length })}
          </Button>)}
        </>}
      </div>
    </Modal>
  </>;
}
