import { DownOutlined, FolderOutlined } from "@ant-design/icons";
import { Dropdown } from "antd";
import type { MenuProps } from "antd";

interface SidebarProjectSwitcherProps {
  currentProject: { name: string; path: string } | null;
  launcherTitle: string;
  items: MenuProps["items"];
  maxHeight: string;
}

function SidebarProjectSwitcher({
  currentProject,
  launcherTitle,
  items,
  maxHeight,
}: SidebarProjectSwitcherProps) {
  return (
    <Dropdown
      menu={{
        items,
        style: {
          maxHeight,
          overflowY: "auto",
        },
      }}
      trigger={["click"]}
      placement="bottomLeft"
      overlayStyle={{
        minWidth: "260px",
        maxHeight,
        overflow: "hidden",
      }}
      getPopupContainer={() => document.body}
    >
      <button
        type="button"
        className="app-sidebar-switcher w-full px-3 py-2 flex items-center gap-2 text-left"
        style={{
          borderBottom: "1px solid var(--cs-border-sidebar)",
        }}
      >
        {currentProject ? (
          <>
            <FolderOutlined style={{ color: "var(--cs-accent-yellow)", fontSize: 16 }} />
            <div className="flex-1 min-w-0">
              <div
                className="text-sm font-semibold truncate"
                style={{ color: "var(--cs-text-primary)" }}
              >
                {currentProject.name}
              </div>
              <div
                className="text-[11px] truncate"
                style={{ color: "var(--cs-text-tertiary)" }}
              >
                {currentProject.path}
              </div>
            </div>
          </>
        ) : (
          <div
            className="flex-1 text-sm font-medium"
            style={{ color: "var(--cs-text-secondary)" }}
          >
            {launcherTitle}
          </div>
        )}
        <DownOutlined className="text-xs" style={{ color: "var(--cs-text-tertiary)" }} />
      </button>
    </Dropdown>
  );
}

export default SidebarProjectSwitcher;
