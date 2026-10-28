import i18n from "@/i18n";
import { useAppStore } from "@/store";
import { openSkillMarketplaceInWorkspace } from "@/lib/skillMarketplaceTab";
import { createDefaultWorkspace, syncWorkspaceSnapshot } from "@/store/utils/workspace";

// 市场沿用主工作区的标签与分屏状态，打开动作放在独立分片中。
export function openSkillMarketplaceTab() {
  useAppStore.setState((state) => {
    const workspaceKey = state.currentProject?.path ?? "__launcher__";
    const workspace = openSkillMarketplaceInWorkspace(
      state.projectWorkspaces[workspaceKey] ?? createDefaultWorkspace(), i18n.t("settings.skillMarket.title"),
    );
    return {
      projectWorkspaces: { ...state.projectWorkspaces, [workspaceKey]: workspace },
      windowMode: "project",
      ...syncWorkspaceSnapshot(workspace),
    };
  });
}
