import { expect, it } from "vitest";
import { ASR_LANGUAGES, getAsrLanguageContext } from "./asrLanguage";
import { buildDashScopeAsrRequest, buildOpenAICompatibleAsrRequest } from "./dashscopeAsr";

const AUDIO = "data:audio/wav;base64,dGVzdA==";

it.each(ASR_LANGUAGES)("preserves mixed-language detection with %s in both HTTP protocols", (preferredLanguage) => {
  const native = buildDashScopeAsrRequest(AUDIO, { preferredLanguage });
  const compatible = buildOpenAICompatibleAsrRequest(AUDIO, { preferredLanguage });
  // language 是单语限制，不得用于首选语言；自动识别不添加上下文。
  expect(native.parameters.asr_options).not.toHaveProperty("language");
  expect(compatible.asr_options).not.toHaveProperty("language");
  const context = getAsrLanguageContext(preferredLanguage);
  const count = context ? 2 : 1;
  expect(native.input.messages).toHaveLength(count);
  expect(compatible.messages).toHaveLength(count);
  if (context) {
    expect(native.input.messages[0]).toEqual({ role: "system", content: [{ text: context }] });
    expect(compatible.messages[0]).toEqual({ role: "system", content: context });
  }
  expect(native.input.messages[count - 1]).toEqual({ role: "user", content: [{ audio: AUDIO }] });
  expect(compatible.messages[count - 1]).toEqual({ role: "user", content: [{ type: "input_audio", input_audio: { data: AUDIO } }] });
});

it("does not send Qwen-only context to legacy Fun-ASR models", () => {
  const options = { model: "fun-asr-flash-2026-06-15", preferredLanguage: "ja" } as const;
  expect(buildDashScopeAsrRequest(AUDIO, options).input.messages).toHaveLength(1);
  expect(buildOpenAICompatibleAsrRequest(AUDIO, options).messages).toHaveLength(1);
});
