import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircleFilled,
  CloseCircleFilled,
  CodeOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  StarFilled,
} from "@ant-design/icons";
import { Button, Input, Modal, Spin, Switch, Tag, Tooltip, message } from "antd";
import { useTranslation } from "react-i18next";
import { inspectAgentClis } from "@/lib/api";
import {
  AGENT_DEFINITIONS,
  AI_AGENT_ORDER,
  formatAgentVersion,
} from "@/lib/agents";
import type { AgentCliInfo, GitCommitMessageProfile } from "@/types";
import { AgentIcon } from "@/components/AgentIcon";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";
import { useAppStore } from "@/store";


export function AgentsPage() {
  const { t, i18n } = useTranslation();
  const defaultAgentId = useAppStore((state) => state.defaultAgentId);
  const setDefaultAgentId = useAppStore((state) => state.setDefaultAgentId);
  const gitCommitMessageProfiles = useAppStore((state) => state.gitCommitMessageProfiles);
  const defaultGitCommitMessageProfileId = useAppStore(
    (state) => state.defaultGitCommitMessageProfileId,
  );
  const setGitCommitMessageProfiles = useAppStore(
    (state) => state.setGitCommitMessageProfiles,
  );
  const [agents, setAgents] = useState<AgentCliInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [profileName, setProfileName] = useState("");
  const [profileInstructions, setProfileInstructions] = useState("");
  const [makeProfileDefault, setMakeProfileDefault] = useState(false);
  const [deleteProfileId, setDeleteProfileId] = useState<string | null>(null);

  const refresh = useCallback(async (showSuccess = false) => {
    setLoading(true);
    try {
      const result = await inspectAgentClis({ forceRefresh: showSuccess });
      setAgents([...result].sort(
        (left, right) =>
          AI_AGENT_ORDER.indexOf(left.id) - AI_AGENT_ORDER.indexOf(right.id),
      ));
      if (showSuccess) message.success(t("settings.agents.refreshSuccess"));
    } catch (error) {
      console.error("Failed to inspect agent CLIs:", error);
      message.error(t("settings.agents.refreshFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const installedCount = useMemo(
    () => agents.filter((agent) => agent.installed).length,
    [agents],
  );
  const checkedAt = agents[0]?.checkedAt;
  const defaultAgent = agents.find((agent) => agent.id === defaultAgentId) ?? null;

  const selectDefaultAgent = useCallback((agent: AgentCliInfo) => {
    if (!agent.installed) return;
    setDefaultAgentId(agent.id);
    message.success(t("settings.agents.defaultChanged", {
      name: AGENT_DEFINITIONS[agent.id].displayName,
    }));
  }, [setDefaultAgentId, t]);

  const openProfileEditor = useCallback((profile?: GitCommitMessageProfile) => {
    setEditingProfileId(profile?.id ?? null);
    setProfileName(profile?.name ?? "");
    setProfileInstructions(profile?.instructions ?? "");
    setMakeProfileDefault(
      profile ? profile.id === defaultGitCommitMessageProfileId : false,
    );
    setProfileEditorOpen(true);
  }, [defaultGitCommitMessageProfileId]);

  const saveProfile = useCallback(() => {
    const name = profileName.trim();
    const instructions = profileInstructions.trim();
    if (!name) {
      message.warning(t("settings.agents.gitProfiles.nameRequired"));
      return;
    }
    if (!instructions) {
      message.warning(t("settings.agents.gitProfiles.instructionsRequired"));
      return;
    }
    if (gitCommitMessageProfiles.some(
      (profile) => profile.id !== editingProfileId && profile.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    )) {
      message.warning(t("settings.agents.gitProfiles.nameDuplicate"));
      return;
    }

    const id = editingProfileId ?? (
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `profile-${Date.now()}`
    );
    const nextProfile = { id, name: name.slice(0, 80), instructions: instructions.slice(0, 6000) };
    const nextProfiles = editingProfileId
      ? gitCommitMessageProfiles.map((profile) => profile.id === editingProfileId ? nextProfile : profile)
      : [...gitCommitMessageProfiles, nextProfile];
    const nextDefaultId = makeProfileDefault ? id : defaultGitCommitMessageProfileId;

    setGitCommitMessageProfiles(nextProfiles, nextDefaultId);
    setProfileEditorOpen(false);
    message.success(t("settings.agents.gitProfiles.saved"));
  }, [
    defaultGitCommitMessageProfileId,
    editingProfileId,
    gitCommitMessageProfiles,
    makeProfileDefault,
    profileInstructions,
    profileName,
    setGitCommitMessageProfiles,
    t,
  ]);

  const setDefaultProfile = useCallback((profileId: string) => {
    setGitCommitMessageProfiles(gitCommitMessageProfiles, profileId);
    message.success(t("settings.agents.gitProfiles.defaultChanged"));
  }, [gitCommitMessageProfiles, setGitCommitMessageProfiles, t]);

  const confirmDeleteProfile = useCallback(() => {
    if (!deleteProfileId || gitCommitMessageProfiles.length <= 1) return;
    const nextProfiles = gitCommitMessageProfiles.filter(
      (profile) => profile.id !== deleteProfileId,
    );
    const nextDefaultId = deleteProfileId === defaultGitCommitMessageProfileId
      ? nextProfiles[0].id
      : defaultGitCommitMessageProfileId;
    setGitCommitMessageProfiles(nextProfiles, nextDefaultId);
    setDeleteProfileId(null);
    message.success(t("settings.agents.gitProfiles.deleted"));
  }, [
    defaultGitCommitMessageProfileId,
    deleteProfileId,
    gitCommitMessageProfiles,
    setGitCommitMessageProfiles,
    t,
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <SettingsPageHeader
        title={t("settings.agents.title")}
        description={t("settings.agents.subtitle")}
        actions={
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh(true)}>
            {t("settings.agents.refresh")}
          </Button>
        }
      />

      <div
        className="app-glass-card mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3"
        style={{ background: "var(--cs-bg-card)", border: "1px solid var(--cs-border-card)" }}
      >
        <div className="flex items-center gap-2 text-sm" style={{ color: "var(--cs-text-secondary)" }}>
          <CodeOutlined style={{ color: "var(--cs-primary)" }} />
          <span>{t("settings.agents.summary", {
            installed: installedCount,
            total: agents.length || AI_AGENT_ORDER.length,
          })}</span>
        </div>
        {checkedAt && (
          <span className="text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
            {t("settings.agents.checkedAt", {
              time: new Intl.DateTimeFormat(i18n.resolvedLanguage, {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              }).format(checkedAt),
            })}
          </span>
        )}
      </div>

      <div
        className="app-glass-card mb-4 rounded-xl px-4 py-3"
        style={{ background: "var(--cs-bg-card)", border: "1px solid var(--cs-border-card)" }}
      >
        <div className="text-sm font-medium" style={{ color: "var(--cs-text-primary)" }}>
          {t("settings.agents.defaultTitle")}
        </div>
        <div className="mt-1 text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
          {defaultAgent?.installed
            ? t("settings.agents.defaultCurrent", {
                name: AGENT_DEFINITIONS[defaultAgent.id].displayName,
              })
            : defaultAgentId
              ? t("settings.agents.defaultUnavailable")
              : t("settings.agents.defaultMissing")}
        </div>
      </div>

      {loading && agents.length === 0 ? (
        <div className="flex min-h-64 items-center justify-center"><Spin /></div>
      ) : (
        <div
          className="grid gap-4"
          style={{
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))",
          }}
        >
          {agents.map((agent) => {
            const definition = AGENT_DEFINITIONS[agent.id];
            return (
              <div
                key={agent.id}
                className="app-glass-card min-w-0 rounded-xl p-5"
                style={{
                  background: "var(--cs-bg-card)",
                  border: "1px solid var(--cs-border-card)",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
                }}
              >
                <div className="mb-5 flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <div
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-lg font-bold text-white"
                      style={{
                        background: `${definition.brandColor}16`,
                        border: `1px solid ${definition.brandColor}32`,
                      }}
                    >
                      <AgentIcon agentId={agent.id} size={25} />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-base font-semibold" style={{ color: "var(--cs-text-primary)" }}>
                        {definition.displayName}
                      </div>
                      <code className="text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
                        {definition.command}
                      </code>
                    </div>
                  </div>
                  <Tag
                    icon={agent.installed ? <CheckCircleFilled /> : <CloseCircleFilled />}
                    color={agent.installed ? "success" : "default"}
                    className="m-0 shrink-0"
                  >
                    {t(agent.installed ? "settings.agents.installed" : "settings.agents.notInstalled")}
                  </Tag>
                </div>

                <div className="space-y-4">
                  <AgentDetail label={t("settings.agents.version")}>
                    {formatAgentVersion(agent.version, definition.displayName) || t("settings.agents.unknown")}
                  </AgentDetail>
                  <AgentDetail label={t("settings.agents.path")}>
                    {agent.executablePath ? (
                      <Tooltip title={agent.executablePath} placement="bottomLeft">
                        <div className="truncate font-mono text-[11px]">{agent.executablePath}</div>
                      </Tooltip>
                    ) : t("settings.agents.notFoundInPath")}
                  </AgentDetail>
                </div>


                {agent.error && (
                  <Tooltip title={agent.error}>
                    <div
                      className="mt-4 truncate rounded-lg px-3 py-2 text-[11px]"
                      style={{ background: "var(--cs-danger-hover)", color: "var(--cs-danger)" }}
                    >
                      {t("settings.agents.versionError")}: {agent.error}
                    </div>
                  </Tooltip>
                )}

                <Button
                  block
                  className="mt-4"
                  type={defaultAgentId === agent.id ? "primary" : "default"}
                  disabled={!agent.installed || defaultAgentId === agent.id}
                  onClick={() => selectDefaultAgent(agent)}
                >
                  {t(defaultAgentId === agent.id
                    ? "settings.agents.defaultActive"
                    : "settings.agents.setDefault")}
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <div
        className="app-glass-card mt-5 rounded-xl px-4 py-4"
        style={{ background: "var(--cs-bg-card)", border: "1px solid var(--cs-border-card)" }}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium" style={{ color: "var(--cs-text-primary)" }}>
              {t("settings.agents.gitProfiles.title")}
            </div>
            <div className="mt-1 text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
              {t("settings.agents.gitProfiles.description")}
            </div>
          </div>
          <Button icon={<PlusOutlined />} onClick={() => openProfileEditor()}>
            {t("settings.agents.gitProfiles.add")}
          </Button>
        </div>

        <div className="mt-3 space-y-1.5">
          {gitCommitMessageProfiles.map((profile) => {
            const isDefault = profile.id === defaultGitCommitMessageProfileId;
            return (
              <div
                key={profile.id}
                className="flex min-w-0 items-center gap-3 rounded-lg px-3 py-2"
                style={{ background: "var(--cs-bg-hover)", border: "1px solid var(--cs-border-sidebar)" }}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="text-sm font-medium" style={{ color: "var(--cs-text-primary)" }}>
                      {profile.name}
                    </span>
                    {isDefault && (
                      <Tag icon={<StarFilled />} color="processing" className="!m-0">
                        {t("settings.agents.gitProfiles.default")}
                      </Tag>
                    )}
                  </div>
                  <Tooltip title={profile.instructions} placement="topLeft">
                    <div
                      className="mt-0.5 truncate text-xs leading-4"
                      style={{ color: "var(--cs-text-tertiary)" }}
                    >
                      {profile.instructions.replace(/\s+/g, " ")}
                    </div>
                  </Tooltip>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {!isDefault && (
                    <Tooltip title={t("settings.agents.gitProfiles.setDefault")}>
                      <Button
                        type="text"
                        size="small"
                        icon={<StarFilled />}
                        onClick={() => setDefaultProfile(profile.id)}
                      />
                    </Tooltip>
                  )}
                  <Tooltip title={t("common.edit", { defaultValue: "编辑" })}>
                    <Button
                      type="text"
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => openProfileEditor(profile)}
                    />
                  </Tooltip>
                  <Tooltip
                    title={gitCommitMessageProfiles.length <= 1
                      ? t("settings.agents.gitProfiles.keepOne")
                      : t("common.delete", { defaultValue: "删除" })}
                  >
                    <Button
                      type="text"
                      danger
                      size="small"
                      icon={<DeleteOutlined />}
                      disabled={gitCommitMessageProfiles.length <= 1}
                      onClick={() => setDeleteProfileId(profile.id)}
                    />
                  </Tooltip>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-5 text-xs leading-5" style={{ color: "var(--cs-text-tertiary)" }}>
        {t("settings.agents.pathHint")}
      </div>

      <Modal
        open={profileEditorOpen}
        title={t(editingProfileId
          ? "settings.agents.gitProfiles.editTitle"
          : "settings.agents.gitProfiles.createTitle")}
        okText={t("settings.agents.gitProfiles.save")}
        cancelText={t("common.cancel", { defaultValue: "取消" })}
        onOk={saveProfile}
        onCancel={() => setProfileEditorOpen(false)}
        destroyOnHidden
      >
        <div className="space-y-4 pt-2">
          <div>
            <div className="mb-1 text-xs" style={{ color: "var(--cs-text-secondary)" }}>
              {t("settings.agents.gitProfiles.name")}
            </div>
            <Input
              value={profileName}
              maxLength={80}
              placeholder={t("settings.agents.gitProfiles.namePlaceholder")}
              onChange={(event) => setProfileName(event.target.value)}
            />
          </div>
          <div>
            <div className="mb-1 text-xs" style={{ color: "var(--cs-text-secondary)" }}>
              {t("settings.agents.gitProfiles.instructions")}
            </div>
            <Input.TextArea
              value={profileInstructions}
              maxLength={6000}
              autoSize={{ minRows: 6, maxRows: 12 }}
              showCount
              placeholder={t("settings.agents.gitProfiles.instructionsPlaceholder")}
              onChange={(event) => setProfileInstructions(event.target.value)}
            />
            <div className="mt-1 text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
              {t("settings.agents.gitProfiles.instructionsHint")}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg px-3 py-2" style={{ background: "var(--cs-bg-hover)" }}>
            <span className="text-sm" style={{ color: "var(--cs-text-secondary)" }}>
              {t("settings.agents.gitProfiles.makeDefault")}
            </span>
            <Switch
              checked={makeProfileDefault}
              disabled={editingProfileId === defaultGitCommitMessageProfileId}
              onChange={setMakeProfileDefault}
            />
          </div>
        </div>
      </Modal>

      <Modal
        open={deleteProfileId !== null}
        title={t("settings.agents.gitProfiles.deleteTitle")}
        okText={t("common.delete", { defaultValue: "删除" })}
        cancelText={t("common.cancel", { defaultValue: "取消" })}
        okButtonProps={{ danger: true }}
        onOk={confirmDeleteProfile}
        onCancel={() => setDeleteProfileId(null)}
      >
        {t("settings.agents.gitProfiles.deleteDescription")}
      </Modal>
    </div>
  );
}

function AgentDetail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[11px]" style={{ color: "var(--cs-text-tertiary)" }}>{label}</div>
      <div className="truncate text-sm" style={{ color: "var(--cs-text-secondary)" }}>{children}</div>
    </div>
  );
}
