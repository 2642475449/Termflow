import type { VoicePolishProvider } from "@/lib/voicePolish";
import deepseekLogo from "@/assets/voice-provider-icons/deepseek.ico";
import dashscopeLogo from "@/assets/voice-provider-icons/dashscope.ico";
import mimoLogo from "@/assets/voice-provider-icons/mimo.png";

const PROVIDER_LOGOS: Record<VoicePolishProvider, string> = {
  deepseek: deepseekLogo,
  dashscope: dashscopeLogo,
  mimo: mimoLogo,
};

interface VoiceProviderLabelProps {
  provider: VoicePolishProvider;
  label: string;
}

export function VoiceProviderLabel({ provider, label }: VoiceProviderLabelProps) {
  return (
    <span className="app-voice-provider-label inline-flex items-center gap-2 align-middle">
      <img
        src={PROVIDER_LOGOS[provider]}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="h-5 w-5 shrink-0 object-contain"
      />
      <span>{label}</span>
    </span>
  );
}
