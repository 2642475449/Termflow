import { expect, it } from "vitest";
import { diffVoicePolishPreview } from "./voicePolishPreview";
import zh from "@/locales/zh-CN.json";
import en from "@/locales/en-US.json";
import tw from "@/locales/zh-TW.json";
import ja from "@/locales/ja-JP.json";
import { VOICE_POLISH_STYLES } from "./voicePolish";

it("reconstructs both original and organized examples in every language", () => {
  for (const locale of [zh, en, tw, ja]) {
    const preview = locale.settings.voiceRecognition.polishingPreview;
    for (const mode of VOICE_POLISH_STYLES) {
      const changes = diffVoicePolishPreview(preview.source, preview.results[mode]);
      expect(changes.filter((change) => change.kind !== "added").map((change) => change.text).join("")).toBe(preview.source);
      expect(changes.filter((change) => change.kind !== "deleted").map((change) => change.text).join("")).toBe(preview.results[mode]);
      expect(changes.some((change) => change.kind === "deleted")).toBe(true);
    }
    expect(preview.results.continuous).not.toContain("\n");
    expect(preview.results.paragraphs).toContain("\n\n");
    expect(preview.results.structured).toContain("\n- ");
  }
});

it("keeps Unicode characters intact and handles empty or unchanged text", () => {
  expect(diffVoicePolishPreview("嗯，🙂", "🙂！")).toEqual([
    { kind: "deleted", text: "嗯，" }, { kind: "unchanged", text: "🙂" }, { kind: "added", text: "！" },
  ]);
  expect(diffVoicePolishPreview("", "")).toEqual([]);
  expect(diffVoicePolishPreview("原文", "原文")).toEqual([{ kind: "unchanged", text: "原文" }]);
});
