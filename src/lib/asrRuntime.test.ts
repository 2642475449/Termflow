import { describe, expect, it } from "vitest";
import { getAsrTransport, normalizeAsrError } from "./asrRuntime";

describe("getAsrTransport", () => {
  it("routes MiMo through the native proxy used by connection testing", () => {
    expect(getAsrTransport("mimo-v2.5-asr")).toBe("native-proxy");
  });

  it("keeps DashScope models on their dedicated transport", () => {
    expect(getAsrTransport("qwen3-asr-flash")).toBe("dashscope");
    expect(getAsrTransport("fun-asr-flash-2026-06-15")).toBe("dashscope");
  });
});

describe("normalizeAsrError", () => {
  it("preserves structured errors instead of rendering object Object", () => {
    expect(normalizeAsrError({ code: "http_4xx", message: "API Key 无效" })).toEqual({
      code: "http_4xx",
      message: "API Key 无效",
    });
  });

  it("extracts Tauri strings and nested provider messages", () => {
    expect(normalizeAsrError("请求失败 (429)")).toEqual({
      code: "unknown",
      message: "请求失败 (429)",
    });
    expect(normalizeAsrError({ error: { message: "音频格式不受支持" } })).toEqual({
      code: "unknown",
      message: "音频格式不受支持",
    });
  });

  it("uses a readable fallback for opaque objects", () => {
    expect(normalizeAsrError({ status: 500 })).toEqual({
      code: "unknown",
      message: "未知错误",
    });
  });
});
