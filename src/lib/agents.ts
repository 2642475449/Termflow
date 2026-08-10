import {
  AI_AGENT_IDS,
  type AgentId,
  type AgentPermissionDefaults,
  type AiAgentId,
  type AntigravitySessionLaunchOptions,
  type CodexSessionLaunchOptions,
  type ClaudeSessionLaunchOptions,
  type QoderSessionLaunchOptions,
  type SessionLaunchOptions,
} from "@/types";

export type AgentCapabilityLevel = "full" | "partial" | "unsupported" | "unknown";

export type AgentCapabilityKey =
  | "interactiveTerminal"
  | "initialPrompt"
  | "headlessText"
  | "resume"
  | "permissionWaiting"
  | "statusEvents"
  | "skills"
  | "instructions"
  | "mcpManagement"
  | "usageTelemetry";

export interface AgentDefinition {
  id: AiAgentId;
  displayName: string;
  command: string;
  iconPath: string;
  brandColor: string;
  terminal?: AgentTerminalBehavior;
  capabilities: Record<AgentCapabilityKey, AgentCapabilityLevel>;
}

export interface AgentTerminalBehavior {
  forceStableCursor?: boolean;
}

const DEFAULT_AGENT_TERMINAL_BEHAVIOR: Readonly<AgentTerminalBehavior> = {};

export const AGENT_DEFINITIONS: Record<AiAgentId, AgentDefinition> = {
  claude: {
    id: "claude",
    displayName: "Claude Code",
    command: "claude",
    iconPath: "/agents/claude.svg",
    brandColor: "#d97757",
    capabilities: {
      interactiveTerminal: "full",
      initialPrompt: "full",
      headlessText: "full",
      resume: "full",
      permissionWaiting: "full",
      statusEvents: "full",
      skills: "full",
      instructions: "full",
      mcpManagement: "full",
      usageTelemetry: "full",
    },
  },
  codex: {
    id: "codex",
    displayName: "Codex",
    command: "codex",
    iconPath: "/agents/codex.svg",
    brandColor: "#10a37f",
    terminal: {
      forceStableCursor: true,
    },
    capabilities: {
      interactiveTerminal: "full",
      initialPrompt: "full",
      headlessText: "full",
      resume: "full",
      permissionWaiting: "full",
      statusEvents: "full",
      skills: "full",
      instructions: "partial",
      mcpManagement: "full",
      usageTelemetry: "partial",
    },
  },
  antigravity: {
    id: "antigravity",
    displayName: "Antigravity CLI",
    command: "agy",
    iconPath: "/agents/antigravity.svg",
    brandColor: "#4285f4",
    capabilities: {
      interactiveTerminal: "full",
      initialPrompt: "full",
      headlessText: "full",
      resume: "full",
      permissionWaiting: "unsupported",
      statusEvents: "partial",
      skills: "full",
      instructions: "partial",
      mcpManagement: "full",
      usageTelemetry: "unsupported",
    },
  },
  opencode: {
    id: "opencode",
    displayName: "OpenCode",
    command: "opencode",
    iconPath: "/agents/opencode.svg",
    brandColor: "#6366f1",
    capabilities: {
      interactiveTerminal: "full",
      initialPrompt: "full",
      headlessText: "full",
      resume: "unsupported",
      permissionWaiting: "full",
      statusEvents: "full",
      skills: "full",
      instructions: "partial",
      mcpManagement: "full",
      usageTelemetry: "unsupported",
    },
  },
  qoder: {
    id: "qoder",
    displayName: "Qoder CLI",
    command: "qoderclicn",
    iconPath: "/agents/qoder.svg",
    brandColor: "#2adb5c",
    capabilities: {
      interactiveTerminal: "full",
      initialPrompt: "full",
      headlessText: "full",
      resume: "full",
      permissionWaiting: "full",
      statusEvents: "partial",
      skills: "partial",
      instructions: "partial",
      mcpManagement: "full",
      usageTelemetry: "unsupported",
    },
  },
};

export const AGENT_CAPABILITY_KEYS: AgentCapabilityKey[] = [
  "interactiveTerminal",
  "initialPrompt",
  "headlessText",
  "resume",
  "permissionWaiting",
  "statusEvents",
  "skills",
  "instructions",
  "mcpManagement",
  "usageTelemetry",
];

export const AI_AGENT_ORDER: readonly AiAgentId[] = AI_AGENT_IDS;

export function isAiAgentId(value: unknown): value is AiAgentId {
  return typeof value === "string" && AI_AGENT_IDS.includes(value as AiAgentId);
}

export function supportsAgentCapability(
  agentId: AiAgentId,
  capability: AgentCapabilityKey,
): boolean {
  const level = AGENT_DEFINITIONS[agentId].capabilities[capability];
  return level === "full" || level === "partial";
}

export function getAgentIdsWithCapability(
  capability: AgentCapabilityKey,
): AiAgentId[] {
  return AI_AGENT_ORDER.filter((agentId) =>
    supportsAgentCapability(agentId, capability),
  );
}

export function getAgentDefinition(agentId: AiAgentId): AgentDefinition {
  return AGENT_DEFINITIONS[agentId];
}

export function getAgentTerminalBehavior(
  agentId: AgentId | undefined,
): Readonly<AgentTerminalBehavior> {
  if (!agentId || !isAiAgentId(agentId)) {
    return DEFAULT_AGENT_TERMINAL_BEHAVIOR;
  }
  return AGENT_DEFINITIONS[agentId].terminal ?? DEFAULT_AGENT_TERMINAL_BEHAVIOR;
}

/*
 * Process arguments still live in capability-specific adapters below. The
 * registry above owns stable identity and advertised support so menus and
 * settings do not grow another provider-specific mapping for every agent.
 */

export function getDefaultAgentLaunchOptions(
  agentId: AiAgentId,
  permissionDefaults: AgentPermissionDefaults,
): SessionLaunchOptions | undefined {
  switch (agentId) {
    case "claude":
      return {
        skipPermissions: permissionDefaults.claude?.skipPermissions ?? false,
        effort: "inherit",
      };
    case "codex":
      return {
        yolo: permissionDefaults.codex?.yolo ?? false,
        approvalMode: permissionDefaults.codex?.approvalMode ?? "on-request",
        sandboxMode: permissionDefaults.codex?.sandboxMode ?? "workspace-write",
        effort: "inherit",
      };
    case "antigravity":
      return {
        dangerouslySkipPermissions:
          permissionDefaults.antigravity?.dangerouslySkipPermissions ?? false,
        sandbox: permissionDefaults.antigravity?.sandbox ?? false,
        mode: permissionDefaults.antigravity?.mode ?? "inherit",
      };
    case "opencode":
      return undefined;
    case "qoder":
      return {
        permissionMode: permissionDefaults.qoder?.permissionMode ?? "inherit",
      };
  }
}

/**
 * Keep only the permission-related part of a successful launch. This is
 * deliberately separate from the full launch options: reasoning effort and
 * other non-permission controls should not silently become user defaults.
 */
export function getPermissionDefaultsForLaunch(
  agentId: AiAgentId,
  launchOptions?: SessionLaunchOptions,
): AgentPermissionDefaults {
  switch (agentId) {
    case "claude": {
      const options = launchOptions as ClaudeSessionLaunchOptions | undefined;
      return { claude: { skipPermissions: options?.skipPermissions ?? false } };
    }
    case "codex": {
      const options = launchOptions as CodexSessionLaunchOptions | undefined;
      return {
        codex: {
          yolo: options?.yolo ?? false,
          approvalMode: options?.approvalMode ?? "on-request",
          sandboxMode: options?.sandboxMode ?? "workspace-write",
        },
      };
    }
    case "antigravity": {
      const options = launchOptions as AntigravitySessionLaunchOptions | undefined;
      return {
        antigravity: {
          dangerouslySkipPermissions: options?.dangerouslySkipPermissions ?? false,
          sandbox: options?.sandbox ?? false,
          mode: options?.mode ?? "inherit",
        },
      };
    }
    case "qoder": {
      const options = launchOptions as QoderSessionLaunchOptions | undefined;
      return { qoder: { permissionMode: options?.permissionMode ?? "inherit" } };
    }
    case "opencode":
      return {};
  }
}

export function getAgentDisplayName(agentId: AiAgentId): string {
  return AGENT_DEFINITIONS[agentId].displayName;
}

/**
 * Interactive agents run through PowerShell, which resolves their registered
 * command name through the user's PATH.
 */
export function getAgentCommandShell(_agentId: AiAgentId): "powershell" {
  return "powershell";
}

export function formatAgentVersion(
  version: string | null | undefined,
  agentName: string,
): string | null {
  const normalized = version?.trim();
  if (!normalized) return null;

  const redundantSuffix = ` (${agentName})`;
  if (normalized.toLocaleLowerCase().endsWith(redundantSuffix.toLocaleLowerCase())) {
    return normalized.slice(0, -redundantSuffix.length).trim() || normalized;
  }

  return normalized;
}

/**
 * Codex 0.144.x only forwards the first physical line of the interactive
 * positional PROMPT. Preserve the complete prompt as one argument by making
 * line boundaries explicit. Existing backslashes are escaped so literal
 * `\n` text cannot be confused with an encoded line break.
 */
export function prepareAgentInitialPrompt(
  agentId: AgentId | undefined,
  initialPrompt?: string | null,
): string | undefined {
  const prompt = initialPrompt?.trim();
  if (!prompt) return undefined;
  if (agentId !== "codex" || !/[\r\n]/.test(prompt)) return prompt;

  return prompt
    .replaceAll("\\", "\\\\")
    .replace(/\r\n?/g, "\n")
    .replaceAll("\n", "\\n");
}

export function getAgentStartupCommand(
  agentId?: AgentId,
  _executablePath?: string | null,
  agentSessionId?: string | null,
  initialPrompt?: string | null,
  launchOptions?: SessionLaunchOptions,
  resumeSession = false,
): string | undefined {
  switch (agentId) {
    case "codex": {
      const codexOptions = launchOptions as CodexSessionLaunchOptions | undefined;
      // Resolve Codex through the terminal's PATH rather than pinning a
      // discovered npm wrapper. This lets the user's `codex` command select
      // their current CLI installation and keeps interactive launch, quick
      // commands, and resumed sessions consistent.
      const command = AGENT_DEFINITIONS.codex.command;
      
      const parts = [command];

      if (codexOptions?.yolo) {
        parts.push("--dangerously-bypass-approvals-and-sandbox");
      } else {
        if (codexOptions?.approvalMode && codexOptions.approvalMode !== "untrusted") {
          parts.push(`--ask-for-approval ${codexOptions.approvalMode}`);
        }
        if (codexOptions?.sandboxMode && codexOptions.sandboxMode !== "workspace-write") {
          parts.push(`--sandbox ${codexOptions.sandboxMode}`);
        }
      }

      if (codexOptions?.effort && codexOptions.effort !== "inherit") {
        parts.push(`-c model_reasoning_effort=${codexOptions.effort}`);
      }

      if (agentSessionId) {
        parts.push(`resume ${quoteShellArg(agentSessionId)}`);
        return parts.join(" ");
      }
      const prompt = initialPrompt?.trim();
      return prompt ? withPowerShellInitialPrompt(parts.join(" ")) : parts.join(" ");
    }
    case "antigravity": {
      const options = launchOptions as AntigravitySessionLaunchOptions | undefined;
      const command = AGENT_DEFINITIONS.antigravity.command;
      const parts = [command];
      if (options?.dangerouslySkipPermissions) {
        parts.push("--dangerously-skip-permissions");
      }
      if (options?.sandbox) {
        parts.push("--sandbox");
      }
      if (options?.mode && options.mode !== "inherit") {
        parts.push(`--mode ${options.mode}`);
      }
      if (agentSessionId) {
        parts.push(`--conversation ${quoteShellArg(agentSessionId)}`);
      } else if (resumeSession) {
        parts.push("--continue");
      }
      const prompt = initialPrompt?.trim();
      return prompt ? withPowerShellInitialPrompt(`${parts.join(" ")} -i`) : parts.join(" ");
    }
    case "opencode": {
      // OpenCode's initial prompt is persisted after startup through its
      // authenticated loopback session API. Keep multiline content out of argv.
      return AGENT_DEFINITIONS.opencode.command;
    }
    case "qoder": {
      const options = launchOptions as QoderSessionLaunchOptions | undefined;
      const parts = [AGENT_DEFINITIONS.qoder.command];
      if (options?.permissionMode && options.permissionMode !== "inherit") {
        parts.push(`--permission-mode ${options.permissionMode}`);
      }
      if (agentSessionId) {
        parts.push(`--resume ${quoteShellArg(agentSessionId)}`);
        return parts.join(" ");
      }
      if (resumeSession) {
        parts.push("--continue");
      }
      const prompt = initialPrompt?.trim();
      return prompt
        ? withPowerShellInitialPrompt(`${parts.join(" ")} --prompt-interactive`)
        : parts.join(" ");
    }
    case "claude":
    case "powershell":
    case "cmd":
    case undefined:
      return undefined;
  }
}


function quoteShellArg(arg: string): string {
  return `"${arg.replaceAll('"', '\\"')}"`;
}

function withPowerShellInitialPrompt(command: string): string {
  return `$__termflow_prompt=$env:TERMFLOW_INITIAL_PROMPT; Remove-Item Env:TERMFLOW_INITIAL_PROMPT; ${command} $__termflow_prompt`;
}
