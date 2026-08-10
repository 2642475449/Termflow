import { describe, expect, it } from "vitest";
import {
  filterAndSortArchivedRows,
  normalizeArchivedSessionGroups,
  type ArchivedRow,
} from "@/lib/archivedSessions";

const rows: ArchivedRow[] = [
  {
    projectPath: "D:\\work\\Termflow",
    projectName: "Termflow",
    session: {
      id: "claude-session",
      path: "D:\\work\\Termflow",
      name: "Fix archived sessions",
      createdAt: 1,
      archivedAt: 100,
      active: false,
      agentId: "claude",
    },
  },
  {
    projectPath: "D:\\work\\Docs",
    projectName: "Docs",
    session: {
      id: "codex-session",
      path: "D:\\work\\Docs\\guide",
      name: "Review guide",
      createdAt: 2,
      archivedAt: 200,
      active: false,
      agentId: "codex",
    },
  },
];

describe("filterAndSortArchivedRows", () => {
  it("filters by search text, agent, and project", () => {
    expect(filterAndSortArchivedRows(rows, {
      query: "guide",
      agent: "codex",
      project: "D:\\work\\Docs",
      sort: "recent",
    }).map((row) => row.session.id)).toEqual(["codex-session"]);
  });

  it("sorts recent, oldest, and name order", () => {
    expect(filterAndSortArchivedRows(rows, { query: "", agent: "all", project: "all", sort: "recent" })[0].session.id)
      .toBe("codex-session");
    expect(filterAndSortArchivedRows(rows, { query: "", agent: "all", project: "all", sort: "oldest" })[0].session.id)
      .toBe("claude-session");
    expect(filterAndSortArchivedRows(rows, { query: "", agent: "all", project: "all", sort: "name" })[0].session.name)
      .toBe("Fix archived sessions");
  });

  it("normalizes removed-agent and malformed persisted archive data", () => {
    expect(normalizeArchivedSessionGroups({
      "D:/demo": [
        {
          id: "retired-agent",
          name: "Retired agent session",
          path: "D:/demo",
          createdAt: 1,
          active: true,
          agentId: "retired-agent",
        },
        { id: "missing-fields" },
        { name: "missing-id" },
      ],
      "D:/broken": null,
    })).toEqual({
      "D:/demo": [
        expect.objectContaining({
          id: "retired-agent",
          agentId: undefined,
          active: false,
          status: "stopped",
          archived: true,
        }),
        expect.objectContaining({
          id: "missing-fields",
          name: "missing-fields",
          path: "D:/demo",
          createdAt: 0,
        }),
      ],
    });
  });
});
