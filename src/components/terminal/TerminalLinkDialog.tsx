import { useId } from "react";
import { FileOutlined, FolderOpenOutlined, InfoCircleOutlined, LinkOutlined } from "@ant-design/icons";
import { Modal, Radio } from "antd";
import { useTranslation } from "react-i18next";
import type { TerminalLinkResolution } from "@/lib/api/terminalLinks";
import "./TerminalLinkDialog.css";

interface TerminalLinkDialogProps {
  open: boolean;
  kind: "file" | "external";
  value: string;
  resolution?: TerminalLinkResolution;
  selectedPath?: string;
  opening: boolean;
  onSelectPath: (path: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 只呈现链接与候选位置；选择状态、解析和打开操作仍由终端统一管理。 */
export function TerminalLinkDialog({
  open, kind, value, resolution, selectedPath, opening,
  onSelectPath, onConfirm, onCancel,
}: TerminalLinkDialogProps) {
  const { t } = useTranslation();
  const locationsLabelId = useId();
  const choosingTarget = kind === "file" && Boolean(resolution);
  const filename = value.split(/[\\/]/).filter(Boolean).pop() || value;

  return (
    <Modal
      open={open}
      centered
      width={600}
      className="app-terminal-link-dialog"
      title={t(choosingTarget
        ? "terminal.fileLinkChooseTitle"
        : kind === "file" ? "terminal.fileLinkOpenTitle" : "terminal.openLinkConfirmTitle")}
      okText={t(kind === "file" ? "terminal.fileLinkOpenTitle" : "terminal.openLinkConfirmOk")}
      cancelText={t("common.cancel")}
      confirmLoading={opening}
      okButtonProps={{ disabled: choosingTarget && !selectedPath }}
      cancelButtonProps={{ type: "text", disabled: opening }}
      closable={!opening}
      maskClosable={!opening}
      keyboard={!opening}
      onOk={onConfirm}
      onCancel={onCancel}
    >
      <div className="app-terminal-link-dialog__reference">
        {kind === "file" ? <FileOutlined aria-hidden /> : <LinkOutlined aria-hidden />}
        <div className="app-terminal-link-dialog__reference-text">
          <p className="app-terminal-link-dialog__filename">{kind === "file" ? filename : value}</p>
          {!choosingTarget && kind === "file" && value !== filename ? (
            <p className="app-terminal-link-dialog__path">{value}</p>
          ) : null}
        </div>
      </div>
      {choosingTarget && resolution ? (
        <div className="app-terminal-link-dialog__locations">
          <p className="app-terminal-link-dialog__summary" id={locationsLabelId}>
            {t(resolution.targets.length ? "terminal.fileLinkMatches" : "terminal.fileLinkNoMatches", { count: resolution.targets.length })}
          </p>
          <Radio.Group
            name={locationsLabelId}
            aria-labelledby={locationsLabelId}
            disabled={opening}
            value={selectedPath}
            onChange={(event) => onSelectPath(String(event.target.value))}
            className="app-terminal-link-dialog__options"
          >
            {resolution.targets.map((target) => {
              const relativePath = target.projectRelativePath ?? target.path;
              // 同名文件的区别在目录：优先展示相对目录，完整路径保留在次行。
              const directory = target.kind === "directory" ? relativePath
                : relativePath.replace(/[\\/][^\\/]+$/, "");
              const label = directory === relativePath && target.kind === "file"
                ? t("terminal.fileLinkProjectRoot") : directory || t("terminal.fileLinkProjectRoot");
              return (
                <Radio key={target.path} value={target.path} className="app-terminal-link-dialog__option">
                  <span className="app-terminal-link-dialog__location">
                    <FolderOpenOutlined aria-hidden />
                    <span className="app-terminal-link-dialog__location-text">
                      <span className="app-terminal-link-dialog__directory">{label}</span>
                      <span className="app-terminal-link-dialog__path">{target.path}</span>
                    </span>
                  </span>
                </Radio>
              );
            })}
          </Radio.Group>
          {resolution.truncated ? (
            <p className="app-terminal-link-dialog__notice" role="status">
              <InfoCircleOutlined aria-hidden />
              <span>{t("terminal.fileLinkSearchIncomplete")}</span>
            </p>
          ) : null}
        </div>
      ) : (
        <p className="app-terminal-link-dialog__description">
          {t(kind === "file" ? "terminal.fileLinkOpenDescription" : "terminal.openLinkConfirmContent")}
        </p>
      )}
    </Modal>
  );
}
