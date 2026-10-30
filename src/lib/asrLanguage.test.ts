import { expect, it } from "vitest";
import { ASR_LANGUAGES, getAsrLanguageContext, normalizeAsrLanguage, supportsAsrLanguagePreference } from "./asrLanguage";

it("offers only automatic, Chinese, English and Japanese recognition", () => {
  expect(ASR_LANGUAGES).toEqual(["auto", "zh", "en", "ja"]);
  for (const language of ASR_LANGUAGES) expect(normalizeAsrLanguage(language)).toBe(language);
  for (const value of [undefined, null, "", "ms", "invalid", 1]) {
    expect(normalizeAsrLanguage(value)).toBe("auto");
  }
});

it("leaves automatic detection without a hint and uses background context for each preference", () => {
  expect(getAsrLanguageContext("auto")).toBeUndefined();
  expect(getAsrLanguageContext("zh")).toContain("简体中文");
  expect(getAsrLanguageContext("zh")).toContain("英文单词");
  expect(getAsrLanguageContext("en")).toContain("mainly English");
  expect(getAsrLanguageContext("ja")).toContain("日本語");
});

it("limits soft preferences to models with documented recognition context support", () => {
  expect(supportsAsrLanguagePreference("qwen3-asr-flash")).toBe(true);
  expect(supportsAsrLanguagePreference("qwen3-asr-flash-2026-02-10")).toBe(true);
  expect(supportsAsrLanguagePreference("qwen-audio-3.0-asr-flash-streaming")).toBe(true);
  expect(supportsAsrLanguagePreference("mimo-v2.5-asr")).toBe(false);
  expect(supportsAsrLanguagePreference("fun-asr-flash-2026-06-15")).toBe(false);
});
