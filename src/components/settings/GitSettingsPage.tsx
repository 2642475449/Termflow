import { useCallback, useMemo, useState } from "react";
import {
  CheckOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import { Button, Input, Modal, Switch, Tag, Tooltip, message } from "antd";
import { useTranslation } from "react-i18next";
import type { GitCommitMessageProfile } from "@/types";
import {
  createDuplicateGitCommitMessageProfileName,
  GIT_COMMIT_MESSAGE_PRESET_TEMPLATES,
  hasBuiltInGitCommitMessageProfileChanges,
  isBuiltInGitCommitMessageProfile,
  isBuiltInGitCommitMessageProfileModified,
  resetBuiltInGitCommitMessageProfiles,
  resetSingleBuiltInGitCommitMessageProfile,
  type GitCommitMessagePresetTemplate,
} from "@/lib/gitCommitMessageProfiles";
import { useAppStore } from "@/store";
import { SettingsPageHeader } from "./SettingsPageHeader";
import { SettingsSection } from "./SettingsSection";

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

  const hasBuiltInChanges = useMemo(
    () => hasBuiltInGitCommitMessageProfileChanges(gitCommitMessageProfiles),
    [gitCommitMessageProfiles],
  );

  const openProfileEditor = useCallback(
    (profile?: GitCommitMessageProfile) => {
      setEditingProfileId(profile?.id ?? null);
      setProfileName(profile?.name ?? "");
      setProfileInstructions(profile?.instructions ?? "");
      setMakeProfileDefault(
        profile ? profile.id === defaultGitCommitMessageProfileId : false,
      );
      setProfileEditorOpen(true);
    },
    [defaultGitCommitMessageProfileId],
  );

  const applyPresetTemplate = useCallback(
    (preset: GitCommitMessagePresetTemplate) => {
      setProfileInstructions(preset.instructions);
      if (!editingProfileId && !profileName.trim()) {
        const candidateName = gitCommitMessageProfiles.some(
          (item) =>
            item.name.trim().toLocaleLowerCase() ===
            preset.defaultName.toLocaleLowerCase(),
        )
          ? createDuplicateGitCommitMessageProfileName(
              preset.defaultName,
              gitCommitMessageProfiles,
              t("settings.agents.gitProfiles.copySuffix"),
            )
          : preset.defaultName;
        setProfileName(candidateName);
      }
    },
    [editingProfileId, gitCommitMessageProfiles, profileName, t],
  );

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
    if (
      gitCommitMessageProfiles.some(
        (profile) =>
          profile.id !== editingProfileId &&
          profile.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    ) {
      message.warning(t("settings.agents.gitProfiles.nameDuplicate"));
      return;
    }

    const id =
      editingProfileId ??
      (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `profile-${Date.now()}`);
    const nextProfile = {
      id,
      name: name.slice(0, 80),
      instructions: instructions.slice(0, 6000),
    };
    const nextProfiles = editingProfileId
      ? gitCommitMessageProfiles.map((profile) =>
          profile.id === editingProfileId ? nextProfile : profile,
        )
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

  const setDefaultProfile = useCallback(
    (profileId: string) => {
      setGitCommitMessageProfiles(gitCommitMessageProfiles, profileId);
    },
    [gitCommitMessageProfiles, setGitCommitMessageProfiles],
  );

  const handleResetBuiltInProfiles = useCallback(() => {
    const nextProfiles = resetBuiltInGitCommitMessageProfiles(gitCommitMessageProfiles);
    setGitCommitMessageProfiles(nextProfiles, defaultGitCommitMessageProfileId);
    message.success(t("settings.agents.gitProfiles.resetSuccess"));
  }, [defaultGitCommitMessageProfileId, gitCommitMessageProfiles, setGitCommitMessageProfiles, t]);

  const handleResetSingleBuiltIn = useCallback(
    (profileId: string) => {
      const nextProfiles = resetSingleBuiltInGitCommitMessageProfile(
        gitCommitMessageProfiles,
        profileId,
      );
      setGitCommitMessageProfiles(nextProfiles, defaultGitCommitMessageProfileId);
      message.success(t("settings.agents.gitProfiles.resetSuccess"));
    },
    [defaultGitCommitMessageProfileId, gitCommitMessageProfiles, setGitCommitMessageProfiles, t],
  );

  const confirmDeleteProfile = useCallback(() => {
    if (!deleteProfileId || gitCommitMessageProfiles.length <= 1) return;
    const nextProfiles = gitCommitMessageProfiles.filter(
      (profile) => profile.id !== deleteProfileId,
    );
    setGitCommitMessageProfiles(
      nextProfiles,
      deleteProfileId === defaultGitCommitMessageProfileId
        ? nextProfiles[0].id
        : defaultGitCommitMessageProfileId,
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
    <div className="app-git-settings">
      <SettingsPageHeader title={t("settings.menu.git")} actions={
        <div className="flex flex-wrap items-center gap-2">
          {hasBuiltInChanges && (
            <Button size="small" icon={<ReloadOutlined aria-hidden="true" />} onClick={handleResetBuiltInProfiles}>
              {t("settings.agents.gitProfiles.resetBuiltIn")}
            </Button>
          )}
          <Button type="primary" icon={<PlusOutlined aria-hidden="true" />} onClick={() => openProfileEditor()}>
            {t("settings.agents.gitProfiles.add")}
          </Button>
        </div>
      } />
      <SettingsSection title={t("settings.agents.gitProfiles.layout.title")}
        description={t("settings.agents.gitProfiles.layout.description")}>

        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className="sr-only">{t("settings.agents.gitProfiles.title")}</legend>
          {gitCommitMessageProfiles.map((profile) => {
            const isDefault = profile.id === defaultGitCommitMessageProfileId;
            const builtIn = isBuiltInGitCommitMessageProfile(profile.id);
            const modified = builtIn && isBuiltInGitCommitMessageProfileModified(profile);
            const summary = builtIn && !modified
              ? t(`settings.agents.gitProfiles.layout.summaries.${profile.id}`)
              : profile.instructions;
            return (
              <article key={profile.id} aria-label={profile.name}
                className={`app-git-profile-row ${isDefault ? "app-git-profile-row--default" : ""}`}>
                <div className="flex items-start gap-3 px-2 py-3.5">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
                    <input type="radio" name="git-commit-message-default" value={profile.id}
                      checked={isDefault} onChange={() => setDefaultProfile(profile.id)} aria-label={profile.name}
                      className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-[var(--cs-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cs-primary)]" />
                    <span className="block min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span title={profile.name} className="min-w-0 truncate text-sm font-medium text-[var(--cs-text-primary)]">{profile.name}</span>
                        {isDefault && <Tag icon={<CheckOutlined aria-hidden="true" />} color="processing" className="!m-0 shrink-0">{t("settings.agents.gitProfiles.default")}</Tag>}
                        {!builtIn && <Tag className="!m-0 shrink-0">{t("settings.agents.gitProfiles.custom")}</Tag>}
                        {modified && <Tag color="warning" className="!m-0 shrink-0">{t("settings.agents.gitProfiles.modified")}</Tag>}
                      </span>
                      <span className="mt-1 line-clamp-1 break-words text-xs leading-5 text-[var(--cs-text-secondary)]">{summary}</span>
                    </span>
                  </label>
                  <div className="flex shrink-0 flex-wrap items-center gap-0.5">
                    {modified && (
                      <Tooltip title={t("settings.agents.gitProfiles.resetSingle")}>
                        <Button type="text" size="small" icon={<UndoOutlined />}
                          aria-label={`${t("settings.agents.gitProfiles.resetSingle")} ${profile.name}`}
                          onClick={() => handleResetSingleBuiltIn(profile.id)} />
                      </Tooltip>
                    )}
                    <Tooltip title={t("common.edit")}>
                      <Button type="text" size="small" icon={<EditOutlined />}
                        aria-label={`${t("common.edit")} ${profile.name}`} onClick={() => openProfileEditor(profile)} />
                    </Tooltip>
                    <Tooltip title={gitCommitMessageProfiles.length <= 1 ? t("settings.agents.gitProfiles.keepOne") : t("common.delete")}>
                      <Button type="text" danger size="small" icon={<DeleteOutlined />}
                        aria-label={`${t("common.delete")} ${profile.name}`} disabled={gitCommitMessageProfiles.length <= 1}
                        onClick={() => setDeleteProfileId(profile.id)} />
                    </Tooltip>
                  </div>
                </div>
              </article>
            );
          })}
        </fieldset>
      </SettingsSection>

      <Modal
        open={profileEditorOpen}
        title={t(
          editingProfileId
            ? "settings.agents.gitProfiles.editTitle"
            : "settings.agents.gitProfiles.createTitle",
        )}
        okText={t("settings.agents.gitProfiles.save")}
        cancelText={t("common.cancel", { defaultValue: "取消" })}
        onOk={saveProfile}
        onCancel={() => setProfileEditorOpen(false)}
        destroyOnHidden
        width={560}
      >
        <div className="space-y-4 pt-2">
          <div>
            <div className="app-git-settings-text-secondary mb-1.5 text-xs font-medium">
              {t("settings.agents.gitProfiles.presetLabel")}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {GIT_COMMIT_MESSAGE_PRESET_TEMPLATES.map((preset) => {
                const isActive = profileInstructions.trim() === preset.instructions.trim();
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applyPresetTemplate(preset)}
                    aria-pressed={isActive}
                    className={`app-git-profile-preset-chip rounded-md px-2.5 py-1 text-xs font-medium ${
                      isActive ? "app-git-profile-preset-chip--active" : ""
                    }`}
                  >
                    {t(preset.labelKey)}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label htmlFor="git-profile-name" className="app-git-settings-text-secondary mb-1 block text-xs font-medium">
              {t("settings.agents.gitProfiles.name")}
            </label>
            <Input
              id="git-profile-name"
              name="git-profile-name"
              autoComplete="off"
              value={profileName}
              maxLength={80}
              placeholder={t("settings.agents.gitProfiles.namePlaceholder")}
              onChange={(event) => setProfileName(event.target.value)}
            />
          </div>

          <div>
            <label htmlFor="git-profile-instructions" className="app-git-settings-text-secondary mb-1 block text-xs font-medium">
              {t("settings.agents.gitProfiles.instructions")}
            </label>
            <Input.TextArea
              id="git-profile-instructions"
              name="git-profile-instructions"
              aria-describedby="git-profile-instructions-hint"
              value={profileInstructions}
              maxLength={6000}
              autoSize={{ minRows: 6, maxRows: 12 }}
              showCount
              placeholder={t("settings.agents.gitProfiles.instructionsPlaceholder")}
              onChange={(event) => setProfileInstructions(event.target.value)}
            />
            <div id="git-profile-instructions-hint" className="app-git-settings-text-secondary mt-6 text-xs">
              {t("settings.agents.gitProfiles.instructionsHint")}
            </div>
          </div>

          <div className="app-git-profile-modal-row flex items-center justify-between gap-3 rounded-lg px-3.5 py-2.5">
            <label htmlFor="git-profile-make-default" className="app-git-settings-text-secondary text-sm">
              {t("settings.agents.gitProfiles.makeDefault")}
            </label>
            <Switch
              id="git-profile-make-default"
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
