export function getGitPrimaryAction(options: { hasLocalChanges: boolean; remoteReady: boolean; ahead: number; behind: number }) {
  if (options.hasLocalChanges) return "commit";
  if (!options.remoteReady) return "none";
  if (options.ahead > 0 && options.behind > 0) return "sync";
  if (options.ahead > 0) return "push";
  if (options.behind > 0) return "pull";
  return "none";
}
