export type MimoAuthMode = "token-plan" | "api";

export const DEFAULT_MIMO_AUTH_MODE: MimoAuthMode = "token-plan";

export const MIMO_API_ASR_CHAT_COMPLETIONS_ENDPOINT =
  "https://api.xiaomimimo.com/v1/chat/completions";

export const MIMO_TOKEN_PLAN_ASR_CHAT_COMPLETIONS_ENDPOINT =
  "https://token-plan-cn.xiaomimimo.com/v1/chat/completions";

export const MIMO_ASR_CHAT_COMPLETIONS_ENDPOINT = MIMO_API_ASR_CHAT_COMPLETIONS_ENDPOINT;

export const MIMO_ASR_LANGUAGE = "zh";

export function isMimoTokenPlanKey(apiKey: string | null | undefined): boolean {
  return /^(sk-cp-|tp-)/i.test(apiKey?.trim() ?? "");
}

export function normalizeMimoAuthMode(
  value: string | null | undefined,
  apiKey?: string | null,
): MimoAuthMode {
  if (value === "api" || value === "token-plan") {
    return value;
  }
  if (isMimoTokenPlanKey(apiKey)) {
    return "token-plan";
  }
  return apiKey?.trim() ? "api" : DEFAULT_MIMO_AUTH_MODE;
}

export function getMimoAsrEndpoint(authMode: MimoAuthMode): string {
  return authMode === "token-plan"
    ? MIMO_TOKEN_PLAN_ASR_CHAT_COMPLETIONS_ENDPOINT
    : MIMO_API_ASR_CHAT_COMPLETIONS_ENDPOINT;
}

export function getMimoAsrAuthHeaders(authMode: MimoAuthMode, apiKey: string): Record<string, string> {
  return authMode === "token-plan"
    ? { Authorization: `Bearer ${apiKey}` }
    : { "api-key": apiKey };
}

export function buildMimoAsrRequest(audioDataUrl: string, model: string, language = MIMO_ASR_LANGUAGE) {
  return {
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "input_audio",
            input_audio: {
              data: audioDataUrl,
            },
          },
        ],
      },
    ],
    asr_options: {
      language,
    },
  };
}

export function extractMimoApiErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") {
    return error.trim();
  }
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message.trim();
    }
  }

  const message = (payload as { message?: unknown }).message;
  return typeof message === "string" ? message.trim() : "";
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item.trim();
        }
        if (!item || typeof item !== "object") {
          return "";
        }
        const text =
          (item as { text?: unknown; content?: unknown; transcript?: unknown }).text ??
          (item as { text?: unknown; content?: unknown; transcript?: unknown }).content ??
          (item as { text?: unknown; content?: unknown; transcript?: unknown }).transcript;
        return typeof text === "string" ? text.trim() : "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (content && typeof content === "object") {
    const text =
      (content as { text?: unknown; content?: unknown; transcript?: unknown }).text ??
      (content as { text?: unknown; content?: unknown; transcript?: unknown }).content ??
      (content as { text?: unknown; content?: unknown; transcript?: unknown }).transcript;
    return typeof text === "string" ? text.trim() : "";
  }

  return "";
}

export function extractMimoAsrText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const directText = (payload as { text?: unknown }).text;
  if (typeof directText === "string" && directText.trim()) {
    return directText.trim();
  }

  const choices = (payload as { choices?: unknown }).choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") {
        continue;
      }
      const message = (choice as { message?: unknown }).message;
      if (message && typeof message === "object") {
        const content = (message as { content?: unknown }).content;
        const text = extractTextFromContent(content);
        if (text) {
          return text;
        }
      }

      const delta = (choice as { delta?: unknown }).delta;
      if (delta && typeof delta === "object") {
        const content = (delta as { content?: unknown }).content;
        const text = extractTextFromContent(content);
        if (text) {
          return text;
        }
      }
    }
  }

  return "";
}

function encodeMono16BitPcmWav(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(offset, value, true);
    offset += bytesPerSample;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

export function createSilentWavBlob(durationMs = 250, sampleRate = 16_000): Blob {
  const frameCount = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
  return encodeMono16BitPcmWav(new Float32Array(frameCount), sampleRate);
}

export function createSilentWavDataUrl(durationMs = 250, sampleRate = 16_000): Promise<string> {
  const blob = createSilentWavBlob(durationMs, sampleRate);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
