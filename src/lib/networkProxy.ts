import type {
  NetworkProxyMode,
  NetworkProxySettings,
  NetworkProxyTestTarget,
} from "@/types";

export const DEFAULT_NETWORK_PROXY_MODE: NetworkProxyMode = "system";
export const DEFAULT_NO_PROXY = "localhost,127.0.0.1,::1";

export const NETWORK_PROXY_TEST_TARGETS: readonly NetworkProxyTestTarget[] = [
  "googleOAuth",
  "github",
  "openai",
  "claude",
  "gemini",
  "glm",
  "qwen",
];

export function normalizeNetworkProxyMode(value: unknown): NetworkProxyMode {
  return value === "disabled" || value === "custom" ? value : "system";
}

export function normalizeNoProxy(value: unknown): string {
  const entries = typeof value === "string"
    ? value.split(",").map((entry) => entry.trim()).filter(Boolean)
    : [];
  for (const required of ["localhost", "127.0.0.1", "::1"]) {
    if (!entries.includes(required)) entries.push(required);
  }
  return entries.join(",");
}

export function normalizeNetworkProxySettings(
  settings: Partial<NetworkProxySettings> | null | undefined,
): NetworkProxySettings {
  return {
    mode: normalizeNetworkProxyMode(settings?.mode),
    customProxyUrl: settings?.customProxyUrl?.trim() ?? "",
    noProxy: normalizeNoProxy(settings?.noProxy),
  };
}
