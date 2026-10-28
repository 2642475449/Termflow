import { Modal } from "antd";
import type { TFunction } from "i18next";
import type { TabEntity } from "@/store";
import { closePty } from "@/lib/api";

export async function closeTabRuntime(
  tab: TabEntity | undefined,
  closeSession: (sessionId: string) => Promise<void> = closePty,
): Promise<void> {
  if (tab?.kind === "session") {
    await closeSession(tab.resourceId);
  }
}

export async function archiveSessionRuntime(
  sessionId: string,
  archiveSession: (sessionId: string) => void,
  closeSession: (sessionId: string) => Promise<void> = closePty,
): Promise<void> {
  await closeSession(sessionId);
  archiveSession(sessionId);
}

export async function confirmCloseTab(tab: TabEntity | undefined, t: TFunction): Promise<boolean> {
  if (!tab || tab.kind !== "file" || !tab.dirty) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    const instance = Modal.confirm({
      title: t("fileTabs.closeDirtyTitle"),
      content: t("fileTabs.closeDirtyDescription", { name: tab.title }),
      okText: t("fileTabs.closeWithoutSaving"),
      cancelText: t("common.cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        resolve(true);
        instance.destroy();
      },
      onCancel: () => {
        resolve(false);
        instance.destroy();
      },
    });
  });
}
