import { expect, it } from "vitest";
import { availableVoicePolishModels, defaultVoicePolishModel, normalizeVoicePolishProvider, normalizeVoicePolishStyle, resolveVoicePolishModel, VOICE_POLISH_STYLES } from "./voicePolish";
import { createVoicePolishSlice, type VoicePolishSlice } from "@/store/slices/voicePolish";
import zh from "@/locales/zh-CN.json";
import en from "@/locales/en-US.json";
import ja from "@/locales/ja-JP.json";

it("defaults to DeepSeek independently of ASR", () => {
  expect(normalizeVoicePolishProvider(undefined)).toBe("deepseek");
  expect(normalizeVoicePolishProvider("unknown")).toBe("deepseek");
  expect(defaultVoicePolishModel("deepseek")).toBe("deepseek-flash");
  expect(defaultVoicePolishModel("mimo")).toBe("mimo-v2.6-flash");
});

it("only accepts models from the provided options", () => {
  expect(availableVoicePolishModels("deepseek")).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
  expect(resolveVoicePolishModel("deepseek", "deepseek-v4-pro")).toBe("deepseek-v4-pro");
  expect(resolveVoicePolishModel("deepseek", "qwen-plus")).toBe("deepseek-flash");
  expect(resolveVoicePolishModel("dashscope", "qwen-flash")).toBe("qwen-plus");
  expect(resolveVoicePolishModel("mimo", "qwen-plus")).toBe("mimo-v2.6-flash");
  expect(resolveVoicePolishModel("dashscope", "  ")).toBe("qwen-plus");
});

it("migrates retiring MiMo text models to current presets", () => {
  expect(availableVoicePolishModels("mimo")).toEqual(["mimo-v2.6-flash", "mimo-v2.6-pro"]);
  expect(resolveVoicePolishModel("mimo", "mimo-v2.5-pro")).toBe("mimo-v2.6-pro");
  expect(resolveVoicePolishModel("mimo", "mimo-v2.5")).toBe("mimo-v2.6-flash");
});

it("clears credentials when switching cleanup providers", () => {
  let state: VoicePolishSlice = createVoicePolishSlice((partial) => { state = { ...state, ...partial }; });
  state.setVoicePolishApiKey("test-only-credential");
  state.setVoicePolishProvider("dashscope");
  expect(state.voicePolishApiKey).toBe("");
  expect(state.voicePolishModel).toBe("qwen-plus");
  expect(state.voicePolishProvider).toBe("dashscope");
});

it("only offers the three organization modes", () => {
  let state: VoicePolishSlice = createVoicePolishSlice((partial) => { state = { ...state, ...partial }; });
  expect(VOICE_POLISH_STYLES).toEqual(["continuous", "paragraphs", "structured"]);
  expect(state.voicePolishStyle).toBe("paragraphs");
  expect(normalizeVoicePolishStyle("unknown")).toBe("paragraphs");
  expect(normalizeVoicePolishStyle("custom")).toBe("paragraphs");
  expect(normalizeVoicePolishStyle("faithful")).toBe("continuous");
  expect(normalizeVoicePolishStyle("clear")).toBe("paragraphs");
  expect(normalizeVoicePolishStyle("academic")).toBe("paragraphs");
  expect(normalizeVoicePolishStyle("casual")).toBe("paragraphs");
  state.setVoicePolishStyle("structured");
  expect(state.voicePolishStyle).toBe("structured");
});

it("keeps user instructions independent of provider and organization mode", () => {
  let state: VoicePolishSlice = createVoicePolishSlice((partial) => { state = { ...state, ...partial }; });
  expect(state.voicePolishInstructions).toBe("");
  state.setVoicePolishInstructions("中文使用简体。\nDon't translate Japanese: 良い天気。");
  state.setVoicePolishProvider("dashscope");
  state.setVoicePolishStyle("structured");
  expect(state.voicePolishInstructions).toBe("中文使用简体。\nDon't translate Japanese: 良い天気。");
  state.setVoicePolishInstructions("");
  expect(state.voicePolishInstructions).toBe("");
});

it("provides the custom prompt label, example and behavior in every UI language", () => {
  for (const locale of [zh, en, ja]) {
    const voice = locale.settings.voiceRecognition;
    expect(voice.polishingInstructionsLabel.trim()).not.toBe("");
    expect(voice.polishingInstructionsPlaceholder.trim()).not.toBe("");
    expect(voice.polishingInstructionsHint.trim()).not.toBe("");
  }
});
