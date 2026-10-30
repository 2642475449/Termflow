export const ASR_LANGUAGES = ["auto", "zh", "en", "ja"] as const;

export type AsrLanguage = (typeof ASR_LANGUAGES)[number];

export function normalizeAsrLanguage(value: unknown): AsrLanguage {
  return ASR_LANGUAGES.find((language) => language === value) ?? "auto";
}

export function supportsAsrLanguagePreference(model: string): boolean {
  return model.startsWith("qwen3-asr-flash") || model === "qwen-audio-3.0-asr-flash-streaming";
}

// 使用识别上下文提供软偏好，不设置会限制单一语种的 language 参数。
// Qwen ASR 的 system/context 只接受背景信息，不使用翻译或角色指令。
// https://help.aliyun.com/en/model-studio/qwen-asr-api-reference
// https://help.aliyun.com/en/model-studio/qwen-audio-asr-streaming-python-sdk
export function getAsrLanguageContext(language: AsrLanguage): string | undefined {
  switch (language) {
    case "zh":
      return "这是一段以简体中文为主的语音，可能夹杂英文单词、日文、缩写和代码术语。";
    case "en":
      return "The audio is mainly English, with possible Chinese, Japanese, abbreviations and code terms.";
    case "ja":
      return "日本語を中心とした音声で、英単語、中国語、略語、コード用語が混在する場合があります。";
    default:
      return undefined;
  }
}
