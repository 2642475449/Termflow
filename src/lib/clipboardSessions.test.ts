import { describe, expect, it } from "vitest";
import { collectClipboardSessionIds, removedClipboardSessionIds } from "./clipboardSessions";

describe("clipboard session references", () => {
  it("keeps closed, archived and other-project sessions protected", () => {
    const before = collectClipboardSessionIds({ sessions: [{ id: "a" }], projectSessions: { a: [{ id: "a" }], b: [{ id: "b" }] }, projectArchivedSessions: {} });
    const after = collectClipboardSessionIds({ sessions: [{ id: "b" }], projectSessions: { b: [{ id: "b" }] }, projectArchivedSessions: { a: [{ id: "a" }] } });
    expect(removedClipboardSessionIds(before, after)).toEqual([]);
    expect(after).toEqual(["a", "b"]);
  });

  it("releases only sessions absent from every collection", () => {
    const after = collectClipboardSessionIds({ sessions: [], projectSessions: { a: [{ id: "kept" }] }, projectArchivedSessions: {} });
    expect(removedClipboardSessionIds(["deleted", "kept"], after)).toEqual(["deleted"]);
  });
});
