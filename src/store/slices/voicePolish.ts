import {
  availableVoicePolishModels,
  defaultVoicePolishModel,
  normalizeVoicePolishStyle,
  type VoicePolishConfig,
  type VoicePolishProvider,
} from "@/lib/voicePolish";

export interface VoicePolishSlice {
  voicePolishEnabled: boolean;
  voicePolishModel: string;
  voicePolishProvider: VoicePolishProvider;
  voicePolishApiKey: string;
  voicePolishAuthMode: VoicePolishConfig["authMode"];
  voicePolishRegion: VoicePolishConfig["region"];
  voicePolishStyle: VoicePolishConfig["style"];
  setVoicePolishProvider: (provider: VoicePolishProvider) => void;
  setVoicePolishApiKey: (key: string) => void;
  setVoicePolishAuthMode: (mode: VoicePolishConfig["authMode"]) => void;
  setVoicePolishRegion: (region: VoicePolishConfig["region"]) => void;
  setVoicePolishEnabled: (enabled: boolean) => void;
  setVoicePolishModel: (model: string) => void;
  setVoicePolishStyle: (style: VoicePolishConfig["style"]) => void;
}

export function createVoicePolishSlice(
  set: (partial: Partial<VoicePolishSlice>) => void,
): VoicePolishSlice {
  return {
    voicePolishEnabled: true,
    voicePolishModel: "deepseek-flash",
    voicePolishProvider: "deepseek",
    voicePolishApiKey: "",
    voicePolishAuthMode: "api",
    voicePolishRegion: "beijing",
    voicePolishStyle: "paragraphs",
    // 切换服务商时清除旧 Key，避免将凭据发送给另一个服务。
    setVoicePolishProvider: (provider) => set({
      voicePolishProvider: provider,
      voicePolishModel: defaultVoicePolishModel(provider),
      voicePolishApiKey: "",
    }),
    setVoicePolishApiKey: (key) => set({ voicePolishApiKey: key }),
    setVoicePolishAuthMode: (mode) => set({ voicePolishAuthMode: mode }),
    setVoicePolishRegion: (region) => set({ voicePolishRegion: region }),
    setVoicePolishEnabled: (enabled) => set({ voicePolishEnabled: enabled }),
    setVoicePolishStyle: (style) => set({ voicePolishStyle: normalizeVoicePolishStyle(style) }),
    setVoicePolishModel: (model) => set({
      voicePolishModel: model === "" ||
        availableVoicePolishModels("mimo").includes(model) ||
        availableVoicePolishModels("dashscope").includes(model) ||
        availableVoicePolishModels("deepseek").includes(model)
        ? model
        : "",
    }),
  };
}
