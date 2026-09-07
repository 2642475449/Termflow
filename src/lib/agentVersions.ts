export type AgentVersionStatus = "updateAvailable" | "upToDate" | "ahead" | "unknown";

function parseVersion(value: string | null | undefined) {
  const match = value?.match(/(?:^|[\s(v])([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?(?=$|[\s)])/);
  return match ? { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split(".") ?? [] } : null;
}

export function compareAgentVersion(installed: string | null | undefined, latest: string): AgentVersionStatus {
  const local = parseVersion(installed);
  const remote = parseVersion(latest);
  if (!local || !remote) return "unknown";
  let comparison = 0;
  for (let i = 0; i < 3 && comparison === 0; i++) {
    comparison = local.core[i] < remote.core[i] ? -1 : local.core[i] > remote.core[i] ? 1 : 0;
  }
  if (comparison === 0 && (local.pre.length || remote.pre.length)) {
    if (!local.pre.length) comparison = 1;
    else if (!remote.pre.length) comparison = -1;
    else for (let i = 0; i < Math.max(local.pre.length, remote.pre.length); i++) {
      const a = local.pre[i];
      const b = remote.pre[i];
      if (a === b) continue;
      if (a === undefined) comparison = -1;
      else if (b === undefined) comparison = 1;
      else if (/^\d+$/.test(a) && /^\d+$/.test(b)) comparison = BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
      else if (/^\d+$/.test(a)) comparison = -1;
      else if (/^\d+$/.test(b)) comparison = 1;
      else comparison = a < b ? -1 : 1;
      if (comparison !== 0) break;
    }
  }
  return comparison < 0 ? "updateAvailable" : comparison > 0 ? "ahead" : "upToDate";
}
