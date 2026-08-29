import { useCallback, useState } from "react";
import {
  CheckOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import { Button, Input, Modal, Switch, Tag, Tooltip, message } from "antd";
import { useTranslation } from "react-i18next";
import type { GitCommitMessageProfile } from "@/types";
import { useAppStore } from "@/store";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";
import { GitIcon } from "@/components/GitIcon";

/** Manages the reusable AI commit-message profiles used by the Git workspace. */
export function GitSettingsPage() {
  const { t } = useTranslation();
  const gitCommitMessageProfiles = useAppStore((state) => state.gitCommitMessageProfiles);
  const defaultGitCommitMessageProfileId = useAppStore(
    (state) => state.defaultGitCommitMessageProfileId,
  );
  const setGitCommitMessageProfiles = useAppStore(
    (state) => state.setGitCommitMessageProfiles,
  );
  const [profileEditorOpen, setProfileEditorOpen] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [profileName, setProfileName] = useState("");
  const [profileInstructions, setProfileInstructions] = useState("");
  const [makeProfileDefault, setMakeProfileDefault] = useState(false);
  const [deleteProfileId, setDeleteProfileId] = useState<string | null>(null);

  const openProfileEditor = useCallback((profile?: GitCommitMessageProfile) => {
    setEditingProfileId(profile?.id ?? null);
    setProfileName(profile?.name ?? "");
    setProfileInstructions(profile?.instructions ?? "");
    setMakeProfileDefault(profile ? profile.id === defaultGitCommitMessageProfileId : false);
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
    setGitCommitMessageProfiles(
      nextProfiles,
      makeProfileDefault ? id : defaultGitCommitMessageProfileId,
    );
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
    const nextProfiles = gitCommitMessageProfiles.filter((profile) => profile.id !== deleteProfileId);
    setGitCommitMessageProfiles(
      nextProfiles,
      deleteProfileId === defaultGitCommitMessageProfileId ? nextProfiles[0].id : defaultGitCommitMessageProfileId,
    );
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
        title={t("settings.menu.git")}
        description={t("settings.agents.gitProfiles.description")}
      />
      <div className="app-glass-card rounded-xl px-4 py-4" style={{ background: "var(--cs-bg-card)", border: "1px solid var(--cs-border-card)" }}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <GitIcon className="mt-0.5 text-lg" style={{ color: "var(--cs-primary)" }} />
            <div>
              <div className="text-sm font-medium" style={{ color: "var(--cs-text-primary)" }}>
                {t("settings.agents.gitProfiles.title")}
              </div>
              <div className="mt-1 text-xs" style={{ color: "var(--cs-text-tertiary)" }}>
                {t("settings.agents.gitProfiles.description")}
              </div>
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
              <div key={profile.id} className="flex min-w-0 items-center gap-3 rounded-lg px-3 py-2" style={{ background: "var(--cs-bg-hover)", border: "1px solid var(--cs-border-sidebar)" }}>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="text-sm font-medium" style={{ color: "var(--cs-text-primary)" }}>{profile.name}</span>
                    {isDefault && <Tag icon={<CheckOutlined />} color="processing" className="!m-0">{t("settings.agents.gitProfiles.default")}</Tag>}
                  </div>
                  <Tooltip title={profile.instructions} placement="topLeft">
                    <div className="mt-0.5 truncate text-xs leading-4" style={{ color: "var(--cs-text-tertiary)" }}>
                      {profile.instructions.replace(/\s+/g, " ")}
                    </div>
                  </Tooltip>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {!isDefault && <Tooltip title={t("settings.agents.gitProfiles.setDefault")}><Button type="text" size="small" icon={<CheckOutlined />} onClick={() => setDefaultProfile(profile.id)} /></Tooltip>}
                  <Tooltip title={t("common.edit", { defaultValue: "编辑" })}><Button type="text" size="small" icon={<EditOutlined />} onClick={() => openProfileEditor(profile)} /></Tooltip>
                  <Tooltip title={gitCommitMessageProfiles.length <= 1 ? t("settings.agents.gitProfiles.keepOne") : t("common.delete", { defaultValue: "删除" })}>
                    <Button type="text" danger size="small" icon={<DeleteOutlined />} disabled={gitCommitMessageProfiles.length <= 1} onClick={() => setDeleteProfileId(profile.id)} />
                  </Tooltip>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <Modal open={profileEditorOpen} title={t(editingProfileId ? "settings.agents.gitProfiles.editTitle" : "settings.agents.gitProfiles.createTitle")} okText={t("settings.agents.gitProfiles.save")} cancelText={t("common.cancel", { defaultValue: "取消" })} onOk={saveProfile} onCancel={() => setProfileEditorOpen(false)} destroyOnHidden>
        <div className="space-y-4 pt-2">
          <div><div className="mb-1 text-xs" style={{ color: "var(--cs-text-secondary)" }}>{t("settings.agents.gitProfiles.name")}</div><Input value={profileName} maxLength={80} placeholder={t("settings.agents.gitProfiles.namePlaceholder")} onChange={(event) => setProfileName(event.target.value)} /></div>
          <div>
            <div className="mb-1 text-xs" style={{ color: "var(--cs-text-secondary)" }}>{t("settings.agents.gitProfiles.instructions")}</div>
            <Input.TextArea value={profileInstructions} maxLength={6000} autoSize={{ minRows: 6, maxRows: 12 }} showCount placeholder={t("settings.agents.gitProfiles.instructionsPlaceholder")} onChange={(event) => setProfileInstructions(event.target.value)} />
            <div className="mt-1 text-xs" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.agents.gitProfiles.instructionsHint")}</div>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg px-3 py-2" style={{ background: "var(--cs-bg-hover)" }}>
            <span className="text-sm" style={{ color: "var(--cs-text-secondary)" }}>{t("settings.agents.gitProfiles.makeDefault")}</span>
            <Switch checked={makeProfileDefault} disabled={editingProfileId === defaultGitCommitMessageProfileId} onChange={setMakeProfileDefault} />
          </div>
        </div>
      </Modal>
      <Modal open={deleteProfileId !== null} title={t("settings.agents.gitProfiles.deleteTitle")} okText={t("common.delete", { defaultValue: "删除" })} cancelText={t("common.cancel", { defaultValue: "取消" })} okButtonProps={{ danger: true }} onOk={confirmDeleteProfile} onCancel={() => setDeleteProfileId(null)}>
        {t("settings.agents.gitProfiles.deleteDescription")}
      </Modal>
    </div>
  );
}
