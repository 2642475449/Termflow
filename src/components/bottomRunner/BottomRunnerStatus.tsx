import { CheckCircleOutlined, CloseCircleOutlined, LoadingOutlined, PlayCircleOutlined, StopOutlined } from "@ant-design/icons";
import { Tooltip } from "antd";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/store";
import { EMPTY_RUNNER_TABS, useBottomRunnerStore } from "@/store/slices/bottomRunner";
import { useShortcutStore } from "@/store/slices/shortcutSlice";
import { getAppShortcut } from "@/lib/appShortcuts";
import type { BottomRunnerTabStatus } from "@/store/types";
import "./bottomRunner.css";

export function RunnerStatusIcon({ status }: { status: BottomRunnerTabStatus }) {
  return <span className="app-bottom-runner-icon inline-flex" data-status={status} aria-hidden="true">
    {status === "starting" || status === "running" ? <LoadingOutlined />
      : status === "success" || status === "completed" ? <CheckCircleOutlined />
        : status === "error" ? <CloseCircleOutlined /> : <StopOutlined />}
  </span>;
}

export function BottomRunnerRailButton() {
  const { t } = useTranslation();
  const projectPath = useAppStore((state) => state.windowMode === "project" ? state.currentProject?.path : undefined);
  const open = useBottomRunnerStore((state) => state.open);
  const tabs = useBottomRunnerStore((state) => state.tabsByProject[projectPath ?? ""] ?? EMPTY_RUNNER_TABS);
  const overrides = useShortcutStore((state) => state.overrides);
  if (!projectPath) return null;
  const label = t("bottomRunner.toggleShortcut", { shortcut: getAppShortcut(overrides, "toggleBottomRunner") });
  return <Tooltip title={label} placement="right">
    <button type="button" aria-label={label} aria-pressed={open} data-active={open}
      onMouseDown={(event) => event.preventDefault()} onClick={() => useBottomRunnerStore.getState().toggleOpen()}
      className="app-bottom-runner-rail app-rail-button relative flex h-10 w-10 items-center justify-center rounded-md">
      <PlayCircleOutlined className="text-lg" />
      {tabs.some((tab) => tab.status === "error") && <span className="app-bottom-runner-badge absolute right-1 top-1 h-2.5 w-2.5 rounded-full" />}
    </button>
  </Tooltip>;
}

