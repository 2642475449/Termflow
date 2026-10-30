import { beforeEach, expect, it, vi } from "vitest";
import { ASR_LANGUAGES, getAsrLanguageContext } from "../asrLanguage";
import { startLiveAsr, transcribeAudio } from "./index";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
beforeEach(() => { mocks.invoke.mockReset(); });

it.each(ASR_LANGUAGES)("passes %s as soft context to real-time recognition", async (language) => {
  await startLiveAsr("session", "test-key", "qwen-audio-3.0-asr-flash-streaming", "beijing", language);
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("start_live_asr", {
    sessionId: "session", apiKey: "test-key", model: "qwen-audio-3.0-asr-flash-streaming", region: "beijing",
    languageContext: getAsrLanguageContext(language) ?? null,
  });
});

it("keeps legacy real-time callers in automatic detection", async () => {
  await startLiveAsr("session", "test-key", "qwen-audio-3.0-asr-flash-streaming", "beijing");
  expect(mocks.invoke.mock.calls[0][1]).toHaveProperty("languageContext", null);
});

it("routes native MiMo requests through the shared IPC wrapper without altering the transcript", async () => {
  const text = "帮我 review 这个 PR，今日は良い天気です。";
  mocks.invoke.mockResolvedValueOnce(text);
  const options = { audioBase64: "dGVzdA==", mimeType: "audio/wav", model: "mimo-v2.5-asr", apiKey: "test-key", authMode: "api" } as const;
  await expect(transcribeAudio(options)).resolves.toBe(text);
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("transcribe_audio", options);
});
