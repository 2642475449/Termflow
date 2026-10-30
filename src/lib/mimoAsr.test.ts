import { expect, it } from "vitest";
import { buildMimoAsrRequest } from "./mimoAsr";

it("uses automatic detection for Chinese-English code-switching instead of forcing Chinese", () => {
  expect(buildMimoAsrRequest("data:audio/wav;base64,dGVzdA==", "mimo-v2.5-asr").asr_options)
    .toEqual({ language: "auto" });
});
