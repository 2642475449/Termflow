export type RemoteAgentId = "codex" | "claude" | "shell";

export const REMOTE_AGENT_SETUP = {
  codex: {
    url: "https://learn.chatgpt.com/docs/cli",
    install: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    login: "codex login --device-auth",
  },
  claude: {
    url: "https://code.claude.com/docs/en/setup",
    install: "curl -fsSL https://claude.ai/install.sh | bash",
    login: "claude auth login",
  },
} as const;

export interface RemoteHost {
  id: string;
  name: string;
  target: string;
  port?: number;
  identityFile?: string;
  /** 自动发现的配置条目保留原别名；不复制端口、用户和私钥设置。 */
  sshConfigFile?: string;
}

export interface RemoteConnection {
  hostId: string;
  state: "disconnected" | "connecting" | "authenticating" | "deploying" | "connected" | "error";
  error?: string;
  authOutput: string;
  authRevision: number;
  server?: { port: number; version: number; pid: number; root: string; protocol: number };
}

export interface RemoteSession {
  id: string;
  instanceId: string;
  agentId: RemoteAgentId;
  cwd: string;
  title: string;
  pid: number;
  processState: "running" | "exited";
  taskState: "starting" | "running" | "waiting" | "completed" | "stopped" | "error" | "unknown";
  revision: number;
  createdAt: number;
  exitCode: number | null;
  hookObserved: boolean;
  outputStart: number;
  outputEnd: number;
  rows: number;
  cols: number;
}

export interface RemoteAgentInspection {
  id: "codex" | "claude";
  installed: boolean;
  executable: string | null;
  version: string | null;
  authStatus: "authenticated" | "unauthenticated" | "unknown";
  authDetail?: string;
  hookStatus: "configured" | "pending" | "unsupported" | "error";
}

export interface RemoteInspection {
  agents: RemoteAgentInspection[];
  pythonVersion: string;
  helperVersion: number;
}

export interface RemoteSessionRead {
  sessionId: string;
  instanceId: string;
  offset: number;
  nextOffset: number;
  data: string;
  truncated: boolean;
  session: RemoteSession;
}

export interface RemoteHostDraft {
  id: string;
  name: string;
  target: string;
  port: string;
  identityFile: string;
}

export const EMPTY_REMOTE_HOST_DRAFT: RemoteHostDraft = {
  id: "", name: "", target: "", port: "", identityFile: "",
};

export function isRemoteHost(value: unknown): value is RemoteHost {
  if (!value || typeof value !== "object") return false;
  const host = value as Record<string, unknown>;
  return typeof host.id === "string" && typeof host.name === "string" && typeof host.target === "string"
    && (host.port === undefined || (typeof host.port === "number" && Number.isInteger(host.port) && host.port > 0 && host.port <= 65535))
    && (host.identityFile === undefined || typeof host.identityFile === "string")
    && (host.sshConfigFile === undefined || typeof host.sshConfigFile === "string");
}

export function remoteHostDraft(host?: RemoteHost): RemoteHostDraft {
  return host ? {
    id: host.id, name: host.name, target: host.target,
    port: host.port?.toString() ?? "", identityFile: host.identityFile ?? "",
  } : { ...EMPTY_REMOTE_HOST_DRAFT };
}

/** 返回翻译键；与后端共同校验，避免将表单内容解释成 SSH 参数。 */
export function validateRemoteHostDraft(draft: RemoteHostDraft): string | null {
  if (!draft.name.trim()) return "remote.errors.nameRequired";
  const target = draft.target.trim();
  if (!target || target.startsWith("-") || /\s|\0/.test(target)) return "remote.errors.targetInvalid";
  if (draft.port.trim() && (!/^\d+$/.test(draft.port.trim()) || Number(draft.port) < 1 || Number(draft.port) > 65535)) {
    return "remote.errors.portInvalid";
  }
  if (/[\r\n\0]/.test(draft.identityFile)) return "remote.errors.identityInvalid";
  return null;
}

export function isRemoteConnectionBusy(connection?: RemoteConnection): boolean {
  return connection?.state === "connecting" || connection?.state === "authenticating" || connection?.state === "deploying";
}

export function canWriteRemoteSession(connection: RemoteConnection | undefined, session: RemoteSession | undefined): boolean {
  return connection?.state === "connected" && session?.processState === "running";
}

/** 传输保持原始字节，让 xterm 自己处理跨包 UTF-8。 */
export function decodeRemoteOutput(data: string): Uint8Array {
  const binary = atob(data);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function reconcileRemoteRead(
  result: RemoteSessionRead,
  expected: { sessionId: string; instanceId: string; cursor: number },
): "ignore" | "reset" | "append" {
  if (result.sessionId !== expected.sessionId || result.instanceId !== expected.instanceId) return "ignore";
  if (!Number.isSafeInteger(result.offset) || !Number.isSafeInteger(result.nextOffset)
    || result.nextOffset < result.offset || result.offset < 0) return "ignore";
  if (result.truncated || result.offset > expected.cursor) return "reset";
  if (result.offset !== expected.cursor) return "ignore";
  return "append";
}

export function remoteErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const code = /^remote_[a-z_]+/.exec(text)?.[0];
  const messages: Record<string, string> = {
    remote_ssh_config_read_failed: "sshConfigReadFailed", remote_ssh_config_home_unavailable: "sshConfigReadFailed",
    remote_ssh_config_read_only: "sshConfigReadOnly",
    remote_python_required: "pythonRequired", remote_python_version: "pythonVersion",
    remote_linux_required: "linuxRequired", remote_not_connected: "connectionRequired",
    remote_ssh_disconnected: "sshDisconnected", remote_ssh_closed_before_ready: "sshClosed",
    remote_connect_timeout: "connectTimeout", remote_transport_failed: "transportFailed",
    remote_ssh_forwarding_failed: "transportFailed", remote_helper_handshake_failed: "protocolMismatch",
    remote_ssh_start_failed: "sshStartFailed", remote_auth_terminal_failed: "sshStartFailed",
    remote_auth_input_failed: "authInputFailed", remote_auth_not_active: "authNotActive",
    remote_auth_input_too_large: "inputTooLarge", remote_deployment_failed: "deploymentFailed",
    remote_upload_interrupted: "deploymentFailed", remote_upload_failed: "deploymentFailed",
    remote_helper_start_failed: "helperStartFailed", remote_upload_checksum: "checksumFailed",
    remote_unsafe_install_directory: "unsafeInstallDirectory", remote_upload_too_large: "deploymentFailed",
    remote_invalid_server_descriptor: "protocolMismatch", remote_invalid_response: "protocolMismatch",
    remote_response_failed: "transportFailed", remote_proxy_failed: "transportFailed",
    remote_local_port_failed: "localPortFailed", remote_invalid_ssh_target: "targetInvalid",
    remote_invalid_ssh_port: "portInvalid", remote_invalid_host_name: "nameRequired",
    remote_invalid_identity_file: "identityInvalid",
  };
  if (code) return `remote.errors.${messages[code] ?? "connectionFailed"}`;
  if (text === "working directory is not a directory") return "remote.errors.directoryInvalid";
  if (text === "server has running sessions; stop them explicitly first") return "remote.errors.serverHasSessions";
  if (text === "stop the session before removing it") return "remote.errors.stopBeforeForget";
  return text;
}
