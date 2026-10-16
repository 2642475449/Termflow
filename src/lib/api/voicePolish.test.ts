import { beforeEach, expect, it, vi } from "vitest";
import { polishVoiceText } from "./index";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

beforeEach(() => { mocks.invoke.mockReset(); });

it.each(["deepseek", "dashscope", "mimo"])("sends the user's multiline prompt to %s cleanup", async (provider) => {
  const instructions = "中文使用简体。\nKeep Japanese as-is: 良い天気。";
  mocks.invoke.mockResolvedValueOnce("低价值。");
  await expect(polishVoiceText(
    "低價值。", provider, "test-model", "test-key", "api", "beijing", "paragraphs", instructions,
  )).resolves.toBe("低价值。");
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("polish_voice_text", {
    text: "低價值。", provider, polishModel: "test-model", apiKey: "test-key",
    authMode: "api", region: "beijing", style: "paragraphs", instructions,
  });
});

it("uses an empty custom prompt when callers omit it", async () => {
  mocks.invoke.mockResolvedValueOnce("今日は良い天気です。");
  await expect(polishVoiceText(
    "今日は良い天気です。", "deepseek", "deepseek-flash", "test-key", "api", "beijing", "continuous",
  )).resolves.toBe("今日は良い天気です。");
  expect(mocks.invoke.mock.calls[0][1]).toMatchObject({ instructions: "" });
});
