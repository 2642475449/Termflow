import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpenOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Alert, Button, Drawer, Empty, Input, Modal, Pagination, Segmented, Select, Spin, Switch, Tag, Tooltip, message } from "antd";
import { useTranslation } from "react-i18next";
import { AgentIcon } from "@/components/AgentIcon";
import { useAppStore } from "@/store";
import { useSkillsStore } from "@/store/slices/skillsSlice";
import { getAgentIdsWithCapability } from "@/lib/agents";
import { ensureSkillDirectory, getSkillDetail, installSkill, listSkills, openInFileManager, selectSkillImportDirectory, setSkillEnabled } from "@/lib/api";
import { filterSkillGroups, groupSkills, isSkillLinked, skillFolderName, skillInstallTargets, skillToggleBlocked } from "@/lib/skills";
import type { SkillAgent, SkillInfo, SkillScope } from "@/types";

const SKILL_AGENTS = getAgentIdsWithCapability("skills");
const PAGE_SIZE = 10;

export function SkillsSettingsPage() {
  const { t } = useTranslation();
  const projectPath = useAppStore((state) => state.currentProject?.path ?? null);
  const { catalog, loading, error } = useSkillsStore();
  const [scope, setScope] = useState<"all" | SkillScope>("all");
  const [agent, setAgent] = useState<"all" | SkillAgent>("all");
  const [status, setStatus] = useState<"all" | "enabled" | "disabled">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
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
  const requestId = useRef(0);
  const detailId = useRef(0);
  const label = (id: SkillAgent) => t(`settings.skills.agents.${id}`);
  const scopeLabel = (value: SkillScope) => t(`settings.scope.${value === "workspace" ? "workspaceShort" : "userShort"}`);
  const failure = (reason: unknown) => message.error(t("settings.skills.operationFailed", { reason: String(reason) }));

  const refresh = useCallback(async () => {
    if (useSkillsStore.getState().projectPath !== projectPath) return;
    const request = ++requestId.current;
    useSkillsStore.getState().setLoading(projectPath, true);
    try {
      const next = await listSkills(projectPath);
      if (request === requestId.current) useSkillsStore.getState().setCatalog(projectPath, next);
    } catch (reason) {
      if (request === requestId.current) {
        useSkillsStore.getState().setLoading(projectPath, false, true);
        message.error(t("settings.skills.loadFailed"));
        console.error("Failed to load skills", reason);
      }
    } finally {
      if (request === requestId.current && !useSkillsStore.getState().error) {
        useSkillsStore.getState().setLoading(projectPath, false);
      }
    }
  }, [projectPath, t]);

  useEffect(() => {
    useSkillsStore.getState().setProject(projectPath);
    setSelected(null);
    setAddOpen(false);
    setScope("all");
    setPage(1);
    void refresh();
    return () => { requestId.current++; detailId.current++; };
  }, [projectPath, refresh]);

  const groups = useMemo(() => groupSkills(catalog?.skills ?? []), [catalog]);
  const filtered = filterSkillGroups(groups, search, agent, scope, status);
  const selectedGroup = groups.find((group) => group.id === selected);
  const selectedLocation = selectedGroup?.locations[0];
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)));
  const preview = skillInstallTargets(catalog, targets, addScope);
  const consumers = [...new Set(preview.flatMap((target) => target.consumers))];

  useEffect(() => {
    const request = ++detailId.current;
    setContent(null);
    if (!selectedLocation) { setDetailLoading(false); return; }
    setDetailLoading(true);
    void getSkillDetail(selectedLocation.agent, selectedLocation.scope, selectedLocation.folderName, selectedLocation.enabled, projectPath)
      .then((detail) => { if (request === detailId.current) setContent(detail.content); })
      .catch((reason: unknown) => {
        if (request === detailId.current) {
          message.error(t("settings.skills.loadDetailFailed"));
          console.error("Failed to read skill", reason);
        }
      }).finally(() => { if (request === detailId.current) setDetailLoading(false); });
    return () => { detailId.current++; };
  }, [selectedLocation, projectPath, t]);

  async function openFolder(path: string) {
    try { await openInFileManager(path); } catch (reason) { failure(reason); }
  }

  async function toggle(skill: SkillInfo, enabled: boolean) {
    if (!catalog || skillToggleBlocked(skill, catalog)) return;
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
      setSelected(installed[0]?.resolvedFilePath ?? null);
      message.success(t("settings.skills.installSuccess"));
    } catch (reason) { failure(reason); }
    finally { setInstalling(false); }
  }

  const changeFilter = () => setPage(1);
  return <div className="app-skills-library">
    <div className="app-skills-toolbar">
      <div>
        <h2 className="app-skills-title">{t("settings.menu.skills")} <span className="app-skills-muted">{groups.length}</span></h2>
        <p className="app-skills-muted text-xs mt-1">{t("settings.skills.libraryDescription")}</p>
      </div>
      <div className="flex gap-2">
        <Button icon={<ReloadOutlined spin={loading} />} onClick={() => void refresh()}>{t("common.refresh")}</Button>
        <Button type="primary" icon={<PlusOutlined />} disabled={!catalog} onClick={openAdd}>{t("settings.skills.addSkill")}</Button>
      </div>
    </div>
    <div className="app-skills-filters">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented value={scope} onChange={(value) => { setScope(value as typeof scope); changeFilter(); }} options={[
          { value: "all", label: `${t("settings.skills.allScopes")} (${groups.length})` },
          { value: "workspace", label: `${scopeLabel("workspace")} (${groups.filter((group) => group.locations.some((item) => item.scope === "workspace")).length})`, disabled: !projectPath },
          { value: "user", label: `${scopeLabel("user")} (${groups.filter((group) => group.locations.some((item) => item.scope === "user")).length})` },
        ]} />
        <Input className="app-skills-search" allowClear prefix={<SearchOutlined />} placeholder={t("settings.skills.searchPlaceholder")}
          value={search} onChange={(event) => { setSearch(event.target.value); changeFilter(); }} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Select className="app-skills-agent-filter" aria-label={t("settings.skills.filterByAgent")} value={agent}
          onChange={(value) => { setAgent(value); changeFilter(); }} options={[
            { value: "all", label: t("settings.skills.allAgents") },
            ...SKILL_AGENTS.map((id) => ({ value: id, label: <span className="inline-flex items-center gap-2"><AgentIcon agentId={id} size={14} />{label(id)}</span> })),
          ]} />
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
          const available = [...new Set(group.locations.filter((item) => item.enabled).flatMap((item) => item.effectiveAgents))];
          const conflict = group.locations.find((item) => item.conflictStatus !== "none")?.conflictStatus;
          return <button key={group.id} type="button" className="app-skills-row" onClick={() => setSelected(group.id)}>
            <div className="app-skills-row-body">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-sm">{skill.name}</span>
                {[...new Set(group.locations.map((item) => item.scope))].map((value) => <Tag key={value}>{scopeLabel(value)}</Tag>)}
                {!group.locations.some((item) => item.enabled) && <Tag>{t("common.disabled")}</Tag>}
                {group.locations.some(isSkillLinked) && <Tag>{t("settings.skills.connectionLinked")}</Tag>}
                {conflict && <Tag color={conflict === "runtime-conflict" ? "error" : "default"}>{t(`settings.skills.${conflict === "identical-copy" ? "identicalCopy" : conflict === "runtime-conflict" ? "runtimeConflict" : "divergedCopy"}`)}</Tag>}
              </div>
              <p className="app-skills-secondary text-xs mt-2 line-clamp-2">{skill.description || t("settings.shared.noDescription")}</p>
              <div className="app-skills-muted text-xs mt-2 flex flex-wrap items-center gap-2">
                <span>{t("settings.skills.availableTo")}</span>
                {available.length ? available.map((id) => <span key={id} className="inline-flex items-center gap-1"><AgentIcon agentId={id} size={13} />{label(id)}</span>) : <span>{t("common.disabled")}</span>}
              </div>
              <p className="app-skills-path mt-2">{skill.resolvedFilePath}</p>
            </div>
            <span className="app-skills-secondary text-xs shrink-0">{t("settings.skills.manageSkill")}</span>
          </button>;
        })}
      {filtered.length > PAGE_SIZE && <div className="flex justify-end p-4"><Pagination current={currentPage} total={filtered.length} pageSize={PAGE_SIZE} showSizeChanger={false} onChange={setPage} /></div>}
    </div>}

    <Drawer title={selectedGroup?.skill.name ?? t("settings.skills.detailTitle")} open={!!selectedGroup} width={640}
      onClose={() => setSelected(null)} destroyOnClose={false}>
      {selectedGroup && catalog && <div className="space-y-5 app-skills-detail">
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
              <Tooltip title={skillToggleBlocked(skill, catalog) ? t("settings.skills.linkedSourceProtected") : undefined}>
                <span><Switch checked={skill.enabled} loading={busy === skill.id} disabled={!!busy || skillToggleBlocked(skill, catalog)}
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
        {detailLoading ? <Spin /> : content !== null && <pre className="app-skills-content">{content}</pre>}
      </div>}
    </Drawer>

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
