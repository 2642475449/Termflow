import type { CSSProperties } from "react";
import type { AgentId, Session } from "@/types";
import { AgentIcon } from "@/components/AgentIcon";
import { getAgentDefinition, isAiAgentId } from "@/lib/agents";

type ActivityState = "idle" | "starting" | "running" | "error";

interface AgentActivityIconProps {
  agentId: AgentId;
  active?: boolean;
  status?: Session["status"];
  size?: number;
}

const terminalGlowColors: Record<"powershell" | "cmd", string> = {
  powershell: "#2f78c4",
  cmd: "#4b5563",
};

function getActivityState(
  agentId: AgentId,
  active: boolean,
  status: Session["status"],
): ActivityState {
  if (!isAiAgentId(agentId)) return "idle";
  if (!active) return status === "error" ? "error" : "idle";
  if (status === "starting") return "starting";
  if (status === "running") return "running";
  if (status === "error") return "error";
  return "idle";
}

export function AgentActivityIcon({
  agentId,
  active = false,
  status,
  size = 18,
}: AgentActivityIconProps) {
  const glowColor = isAiAgentId(agentId)
    ? getAgentDefinition(agentId).brandColor
    : terminalGlowColors[agentId];
  const style = {
    width: size,
    height: size,
    "--agent-glow": glowColor,
  } as CSSProperties;

  return (
    <span
      className="agent-activity-icon inline-flex shrink-0 items-center justify-center"
      data-state={getActivityState(agentId, active, status)}
      style={style}
    >
      <AgentIcon agentId={agentId} size={size} />
    </span>
  );
}
