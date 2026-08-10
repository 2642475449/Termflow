import type { AgentId } from "@/types";
import { getAgentDefinition, isAiAgentId } from "@/lib/agents";

interface AgentIconProps {
  agentId: AgentId;
  size?: number;
}

const terminalLogoSources: Record<"powershell" | "cmd", string> = {
  powershell: "/agents/powershell.svg",
  cmd: "/agents/cmd.svg",
};

export function AgentIcon({ agentId, size = 18 }: AgentIconProps) {
  const source = isAiAgentId(agentId)
    ? getAgentDefinition(agentId).iconPath
    : terminalLogoSources[agentId];

  return (
    <img
      src={source}
      alt=""
      aria-hidden="true"
      draggable={false}
      className="shrink-0 select-none object-contain"
      style={{ width: size, height: size }}
    />
  );
}
