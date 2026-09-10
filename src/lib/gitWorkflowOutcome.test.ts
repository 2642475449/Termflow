import { expect, it } from "vitest";
import { getGitWorkflowOutcome } from "./gitWorkflowOutcome";

it("preserves the committed result when the remote step fails", () => {
  expect(
    getGitWorkflowOutcome({
      success: false,
      commitOid: "abc",
      failedStage: "push",
      message: "rejected",
    }),
  ).toBe("partial");
  expect(
    getGitWorkflowOutcome({
      success: false,
      commitOid: null,
      failedStage: "commit",
      message: "hook rejected",
    }),
  ).toBe("failed");
  expect(
    getGitWorkflowOutcome({
      success: true,
      commitOid: "abc",
      failedStage: null,
      message: "",
    }),
  ).toBe("success");
});
