import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpenOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, ShopOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Input, Modal, Pagination, Segmented, Select, Spin, Switch, Tabs, Tag, Tooltip, message } from "antd";
import { useTranslation } from "react-i18next";
import { AgentIcon } from "@/components/AgentIcon";
import { SkillContentEditor } from "./SkillContentEditor";
import { SettingsPageHeader } from "./SettingsPageHeader";
import { useAppStore } from "@/store";
import { useSkillsStore } from "@/store/slices/skillsSlice";
import { openSkillMarketplaceTab } from "@/store/slices/skillMarketplaceTabsSlice";
import { getAgentIdsWithCapability } from "@/lib/agents";
import { ensureSkillDirectory, getSkillDetail, installSkill, openInFileManager, saveSkillContent, selectSkillImportDirectory, setSkillEnabled } from "@/lib/api";
import { filterSkillGroups, groupSkills, isSkillLinked, skillEditorKey, skillFolderName, skillInstallTargets, skillToggleBlocked } from "@/lib/skills";
import type { SkillAgent, SkillInfo, SkillScope } from "@/types";

const SKILL_AGENTS = getAgentIdsWithCapability("skills");
const PAGE_SIZE = 10;

export function SkillsSettingsPage() {
  const { t } = useTranslation();
  const projectPath = useAppStore((state) => state.currentProject?.path ?? null);
  const { catalog, loading, error, editors } = useSkillsStore();
  const [scope, setScope] = useState<"all" | SkillScope>("all");
  const [agent, setAgent] = useState<"all" | SkillAgent>("all");
  const [status, setStatus] = useState<"all" | "enabled" | "disabled">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState("content");
  const [saving, setSaving] = useState(false);
  const [saveConflict, setSaveConflict] = useState(false);
  const [discardIntent, setDiscardIntent] = useState<"close" | "reload" | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [mode, setMode] = useState<"create" | "import">("create");
  const [addScope, setAddScope] = useState<SkillScope>("user");
  const [targets, setTargets] = useState<SkillAgent[]>(["codex"]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const detailId = useRef(0);
  const label = (id: SkillAgent) => t(`settings.skills.agents.${id}`);
  const scopeLabel = (value: SkillScope) => t(`settings.scope.${value === "workspace" ? "workspaceShort" : "userShort"}`);
  const failure = (reason: unknown) => message.error(t("settings.skills.operationFailed", { reason: String(reason) }));

  const refresh = useCallback(async () => {
    if (useSkillsStore.getState().projectPath !== projectPath) return;
    try {
      await useSkillsStore.getState().refreshCatalog(projectPath);
    } catch (reason) {
      message.error(t("settings.skills.loadFailed"));
      console.error("Failed to load skills", reason);
    }
  }, [projectPath, t]);

  useEffect(() => {
    useSkillsStore.getState().setProject(projectPath);
    setSelected(null);
    setAddOpen(false);
    setScope("all");
    setPage(1);
    void refresh();
    return () => { detailId.current++; };
  }, [projectPath, refresh]);

  const groups = useMemo(() => groupSkills(catalog?.skills ?? []), [catalog]);
  const filtered = filterSkillGroups(groups, search, agent, scope, status);
  const selectedGroup = groups.find((group) => group.id === selected);
  const selectedLocation = selectedGroup?.locations[0];
  const editorKey = selected ? skillEditorKey(projectPath, selected) : "";
  const editor = editors[editorKey];
  const editorDirty = !!editor && editor.draft !== editor.original;
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)));
  const preview = skillInstallTargets(catalog, targets, addScope);
  const consumers = [...new Set(preview.flatMap((target) => target.consumers))];

  useEffect(() => {
    const request = ++detailId.current;
    setSaveConflict(false);
    setDiscardIntent(null);
    if (!selectedLocation) { setDetailLoading(false); return; }
    setDetailLoading(true);
    void getSkillDetail(selectedLocation.agent, selectedLocation.scope, selectedLocation.folderName, selectedLocation.enabled, projectPath)
      .then((detail) => {
        if (request === detailId.current) useSkillsStore.getState().setEditorLoaded(editorKey, detail.content);
      })
      .catch((reason: unknown) => {
        if (request === detailId.current) {
          message.error(t("settings.skills.loadDetailFailed"));
          console.error("Failed to read skill", reason);
        }
      }).finally(() => { if (request === detailId.current) setDetailLoading(false); });
    return () => { detailId.current++; };
  }, [selectedLocation, projectPath, editorKey, t]);

  useEffect(() => {
    if (!editorDirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [editorDirty]);

  async function saveContent() {
    if (!selectedLocation || !editor || saving || saveConflict) return;
    const submitted = editor.draft;
    const key = editorKey;
    setSaving(true);
    try {
      const detail = await saveSkillContent({ agent: selectedLocation.agent, scope: selectedLocation.scope,
        folderName: selectedLocation.folderName, enabled: selectedLocation.enabled, projectPath,
        content: submitted, expectedContent: editor.original, expectedResolvedPath: selectedLocation.resolvedFilePath });
      useSkillsStore.getState().setEditorSaved(key, submitted, detail.content);
      await refresh();
      message.success(t("settings.skills.editor.saved"));
    } catch (reason) {
      if (String(reason) === "skill_content_changed" || String(reason) === "skill_path_changed") setSaveConflict(true);
      else failure(reason);
    } finally { setSaving(false); }
  }

  async function reloadContent() {
    if (!selectedLocation || saving) return;
    const request = ++detailId.current;
    setDetailLoading(true);
    try {
      const detail = await getSkillDetail(selectedLocation.agent, selectedLocation.scope, selectedLocation.folderName, selectedLocation.enabled, projectPath);
      if (request === detailId.current) {
        const nextKey = skillEditorKey(projectPath, detail.skill.resolvedFilePath);
        useSkillsStore.getState().setEditorLoaded(nextKey, detail.content, true);
        setSaveConflict(false);
        if (detail.skill.resolvedFilePath !== selected) {
          await refresh();
          setSelected((current) => current === selected ? detail.skill.resolvedFilePath : current);
        }
      }
    } catch (reason) { failure(reason); }
    finally { if (request === detailId.current) setDetailLoading(false); }
  }

  function closeDetail() {
    if (saving) return;
    if (editorDirty) setDiscardIntent("close");
    else setSelected(null);
  }

  function discardChanges() {
    const intent = discardIntent;
    setDiscardIntent(null);
    if (intent === "reload") { void reloadContent(); return; }
    if (editor) useSkillsStore.getState().setEditorDraft(editorKey, editor.original);
    setSelected(null);
  }

  async function openFolder(path: string) {
    try { await openInFileManager(path); } catch (reason) { failure(reason); }
  }

  async function toggle(skill: SkillInfo, enabled: boolean) {
    if (!catalog || editorDirty || saving || skillToggleBlocked(skill, catalog)) return;
    setBusy(skill.id);
    try {
      const updated = await setSkillEnabled(skill.agent, skill.scope, skill.folderName, skill.enabled, enabled, projectPath);
      await refresh();
      if (useSkillsStore.getState().projectPath === projectPath) {
        setSelected((current) => current === skill.resolvedFilePath ? updated.resolvedFilePath : current);
      }
    } catch (reason) { failure(reason); }
    finally { setBusy(null); }
  }

  function openAdd() {
    setMode("create");
    setAddScope(scope === "all" ? (projectPath ? "workspace" : "user") : scope);
    setTargets([agent === "all" ? "codex" : agent]);
    setName(""); setDescription(""); setSource(null);
    setAddOpen(true);
  }

  async function submit() {
    if (!targets.length || (mode === "create" ? !name.trim() : !source)) return;
    setInstalling(true);
    try {
      const installed = await installSkill({ agents: targets, scope: addScope, name: name.trim(), description: description.trim(),
        sourceDirectory: mode === "import" ? source : null, projectPath });
      if (useSkillsStore.getState().projectPath !== projectPath) return;
      setAddOpen(false);
      setScope("all"); setAgent("all"); setStatus("all"); setSearch(""); setPage(1);
      await refresh();
      setDetailTab("content");
      setSelected(installed[0]?.resolvedFilePath ?? null);
      message.success(t("settings.skills.installSuccess"));
    } catch (reason) { failure(reason); }
    finally { setInstalling(false); }
  }

  const changeFilter = () => setPage(1);
  return <div className="app-skills-library">
    <SettingsPageHeader title={<>{t("settings.menu.skills")} <span className="app-skills-muted text-sm font-normal">{groups.length}</span></>}
      description={t("settings.skills.libraryDescription")}
      actions={<div className="flex gap-2">
        <Button icon={<ShopOutlined />} onClick={openSkillMarketplaceTab}>{t("settings.skillMarket.title")}</Button>
        <Button icon={<ReloadOutlined spin={loading} />} onClick={() => void refresh()}>{t("common.refresh")}</Button>
        <Button type="primary" icon={<PlusOutlined />} disabled={!catalog} onClick={openAdd}>{t("settings.skills.addSkill")}</Button>
      </div>}>
      <div className="app-settings-choices" role="group" aria-label={t("settings.skills.filterByAgent")}>
        <button type="button" aria-pressed={agent === "all"} onClick={() => { setAgent("all"); changeFilter(); }}>
          {t("settings.skills.allAgents")}
        </button>
        {SKILL_AGENTS.map((id) => (
          <button key={id} type="button" aria-pressed={agent === id} onClick={() => { setAgent(id); changeFilter(); }}>
            <AgentIcon agentId={id} size={14} />{label(id)}
          </button>
        ))}
      </div>
      <div className="app-settings-scope-tabs" role="group" aria-label={t("settings.skills.skillScope")}>
        <button type="button" aria-pressed={scope === "all"} onClick={() => { setScope("all"); changeFilter(); }}>
          {t("settings.skills.allScopes")}<span>{groups.length}</span>
        </button>
        <button type="button" aria-pressed={scope === "workspace"} disabled={!projectPath}
          onClick={() => { setScope("workspace"); changeFilter(); }}>
          {scopeLabel("workspace")}<span>{groups.filter((group) => group.locations.some((item) => item.scope === "workspace")).length}</span>
        </button>
        <button type="button" aria-pressed={scope === "user"} onClick={() => { setScope("user"); changeFilter(); }}>
          {scopeLabel("user")}<span>{groups.filter((group) => group.locations.some((item) => item.scope === "user")).length}</span>
        </button>
      </div>
    </SettingsPageHeader>
    <div className="app-skills-filters">
      <div className="flex flex-wrap items-center gap-3">
        <Input className="app-skills-search" allowClear prefix={<SearchOutlined />} placeholder={t("settings.skills.searchPlaceholder")} aria-label={t("settings.skills.searchPlaceholder")}
          value={search} onChange={(event) => { setSearch(event.target.value); changeFilter(); }} />
        <Segmented value={status} onChange={(value) => { setStatus(value as typeof status); changeFilter(); }} options={[
          { value: "all", label: t("settings.shared.allStatus") }, { value: "enabled", label: t("common.enabled") }, { value: "disabled", label: t("common.disabled") },
        ]} />
        <Button type="text" icon={<FolderOpenOutlined />} onClick={async () => {
          try {
            const path = await ensureSkillDirectory(agent === "all" ? "codex" : agent, scope === "all" ? (projectPath ? "workspace" : "user") : scope, true, projectPath);
            await openFolder(path);
          } catch (reason) { failure(reason); }
        }}>{agent === "all" ? t("settings.skills.openSharedDirectory") : t("settings.skills.openEnabledDir")}</Button>
      </div>
    </div>
    {error && <Alert type="error" showIcon message={t("settings.skills.loadFailed")} action={<Button onClick={() => void refresh()}>{t("common.refresh")}</Button>} />}
    {loading && !catalog ? <div className="flex justify-center py-20"><Spin /></div> : <div className="app-skills-list" aria-busy={loading}>
      {!filtered.length ? <div className="py-10"><Empty description={t("settings.skills.emptyFiltered")} />
        <div className="text-center mt-3"><Button onClick={openAdd} disabled={!catalog}>{t("settings.skills.addSkill")}</Button></div></div> :
        filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE).map((group) => {
          const skill = group.locations[0];
          const conflict = group.locations.find((item) => item.conflictStatus !== "none")?.conflictStatus;
          return <button key={group.id} type="button" className="app-skills-row" onClick={() => { setDetailTab("content"); setSelected(group.id); }}>
            <div className="app-skills-row-body">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-sm">{skill.name}</span>
                {[...new Set(group.locations.map((item) => item.scope))].map((value) => <Tag key={value}>{scopeLabel(value)}</Tag>)}
                {!group.locations.some((item) => item.enabled) && <Tag>{t("common.disabled")}</Tag>}
                {group.locations.some(isSkillLinked) && <Tag>{t("settings.skills.connectionLinked")}</Tag>}
                {conflict && <Tag color={conflict === "runtime-conflict" ? "error" : "default"}>{t(`settings.skills.${conflict === "identical-copy" ? "identicalCopy" : conflict === "runtime-conflict" ? "runtimeConflict" : "divergedCopy"}`)}</Tag>}
              </div>
              <p className="app-skills-secondary text-xs mt-1 mb-0 line-clamp-1">{skill.description || t("settings.shared.noDescription")}</p>
            </div>
            <span className="app-skills-secondary text-xs shrink-0">{t("settings.skills.manageSkill")}</span>
          </button>;
        })}
      {filtered.length > PAGE_SIZE && <div className="flex justify-end p-4"><Pagination current={currentPage} total={filtered.length} pageSize={PAGE_SIZE} showSizeChanger={false} onChange={setPage} /></div>}
    </div>}

    <Modal title={selectedGroup?.skill.name ?? t("settings.skills.detailTitle")} open={!!selectedGroup} width={1040}
      centered className="app-skills-detail-modal" footer={discardIntent ? <Alert type="warning" showIcon
        message={t("settings.skills.editor.discardPrompt")} action={<div className="flex gap-2">
          <Button onClick={() => setDiscardIntent(null)}>{t("settings.skills.editor.keepEditing")}</Button>
          <Button danger onClick={discardChanges}>{t(`settings.skills.editor.${discardIntent === "reload" ? "discardReload" : "discardClose"}`)}</Button>
        </div>} /> : null}
      onCancel={closeDetail} closable={!saving} maskClosable={!saving} keyboard={!saving} destroyOnClose={false}>
      {selectedGroup && catalog && <div className="app-skills-detail">
        {selectedGroup.skill.description && <p className="app-skills-secondary text-sm mb-3 line-clamp-2">{selectedGroup.skill.description}</p>}
        <Tabs activeKey={detailTab} onChange={setDetailTab} items={[
          {
            key: "content",
            label: t("settings.skills.contentTab"),
            children: editor && selectedLocation ? <SkillContentEditor editorKey={editorKey} editor={editor} skill={selectedLocation}
                  saving={saving || detailLoading} conflict={saveConflict} onSave={() => void saveContent()}
                  onReload={() => editorDirty ? setDiscardIntent("reload") : void reloadContent()} />
                : detailLoading ? <div className="flex justify-center py-10"><Spin /></div>
                  : <Empty description={t("settings.skills.loadDetailFailed")} />,
          },
          {
            key: "management",
            label: t("settings.skills.managementTab"),
            children: <div className="space-y-5">
              <div><div className="app-skills-muted text-xs mb-2">{t("settings.skills.realFile")}</div><p className="app-skills-path">{selectedGroup.id}</p></div>
              <div>
                <h3 className="text-sm font-medium mb-2">{t("settings.skills.connections")}</h3>
                <p className="app-skills-muted text-xs mb-3">{t("settings.skills.discoveryHint")}</p>
                {SKILL_AGENTS.map((id) => {
                  const location = selectedGroup.locations.find((item) => item.enabled && item.effectiveAgents.includes(id))
                    ?? selectedGroup.locations.find((item) => item.effectiveAgents.includes(id));
                  const copy = catalog.skills.find((item) => item.name === selectedGroup.skill.name && item.resolvedFilePath !== selectedGroup.id
                    && item.contentFingerprint === selectedGroup.skill.contentFingerprint && item.effectiveAgents.includes(id) && item.enabled);
                  const connection = location ? (isSkillLinked(location) ? "connectionLinked" : "connectionDirect") : copy ? "connectionCopy" : "connectionNone";
                  return <div key={id} className="app-skills-connection">
                    <span className="inline-flex items-center gap-2 text-sm"><AgentIcon agentId={id} size={16} />{label(id)}</span>
                    <span><Tag>{t(`settings.skills.${connection}`)}</Tag>{location && !location.enabled && <Tag>{t("common.disabled")}</Tag>}</span>
                  </div>;
                })}
              </div>
              <div>
                <h3 className="text-sm font-medium mb-3">{t("settings.skills.entryManagement")}</h3>
                {selectedGroup.locations.map((skill) => <div key={`${skill.id}:${skill.enabled}`} className="app-skills-entry">
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <span className="text-xs">{scopeLabel(skill.scope)} · {isSkillLinked(skill) ? t("settings.skills.connectionLinked") : t("settings.skills.connectionDirect")}</span>
                    <Tooltip title={editorDirty ? t("settings.skills.editor.saveBeforeToggle") : skillToggleBlocked(skill, catalog) ? t("settings.skills.linkedSourceProtected") : undefined}>
                      <span><Switch checked={skill.enabled} loading={busy === skill.id} disabled={!!busy || saving || editorDirty || skillToggleBlocked(skill, catalog)}
                        checkedChildren={t("common.enabled")} unCheckedChildren={t("common.disabled")} onChange={(value) => void toggle(skill, value)} /></span>
                    </Tooltip>
                  </div>
                  <p className="app-skills-path">{skill.filePath}</p>
                  <p className="app-skills-muted text-xs my-2">{t("settings.skills.toggleAffects", { agents: skill.effectiveAgents.map(label).join(", ") })}</p>
                  <Button size="small" icon={<FolderOpenOutlined />} onClick={() => void openFolder(skill.filePath.replace(/[\\/]SKILL\.md$/i, ""))}>{t("settings.skills.openSkillDirectory")}</Button>
                </div>)}
              </div>
              {selectedGroup.locations.some((item) => item.conflictingPaths.length > 1) && <div>
                <h3 className="text-sm font-medium mb-2">{t("settings.skills.relatedCopies")}</h3>
                {[...new Set(selectedGroup.locations.flatMap((item) => item.conflictingPaths))].map((path) => <p className="app-skills-path mb-2" key={path}>{path}</p>)}
              </div>}
            </div>,
          },
        ]} />
      </div>}
    </Modal>

    <Modal title={t("settings.skills.addSkill")} open={addOpen} onCancel={() => !installing && setAddOpen(false)} onOk={() => void submit()}
      confirmLoading={installing} closable={!installing} maskClosable={!installing} keyboard={!installing}
      okText={t(mode === "create" ? "common.create" : "settings.skills.importLocal")}
      okButtonProps={{ disabled: !targets.length || !preview.length || (mode === "create" ? !name.trim() : !source) }}>
      <div className="space-y-4 app-skills-detail">
        <Segmented block disabled={installing} value={mode} onChange={(value) => setMode(value as typeof mode)} options={[
          { value: "create", label: t("settings.skills.newSkill") }, { value: "import", label: t("settings.skills.importLocal") },
        ]} />
        <div><label className="app-skills-field-label">{t("settings.skills.skillScope")}</label>
          <Segmented block disabled={installing} value={addScope} onChange={(value) => setAddScope(value as SkillScope)} options={[
            { value: "workspace", label: t("settings.scope.workspace"), disabled: !projectPath }, { value: "user", label: t("settings.scope.user") },
          ]} /></div>
        <div><label className="app-skills-field-label">{t("settings.skills.targetAgents")}</label>
          <Select mode="multiple" className="w-full" aria-label={t("settings.skills.targetAgents")} value={targets} disabled={installing} onChange={setTargets}
            options={SKILL_AGENTS.map((id) => ({ value: id, label: label(id) }))} /></div>
        {mode === "create" ? <>
          <div><label className="app-skills-field-label" htmlFor="skill-name">{t("settings.skills.skillName")}</label>
            <Input id="skill-name" disabled={installing} value={name} onChange={(event) => setName(event.target.value)} placeholder={t("settings.skills.skillNamePlaceholder")} /></div>
          <div><label className="app-skills-field-label" htmlFor="skill-description">{t("settings.shared.description")}</label>
            <Input.TextArea id="skill-description" disabled={installing} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("settings.skills.skillDescriptionPlaceholder")} /></div>
        </> : <div>
          <Button disabled={installing} icon={<FolderOpenOutlined />} onClick={async () => {
            try { const path = await selectSkillImportDirectory(); if (path) setSource(path); } catch (reason) { failure(reason); }
          }}>{t("settings.skills.selectImportDirectory")}</Button>
          <p className="app-skills-path mt-2">{source ?? t("settings.skills.importDirectoryHint")}</p>
        </div>}
        <div className="app-skills-entry">
          <h3 className="text-sm font-medium mb-2">{t("settings.skills.installPreview")}</h3>
          <p className="app-skills-secondary text-xs mb-2">{t("settings.skills.copyInstallHint")}</p>
          {preview.map((target) => <p className="app-skills-path mb-2" key={target.path}>{target.path}/{skillFolderName(name, mode === "import" ? source : null)}</p>)}
          <p className="app-skills-secondary text-xs">{t("settings.skills.toggleAffects", { agents: consumers.map(label).join(", ") || t("settings.skills.selectTargets") })}</p>
        </div>
      </div>
    </Modal>
  </div>;
}
