import { useEffect, useMemo } from "react";
import type { AgentCliInfo, AiAgentId } from "@/types";
import { useAppStore } from "@/store";

interface UseDefaultInstalledAgentSelectionOptions<TEmpty extends null | undefined> {
  enabled: boolean;
  installedAgents: AgentCliInfo[];
  selectedAgentId: AiAgentId | TEmpty;
  onSelectedAgentChange: (agentId: AiAgentId | TEmpty) => void;
  emptyValue: TEmpty;
}

export function useDefaultInstalledAgentSelection<TEmpty extends null | undefined>({
  enabled,
  installedAgents,
  selectedAgentId,
  onSelectedAgentChange,
  emptyValue,
}: UseDefaultInstalledAgentSelectionOptions<TEmpty>) {
  const defaultAgentId = useAppStore((state) => state.defaultAgentId);

  const hasInstalledAgents = installedAgents.length > 0;
  const selectedAgentInstalled = useMemo(
    () => installedAgents.some((candidate) => candidate.id === selectedAgentId),
    [installedAgents, selectedAgentId],
  );
  const defaultInstalledAgentId = useMemo(
    () =>
      defaultAgentId && installedAgents.some((candidate) => candidate.id === defaultAgentId)
        ? defaultAgentId
        : null,
    [installedAgents, defaultAgentId],
  );

  useEffect(() => {
    if (!enabled) return;

    if (!selectedAgentId) {
      if (defaultInstalledAgentId) {
        onSelectedAgentChange(defaultInstalledAgentId);
      }
      return;
    }

    if (!selectedAgentInstalled) {
      onSelectedAgentChange(emptyValue);
    }
  }, [
    defaultInstalledAgentId,
    emptyValue,
    enabled,
    onSelectedAgentChange,
    selectedAgentId,
    selectedAgentInstalled,
  ]);

  return {
    hasInstalledAgents,
    selectedAgentInstalled,
    defaultInstalledAgentId,
  };
}
