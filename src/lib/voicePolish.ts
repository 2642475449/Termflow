export type VoicePolishProvider = "deepseek" | "dashscope" | "mimo";
export type VoicePolishStyle = "continuous" | "paragraphs" | "structured";

export const VOICE_POLISH_STYLES: readonly VoicePolishStyle[] = ["continuous", "paragraphs", "structured"];

export function normalizeVoicePolishStyle(style: string | undefined): VoicePolishStyle {
  if (style === "faithful") return "continuous";
  return VOICE_POLISH_STYLES.find((option) => option === style) ?? "paragraphs";
}

export interface VoicePolishConfig {
  provider: VoicePolishProvider;
  model: string;
  apiKey: string;
  authMode: "api" | "token-plan";
  region: "beijing" | "singapore" | "us";
  style: VoicePolishStyle;
}

export function normalizeVoicePolishProvider(provider: string | undefined): VoicePolishProvider {
  return provider === "dashscope" || provider === "mimo" ? provider : "deepseek";
}

const DASHSCOPE_POLISH_MODELS = ["qwen-plus"] as const;
const MIMO_POLISH_MODELS = ["mimo-v2.6-flash", "mimo-v2.6-pro"] as const;

export function availableVoicePolishModels(provider: VoicePolishProvider): readonly string[] {
  if (provider === "deepseek") return ["deepseek-flash", "deepseek-v4-pro"];
  return provider === "dashscope" ? DASHSCOPE_POLISH_MODELS : MIMO_POLISH_MODELS;
}

export function defaultVoicePolishModel(provider: VoicePolishProvider): string {
  return availableVoicePolishModels(provider)[0];
}

export function resolveVoicePolishModel(provider: VoicePolishProvider, configuredModel: string): string {
  const requested = configuredModel.trim();
  // 旧 Pro 配置迁移到新版 Pro；新配置默认使用 Flash。
  if (provider === "mimo" && requested === "mimo-v2.5-pro") return "mimo-v2.6-pro";
  return availableVoicePolishModels(provider).includes(requested)
    ? requested
    : defaultVoicePolishModel(provider);
}
