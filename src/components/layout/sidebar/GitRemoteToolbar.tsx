import { useEffect, useState } from "react";
import { Dropdown, Input, Modal, Select, message } from "antd";
import type { MenuProps } from "antd";
import { EllipsisOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import {
  gitFetch,
  gitPublishBranch,
  gitSaveRemote,
  gitSetUpstream,
} from "@/lib/api";
import { refreshGitStateAndGraph } from "@/lib/gitGraphEvents";
import { useGitRemoteStore } from "@/store/slices/gitRemote";
import type { GitBranchInfo } from "@/types";

interface Props {
  projectPath: string;
  branch: GitBranchInfo | null;
  disabled: boolean;
  refresh: () => Promise<void>;
  menuItems: MenuProps["items"];
  onMenuClick: NonNullable<MenuProps["onClick"]>;
}

export function GitRemoteToolbar({
  projectPath,
  branch,
  disabled,
  refresh,
  menuItems,
  onMenuClick,
}: Props) {
  const { t } = useTranslation();
  const entry = useGitRemoteStore((s) => s.entries[projectPath]);
  const busy = useGitRemoteStore((s) => s.busy[projectPath]);
  const refreshRemote = useGitRemoteStore((s) => s.refresh);
  const setBusy = useGitRemoteStore((s) => s.setBusy);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<
    "add" | "manage" | "upstream" | "publish" | null
  >(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const setFetchError = (error: string | null) =>
    useGitRemoteStore.getState().setFetchError(projectPath, error);
  useEffect(() => {
    void refreshRemote(projectPath);
  }, [projectPath, branch, refreshRemote]);
  const state = entry?.data ?? null;
  const blocked = disabled || !!busy;
  const openDialog = (mode: "add" | "manage" | "upstream" | "publish") => {
    setMenuOpen(false);
    const remote =
      state?.remotes.find((r) => r.name === "origin") ?? state?.remotes[0];
    setName(
      mode === "upstream"
        ? (state?.upstream?.replace(/^refs\/remotes\//, "") ??
            state?.branches[0] ??
            "")
        : mode === "add"
          ? state?.remotes.some((r) => r.name === "origin")
            ? ""
            : "origin"
          : (remote?.name ?? ""),
    );
    setUrl(mode === "add" ? "" : (remote?.url ?? ""));
    setDialog(mode);
  };
  const run = async (kind: string, operation: () => Promise<void>) => {
    if (disabled || useGitRemoteStore.getState().busy[projectPath]) return;
    setBusy(projectPath, kind);
    try {
      await operation();
    } catch (error) {
      message.error(`${t("sidebar.remoteActions.failed")}: ${String(error)}`);
    } finally {
      try {
        await refreshGitStateAndGraph(projectPath, refresh);
        await refreshRemote(projectPath);
      } catch (error) {
        message.error(`${t("sidebar.remoteActions.failed")}: ${String(error)}`);
      } finally {
        setBusy(projectPath, null);
      }
    }
  };
  const save = () => {
    if (
      !name.trim() ||
      (dialog !== "publish" && dialog !== "upstream" && !url.trim())
    )
      return;
    void run(dialog ?? "add", async () => {
      if (dialog === "upstream") {
        await gitSetUpstream(projectPath, branch?.branchName ?? "", name);
      } else if (dialog === "publish") {
        const result = await gitPublishBranch(
          projectPath,
          name,
          branch?.branchName ?? "",
        );
        if (!result.success) throw new Error(result.message);
      } else {
        await gitSaveRemote(projectPath, name, url, dialog === "manage");
        await refreshRemote(projectPath);
        if (
          useGitRemoteStore.getState().entries[projectPath]?.data?.requiresFetch
        ) {
          try {
            const fetched = await gitFetch(projectPath);
            if (!fetched.success) throw new Error(fetched.message);
            setFetchError(null);
          } catch (error) {
            setFetchError(String(error));
            message.warning(
              t("sidebar.gitRemoteSavedUnverified", { detail: String(error) }),
            );
            setDialog(null);
            return;
          }
        }
      }
      setDialog(null);
      message.success(t("sidebar.remoteActions.saved"));
    });
  };
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Dropdown
        open={menuOpen}
        onOpenChange={setMenuOpen}
        trigger={["click"]}
        menu={{
          items: [
            {
              key: "remote-add",
              label: t("sidebar.remoteActions.add"),
              disabled: blocked || !state,
            },
            {
              key: "remote-manage",
              label: t("sidebar.remoteActions.manage"),
              disabled: blocked || !state?.remotes.length,
            },
            {
              key: "remote-upstream",
              label: t("sidebar.remoteActions.upstream"),
              disabled:
                blocked ||
                state?.requiresFetch ||
                !state?.branches.length ||
                !state.hasCommit ||
                branch?.isDetached,
            },
            {
              key: "remote-publish",
              label: t("sidebar.remoteActions.publish"),
              disabled: blocked || !state?.remotes.length || !state.hasCommit || state.requiresFetch || branch?.isDetached || !branch,
            },
            { type: "divider" },
            ...(menuItems ?? []),
          ],
          onClick: (event) => {
            setMenuOpen(false);
            if (event.key === "remote-add") openDialog("add");
            else if (event.key === "remote-manage") openDialog("manage");
            else if (event.key === "remote-upstream") openDialog("upstream");
            else if (event.key === "remote-publish") openDialog("publish");
            else onMenuClick(event);
          },
        }}
      >
        <button
          type="button"
          className="app-file-toolbar-button"
          aria-label={t("sidebar.gitPanelTitle")}
        >
          <EllipsisOutlined />
        </button>
      </Dropdown>
      <Modal
        open={dialog !== null}
        title={t(`sidebar.remoteActions.${dialog ?? "add"}`)}
        onCancel={() => {
          if (!busy) setDialog(null);
        }}
        onOk={save}
        confirmLoading={!!busy}
        okText={t(
          `sidebar.remoteActions.${dialog === "publish" ? "publish" : "save"}`,
        )}
        cancelText={t("common.cancel")}
        okButtonProps={{
          disabled:
            !name.trim() ||
            (dialog !== "publish" && dialog !== "upstream" && !url.trim()),
        }}
      >
        <div className="space-y-4">
          <p className="text-[var(--cs-text-secondary)]">
            {t(
              `sidebar.remoteActions.${dialog === "publish" ? "publishHint" : dialog === "upstream" ? "upstreamHint" : "configHint"}`,
              { branch: branch?.branchName },
            )}
          </p>
          <label className="block space-y-2">
            <span>
              {t(
                dialog === "upstream"
                  ? "sidebar.remoteActions.upstream"
                  : "sidebar.gitRemoteName",
              )}
            </span>
            {dialog === "add" ? (
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!!busy}
              />
            ) : (
              <Select
                className="w-full"
                value={name}
                disabled={!!busy}
                options={
                  dialog === "upstream"
                    ? state?.branches.map((b) => ({ label: b, value: b }))
                    : state?.remotes.map((r) => ({
                        label: r.name,
                        value: r.name,
                      }))
                }
                onChange={(value) => {
                  setName(value);
                  setUrl(
                    state?.remotes.find((r) => r.name === value)?.url ?? "",
                  );
                }}
              />
            )}
          </label>
          {dialog !== "publish" && dialog !== "upstream" && (
            <label className="block space-y-2">
              <span>{t("sidebar.gitRemoteUrl")}</span>
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={!!busy}
              />
            </label>
          )}
        </div>
      </Modal>
    </div>
  );
}
