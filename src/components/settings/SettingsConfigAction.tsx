import { FolderOpenOutlined } from "@ant-design/icons";
import { Button, Tooltip } from "antd";

interface SettingsConfigActionProps {
  label: string;
  path?: string | null;
  disabled?: boolean;
  onOpen: () => void;
}

/** 配置路径作为打开入口的补充信息，不再单独占据一行。 */
export function SettingsConfigAction({ label, path, disabled, onOpen }: SettingsConfigActionProps) {
  return (
    <Tooltip trigger={["hover", "focus"]} title={path ? <span className="break-all font-mono">{path}</span> : undefined}>
      <Button size="small" type="text" icon={<FolderOpenOutlined />} disabled={disabled} onClick={onOpen}>
        {label}
      </Button>
    </Tooltip>
  );
}
