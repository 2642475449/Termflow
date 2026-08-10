import { useCallback, useEffect, useState } from "react";
import { Button, Dropdown, Input, message, Modal, Tooltip } from "antd";
import type { MenuProps } from "antd";
import {
  BranchesOutlined,
  CheckOutlined,
  DeleteOutlined,
  LoadingOutlined,
  MergeOutlined,
  PlusOutlined,
  SwapOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import {
  gitListBranches,
  gitCreateBranch,
  gitSwitchBranch,
  gitDeleteBranch,
  gitMergeBranch,
} from "@/lib/api";
import { refreshGitStateAndGraph } from "@/lib/gitGraphEvents";
import type { GitBranchListItem } from "@/types";

interface GitBranchPanelProps {
  /** 当前项目路径 */
  projectPath: string | null;
  /** 当前分支名称 */
  currentBranch: string;
  /** 面板是否可见 */
  visible: boolean;
  /** 关闭面板 */
  onClose: () => void;
  /** 分支操作完成后回调 */
  onBranchChanged: () => Promise<void>;
}

function isRemoteHeadBranch(name: string) {
  return /\/HEAD$/.test(name);
}

/**
 * Git 分支管理面板
 *
 * 显示分支列表，支持创建、切换、删除、合并分支。
 */
export function GitBranchPanel({
  projectPath,
  currentBranch: _currentBranch,
  visible,
  onClose,
  onBranchChanged,
}: GitBranchPanelProps) {
  const { t } = useTranslation();
  const [branches, setBranches] = useState<GitBranchListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [showCreateInput, setShowCreateInput] = useState(false);
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [deleteTargetBranch, setDeleteTargetBranch] = useState<string | null>(
    null
  );
  const [operatingBranch, setOperatingBranch] = useState<string | null>(null);

  // 加载分支列表
  const loadBranches = useCallback(async () => {
    if (!projectPath) return;
    setLoading(true);
    try {
      const list = await gitListBranches(projectPath);
      setBranches(list);
    } catch (e) {
      message.error(
        `加载分支列表失败: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    if (visible) {
      void loadBranches();
    }
  }, [visible, loadBranches]);

  // 创建分支
  const handleCreateBranch = useCallback(async () => {
    if (!projectPath || !newBranchName.trim()) return;
    setCreating(true);
    try {
      await gitCreateBranch(projectPath, newBranchName.trim());
      message.success(t("sidebar.gitBranchCreateSuccess"));
      setNewBranchName("");
      setShowCreateInput(false);
      await loadBranches();
      await refreshGitStateAndGraph(projectPath, onBranchChanged);
    } catch (e) {
      message.error(
        `${t("sidebar.gitBranchCreateFailed")}: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      setCreating(false);
    }
  }, [projectPath, newBranchName, loadBranches, onBranchChanged, t]);

  // 切换分支
  const handleSwitchBranch = useCallback(
    async (name: string) => {
      if (!projectPath) return;
      setOperatingBranch(name);
      try {
        await gitSwitchBranch(projectPath, name);
        message.success(
          t("sidebar.gitBranchSwitchSuccess", { name })
        );
        await loadBranches();
        await refreshGitStateAndGraph(projectPath, onBranchChanged);
      } catch (e) {
        message.error(
          `${t("sidebar.gitBranchSwitchFailed")}: ${e instanceof Error ? e.message : String(e)}`
        );
      } finally {
        setOperatingBranch(null);
      }
    },
    [projectPath, loadBranches, onBranchChanged, t]
  );

  // 删除分支
  const handleDeleteBranch = useCallback(
    async (name: string, force: boolean = false) => {
      if (!projectPath) return;
      setOperatingBranch(name);
      try {
        await gitDeleteBranch(projectPath, name, force);
        message.success(t("sidebar.gitBranchDeleteSuccess"));
        await loadBranches();
        await refreshGitStateAndGraph(projectPath, onBranchChanged);
      } catch (e) {
        message.error(
          `${t("sidebar.gitBranchDeleteFailed")}: ${e instanceof Error ? e.message : String(e)}`
        );
      } finally {
        setOperatingBranch(null);
        setDeleteConfirmVisible(false);
        setDeleteTargetBranch(null);
      }
    },
    [projectPath, loadBranches, onBranchChanged, t]
  );

  // 合并分支
  const handleMergeBranch = useCallback(
    async (name: string) => {
      if (!projectPath) return;
      setOperatingBranch(name);
      try {
        const result = await gitMergeBranch(projectPath, name);
        if (result.success) {
          message.success(t("sidebar.gitMergeSuccess"));
        } else {
          message.error(`${t("sidebar.gitMergeFailed")}: ${result.message}`);
        }
        await loadBranches();
        await refreshGitStateAndGraph(projectPath, onBranchChanged);
      } catch (e) {
        message.error(
          `${t("sidebar.gitMergeFailed")}: ${e instanceof Error ? e.message : String(e)}`
        );
      } finally {
        setOperatingBranch(null);
      }
    },
    [projectPath, loadBranches, onBranchChanged, t]
  );

  // 构建分支操作菜单
  const buildBranchMenu = useCallback(
    (branch: GitBranchListItem): MenuProps => {
      const items: NonNullable<MenuProps["items"]> = [];

      if (!branch.isCurrent && !isRemoteHeadBranch(branch.name)) {
        items.push({
          key: "switch",
          label: branch.isRemote
            ? t("sidebar.gitCheckoutRemoteBranch", { defaultValue: "检出远程分支" })
            : t("sidebar.gitSwitchBranch"),
          icon: <SwapOutlined />,
        });
      }

      if (!branch.isCurrent && !branch.isRemote) {
        items.push({
          key: "merge",
          label: t("sidebar.gitMergeBranch"),
          icon: <MergeOutlined />,
        });
      }

      if (!branch.isCurrent && !branch.isRemote) {
        items.push({ type: "divider" });
        items.push({
          key: "delete",
          label: t("sidebar.gitDeleteBranch"),
          icon: <DeleteOutlined />,
          danger: true,
        });
      }

      return {
        items,
        onClick: ({ key }) => {
          switch (key) {
            case "switch":
              void handleSwitchBranch(branch.name);
              break;
            case "merge":
              void handleMergeBranch(branch.name);
              break;
            case "delete":
              setDeleteTargetBranch(branch.name);
              setDeleteConfirmVisible(true);
              break;
          }
        },
      };
    },
    [handleSwitchBranch, handleMergeBranch, t]
  );

  // 分离本地和远程分支
  const localBranches = branches.filter((b) => !b.isRemote);
  const remoteBranches = branches.filter((b) => b.isRemote);

  if (!visible) return null;

  return (
    <div
      className="flex flex-col min-h-0"
      style={{
        background: "var(--cs-bg-card-solid, var(--cs-bg-sidebar))",
        borderTop: "1px solid var(--cs-border-sidebar)",
      }}
    >
      {/* 标题栏 */}
      <div
        className="flex items-center justify-between px-2"
        style={{ height: 32 }}
      >
        <div
          className="flex items-center gap-1.5 text-[13px] font-semibold"
          style={{ color: "var(--cs-text-primary)" }}
        >
          <BranchesOutlined style={{ fontSize: 14 }} />
          <span>{t("sidebar.gitBranchList")}</span>
        </div>
        <div className="flex items-center gap-1">
          <Tooltip title={t("sidebar.gitCreateBranch")} mouseEnterDelay={0.4}>
            <Button
              type="text"
              size="small"
              icon={<PlusOutlined />}
              style={{
                width: 24,
                height: 24,
                padding: 0,
                color: "var(--cs-text-secondary)",
              }}
              onClick={() => setShowCreateInput(!showCreateInput)}
            />
          </Tooltip>
          <Button
            type="text"
            size="small"
            style={{
              width: 24,
              height: 24,
              padding: 0,
              color: "var(--cs-text-secondary)",
              fontSize: 11,
            }}
            onClick={onClose}
          >
            ✕
          </Button>
        </div>
      </div>

      {/* 创建分支输入框 */}
      {showCreateInput && (
        <div className="flex items-center gap-1 px-2 pb-1.5">
          <Input
            size="small"
            value={newBranchName}
            onChange={(e) => setNewBranchName(e.target.value)}
            placeholder={t("sidebar.gitBranchNamePlaceholder")}
            onPressEnter={() => void handleCreateBranch()}
            style={{ fontSize: 12 }}
            disabled={creating}
          />
          <Button
            size="small"
            type="primary"
            loading={creating}
            disabled={!newBranchName.trim()}
            onClick={() => void handleCreateBranch()}
            style={{ fontSize: 12 }}
          >
            {t("common.create")}
          </Button>
        </div>
      )}

      {/* 分支列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto app-project-tree-scroll px-1 pb-1">
        {loading ? (
          <div
            className="flex items-center justify-center gap-2 py-4"
            style={{ color: "var(--cs-text-tertiary)" }}
          >
            <LoadingOutlined />
            <span className="text-xs">加载中...</span>
          </div>
        ) : (
          <>
            {/* 本地分支 */}
            {localBranches.length > 0 && (
              <div>
                <div
                  className="px-2 py-1 text-[11px] font-medium"
                  style={{ color: "var(--cs-text-tertiary)" }}
                >
                  {t("sidebar.gitLocalBranches")}
                </div>
                {localBranches.map((branch) => (
                  <Dropdown
                    key={branch.name}
                    trigger={["contextMenu"]}
                    menu={buildBranchMenu(branch)}
                  >
                    <div
                      className="group flex items-center gap-1.5 px-2 cursor-pointer rounded-[4px]"
                      style={{
                        height: 26,
                        background: branch.isCurrent
                          ? "color-mix(in srgb, var(--cs-primary) 12%, transparent)"
                          : "transparent",
                      }}
                      onClick={() => {
                        if (!branch.isCurrent) {
                          void handleSwitchBranch(branch.name);
                        }
                      }}
                    >
                      <BranchesOutlined
                        style={{
                          fontSize: 12,
                          color: branch.isCurrent
                            ? "var(--cs-primary)"
                            : "var(--cs-text-secondary)",
                        }}
                      />
                      <span
                        className="flex-1 truncate text-[12px]"
                        style={{
                          color: branch.isCurrent
                            ? "var(--cs-primary)"
                            : "var(--cs-text-primary)",
                          fontWeight: branch.isCurrent ? 600 : 400,
                        }}
                      >
                        {branch.name}
                      </span>
                      {branch.isCurrent && (
                        <CheckOutlined
                          style={{
                            fontSize: 11,
                            color: "var(--cs-primary)",
                          }}
                        />
                      )}
                      {branch.ahead > 0 && (
                        <span
                          className="text-[10px] px-1 rounded"
                          style={{
                            background: "color-mix(in srgb, var(--cs-success) 12%, transparent)",
                            color: "var(--cs-success)",
                          }}
                        >
                          ↑{branch.ahead}
                        </span>
                      )}
                      {branch.behind > 0 && (
                        <span
                          className="text-[10px] px-1 rounded"
                          style={{
                            background: "color-mix(in srgb, var(--cs-error) 12%, transparent)",
                            color: "var(--cs-error)",
                          }}
                        >
                          ↓{branch.behind}
                        </span>
                      )}
                      {/* 操作按钮 */}
                      {!branch.isCurrent && (
                        <div className="hidden group-hover:flex items-center gap-0.5">
                          <Tooltip
                            title={t("sidebar.gitDeleteBranch")}
                            mouseEnterDelay={0.4}
                          >
                            <Button
                              type="text"
                              size="small"
                              icon={<DeleteOutlined />}
                              style={{
                                width: 18,
                                height: 18,
                                padding: 0,
                                color: "var(--cs-text-tertiary)",
                              }}
                              loading={operatingBranch === branch.name}
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeleteTargetBranch(branch.name);
                                setDeleteConfirmVisible(true);
                              }}
                            />
                          </Tooltip>
                        </div>
                      )}
                    </div>
                  </Dropdown>
                ))}
              </div>
            )}

            {/* 远程分支 */}
            {remoteBranches.length > 0 && (
              <div className="mt-1">
                <div
                  className="px-2 py-1 text-[11px] font-medium"
                  style={{ color: "var(--cs-text-tertiary)" }}
                >
                  {t("sidebar.gitRemoteBranches")}
                </div>
                {remoteBranches.map((branch) => {
                  const canCheckout = !isRemoteHeadBranch(branch.name);
                  return (
                    <Dropdown
                      key={branch.name}
                      trigger={["contextMenu"]}
                      menu={buildBranchMenu(branch)}
                      disabled={!canCheckout}
                    >
                      <div
                        className={`flex items-center gap-1.5 px-2 rounded-[4px] ${
                          canCheckout ? "cursor-pointer" : "cursor-default"
                        }`}
                        style={{ height: 26, opacity: canCheckout ? 0.85 : 0.55 }}
                        onClick={() => {
                          if (canCheckout) {
                            void handleSwitchBranch(branch.name);
                          }
                        }}
                      >
                        <BranchesOutlined
                          style={{
                            fontSize: 12,
                            color: "var(--cs-text-secondary)",
                          }}
                        />
                        <span
                          className="flex-1 truncate text-[12px]"
                          style={{ color: "var(--cs-text-secondary)" }}
                        >
                          {branch.name}
                        </span>
                        {operatingBranch === branch.name ? (
                          <LoadingOutlined
                            style={{ fontSize: 11, color: "var(--cs-text-tertiary)" }}
                          />
                        ) : null}
                      </div>
                    </Dropdown>
                  );
                })}
              </div>
            )}

            {branches.length === 0 && (
              <div
                className="flex flex-col items-center justify-center gap-2 py-6"
                style={{ color: "var(--cs-text-tertiary)" }}
              >
                <BranchesOutlined style={{ fontSize: 24 }} />
                <span className="text-xs">暂无分支</span>
              </div>
            )}
          </>
        )}
      </div>

      {/* 删除确认对话框 */}
      <Modal
        title={t("sidebar.gitDeleteBranch")}
        open={deleteConfirmVisible}
        okText={t("common.delete")}
        cancelText={t("common.cancel")}
        okButtonProps={{ danger: true }}
        onOk={() => {
          if (deleteTargetBranch) {
            void handleDeleteBranch(deleteTargetBranch, false);
          }
        }}
        onCancel={() => {
          setDeleteConfirmVisible(false);
          setDeleteTargetBranch(null);
        }}
      >
        <p>
          {t("sidebar.gitBranchDeleteConfirm", {
            name: deleteTargetBranch || "",
          })}
        </p>
      </Modal>
    </div>
  );
}
