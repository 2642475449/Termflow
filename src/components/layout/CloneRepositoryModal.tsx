import {
  BranchesOutlined,
  DownOutlined,
  FolderOpenOutlined,
  LinkOutlined,
  RightOutlined,
} from "@ant-design/icons";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Alert, Button, Checkbox, Input, Modal, Spin } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { gitCloneRepository } from "@/lib/api";
import type { GitCloneStartResult } from "@/types";

interface CloneRepositoryModalProps {
  open: boolean;
  onCancel: () => void;
  onCloneStarted: (task: GitCloneStartResult) => Promise<void> | void;
}

function inferRepositoryName(remoteUrl: string) {
  const normalized = remoteUrl.trim().replace(/[?#].*$/, "").replace(/[\\/]+$/, "");
  const lastSegment = normalized.split(/[\\/:]/).filter(Boolean).pop() ?? "";
  return lastSegment.replace(/\.git$/i, "");
}

function joinPath(parent: string, name: string) {
  if (!parent) return name;
  const separator = parent.includes("\\") ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${separator}${name}`;
}

function CloneRepositoryModal({ open, onCancel, onCloneStarted }: CloneRepositoryModalProps) {
  const { t } = useTranslation();
  const [remoteUrl, setRemoteUrl] = useState("");
  const [parentDirectory, setParentDirectory] = useState("");
  const [directoryName, setDirectoryName] = useState("");
  const [directoryNameEdited, setDirectoryNameEdited] = useState(false);
  const [branch, setBranch] = useState("");
  const [shallow, setShallow] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRemoteUrl("");
    setParentDirectory("");
    setDirectoryName("");
    setDirectoryNameEdited(false);
    setBranch("");
    setShallow(false);
    setAdvancedOpen(false);
    setSubmitting(false);
    setError(null);
  }, [open]);

  const destinationPreview = useMemo(
    () => joinPath(parentDirectory, directoryName),
    [directoryName, parentDirectory]
  );
  const canSubmit = Boolean(remoteUrl.trim() && parentDirectory.trim() && directoryName.trim());

  function handleRemoteUrlChange(value: string) {
    setRemoteUrl(value);
    setError(null);
    if (!directoryNameEdited) {
      setDirectoryName(inferRepositoryName(value));
    }
  }

  async function chooseParentDirectory() {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: t("projectLauncher.cloneChooseLocation"),
    });
    if (selected) {
      setParentDirectory(selected as string);
      setError(null);
    }
  }

  async function handleClone() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await gitCloneRepository({
        remoteUrl: remoteUrl.trim(),
        parentDirectory: parentDirectory.trim(),
        directoryName: directoryName.trim(),
        branch: branch.trim() || undefined,
        shallow,
      });
      await onCloneStarted(result);
    } catch (cloneError) {
      setError(cloneError instanceof Error ? cloneError.message : String(cloneError));
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      width={560}
      centered
      maskClosable={!submitting}
      keyboard={!submitting}
      closable={!submitting}
      onCancel={onCancel}
      title={
        <div className="flex items-center gap-2.5">
          <span
            className="flex h-8 w-8 items-center justify-center rounded-lg"
            style={{ background: "color-mix(in srgb, var(--cs-primary) 14%, transparent)", color: "var(--cs-primary)" }}
          >
            <BranchesOutlined />
          </span>
          <div>
            <div className="text-[15px] font-semibold">{t("projectLauncher.cloneTitle")}</div>
            <div className="mt-0.5 text-[11px] font-normal" style={{ color: "var(--cs-text-tertiary)" }}>
              {t("projectLauncher.cloneSubtitle")}
            </div>
          </div>
        </div>
      }
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button disabled={submitting} onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button type="primary" loading={submitting} disabled={!canSubmit} onClick={() => void handleClone()}>
            {submitting ? t("projectLauncher.cloning") : t("projectLauncher.cloneAction")}
          </Button>
        </div>
      }
    >
      <div className="pt-3">
        <label className="mb-1.5 block text-[12px] font-medium" style={{ color: "var(--cs-text-secondary)" }}>
          {t("projectLauncher.repositoryUrl")}
        </label>
        <Input
          autoFocus
          size="large"
          value={remoteUrl}
          disabled={submitting}
          prefix={<LinkOutlined style={{ color: "var(--cs-text-tertiary)" }} />}
          placeholder="https://github.com/user/repository.git"
          onChange={(event) => handleRemoteUrlChange(event.target.value)}
          onPressEnter={() => void handleClone()}
        />

        <label className="mb-1.5 mt-5 block text-[12px] font-medium" style={{ color: "var(--cs-text-secondary)" }}>
          {t("projectLauncher.cloneLocation")}
        </label>
        <div className="flex gap-2">
          <Input
            size="large"
            value={parentDirectory}
            readOnly
            disabled={submitting}
            placeholder={t("projectLauncher.cloneLocationPlaceholder")}
          />
          <Button size="large" icon={<FolderOpenOutlined />} disabled={submitting} onClick={() => void chooseParentDirectory()}>
            {t("projectLauncher.browse")}
          </Button>
        </div>

        <label className="mb-1.5 mt-5 block text-[12px] font-medium" style={{ color: "var(--cs-text-secondary)" }}>
          {t("projectLauncher.directoryName")}
        </label>
        <Input
          size="large"
          value={directoryName}
          disabled={submitting}
          placeholder={t("projectLauncher.directoryNamePlaceholder")}
          onChange={(event) => {
            setDirectoryNameEdited(true);
            setDirectoryName(event.target.value);
            setError(null);
          }}
          onPressEnter={() => void handleClone()}
        />

        {parentDirectory && directoryName ? (
          <div className="mt-2 truncate text-[11px]" style={{ color: "var(--cs-text-tertiary)" }} title={destinationPreview}>
            {t("projectLauncher.cloneDestination")}: {destinationPreview}
          </div>
        ) : null}

        <button
          type="button"
          className="mt-5 flex items-center gap-2 text-[12px] font-medium"
          style={{ color: "var(--cs-text-secondary)" }}
          disabled={submitting}
          onClick={() => setAdvancedOpen((value) => !value)}
        >
          {advancedOpen ? <DownOutlined className="text-[9px]" /> : <RightOutlined className="text-[9px]" />}
          {t("projectLauncher.cloneOptions")}
        </button>

        {advancedOpen ? (
          <div
            className="mt-3 rounded-lg border px-3.5 py-3"
            style={{ borderColor: "var(--cs-border-sidebar)", background: "var(--cs-bg-card)" }}
          >
            <label className="mb-1.5 block text-[11px]" style={{ color: "var(--cs-text-secondary)" }}>
              {t("projectLauncher.branchOptional")}
            </label>
            <Input
              value={branch}
              disabled={submitting}
              placeholder={t("projectLauncher.branchPlaceholder")}
              onChange={(event) => setBranch(event.target.value)}
            />
            <Checkbox className="mt-3" checked={shallow} disabled={submitting} onChange={(event) => setShallow(event.target.checked)}>
              <span className="text-[12px]">{t("projectLauncher.shallowClone")}</span>
            </Checkbox>
            <div className="ml-6 mt-1 text-[11px]" style={{ color: "var(--cs-text-tertiary)" }}>
              {t("projectLauncher.shallowCloneHint")}
            </div>
          </div>
        ) : null}

        {submitting ? (
          <div
            className="mt-5 flex items-center gap-3 rounded-lg border px-3.5 py-3"
            style={{ borderColor: "color-mix(in srgb, var(--cs-primary) 28%, transparent)", background: "color-mix(in srgb, var(--cs-primary) 7%, transparent)" }}
          >
            <Spin size="small" />
            <div>
              <div className="text-[12px] font-medium">{t("projectLauncher.cloningRepository")}</div>
              <div className="mt-0.5 text-[11px]" style={{ color: "var(--cs-text-tertiary)" }}>
                {t("projectLauncher.cloningHint")}
              </div>
            </div>
          </div>
        ) : null}

        {error ? <Alert className="mt-5" type="error" showIcon message={t("projectLauncher.cloneFailed")} description={error} /> : null}
      </div>
    </Modal>
  );
}

export default CloneRepositoryModal;
