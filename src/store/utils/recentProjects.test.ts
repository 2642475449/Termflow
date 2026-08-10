import { describe, expect, it } from "vitest";
import type { Session } from "@/types";
import {
  deriveLegacyRecentProjects,
  migrateRecentProjectState,
  normalizeRehydratedProjectSessions,
  RECENT_PROJECT_LIMIT,
  rehydrateRecentProjectState,
  touchRecentProjects,
  type RecentProjectEntry,
} from "./recentProjects";

function createSession(id: string, createdAt: number, lastEventAt?: number): Session {
  return {
    id,
    name: `session-${id}`,
    path: `D:/workspace/${id}`,
    createdAt,
    active: true,
    lastEventAt,
  };
}

describe("recentProjects utils", () => {
  it("touchRecentProjects puts latest project first and removes duplicates", () => {
    const recentProjects: RecentProjectEntry[] = [
      { path: "D:/b", name: "b", lastOpenedAt: 200 },
      { path: "D:/a", name: "a-old", lastOpenedAt: 100 },
      { path: "D:/c", name: "c", lastOpenedAt: 50 },
    ];

    const result = touchRecentProjects(
      recentProjects,
      { path: "D:/a", name: "a-new" },
      500
    );

    expect(result).toEqual([
      { path: "D:/a", name: "a-new", lastOpenedAt: 500 },
      { path: "D:/b", name: "b", lastOpenedAt: 200 },
      { path: "D:/c", name: "c", lastOpenedAt: 50 },
    ]);
  });

  it("touchRecentProjects keeps only the latest ten projects", () => {
    const recentProjects = Array.from({ length: RECENT_PROJECT_LIMIT }, (_, index) => ({
      path: `D:/${index}`,
      name: `project-${index}`,
      lastOpenedAt: RECENT_PROJECT_LIMIT - index,
    }));

    const result = touchRecentProjects(
      recentProjects,
      { path: "D:/fresh", name: "fresh" },
      999
    );

    expect(result).toHaveLength(RECENT_PROJECT_LIMIT);
    expect(result[0]).toEqual({
      path: "D:/fresh",
      name: "fresh",
      lastOpenedAt: 999,
    });
    expect(result.some((item) => item.path === "D:/9")).toBe(false);
  });

  it("deriveLegacyRecentProjects builds recent list from session timestamps", () => {
    const result = deriveLegacyRecentProjects({
      "D:/alpha": [
        createSession("a1", 100, 120),
        createSession("a2", 150, 180),
      ],
      "D:/beta": [createSession("b1", 90, 95)],
    });

    expect(result).toEqual([
      { path: "D:/alpha", name: "alpha", lastOpenedAt: 180 },
      { path: "D:/beta", name: "beta", lastOpenedAt: 95 },
    ]);
  });

  it("deriveLegacyRecentProjects prefers existing recent list and trims invalid entries", () => {
    const result = deriveLegacyRecentProjects(
      {
        "D:/alpha": [createSession("a1", 100, 120)],
      },
      [
        { path: " ", name: "invalid", lastOpenedAt: 999 },
        { path: "D:/older", name: "older", lastOpenedAt: 10 },
        { path: "D:/newer", name: "newer", lastOpenedAt: 20 },
      ]
    );

    expect(result).toEqual([
      { path: "D:/newer", name: "newer", lastOpenedAt: 20 },
      { path: "D:/older", name: "older", lastOpenedAt: 10 },
    ]);
  });

  it("migrateRecentProjectState derives recent projects during persist migration", () => {
    const migrated = migrateRecentProjectState({
      projectSessions: {
        "D:/demo": [createSession("d1", 100, 300)],
      },
    });

    expect(migrated?.recentProjects).toEqual([
      { path: "D:/demo", name: "demo", lastOpenedAt: 300 },
    ]);
  });

  it("normalizeRehydratedProjectSessions marks restored sessions as inactive", () => {
    const result = normalizeRehydratedProjectSessions({
      "D:/demo": [createSession("d1", 100, 300)],
    });

    expect(result["D:/demo"][0].active).toBe(false);
    expect(result["D:/demo"][0].lastEventAt).toBe(300);
  });

  it("rehydrateRecentProjectState recomputes recent projects from normalized sessions", () => {
    const result = rehydrateRecentProjectState({
      projectSessions: {
        "D:/beta": [createSession("b1", 100, 400)],
      },
      recentProjects: [
        { path: "D:/stale", name: "stale", lastOpenedAt: 1 },
      ],
    });

    expect(result.normalizedProjectSessions["D:/beta"][0].active).toBe(false);
    expect(result.recentProjects).toEqual([
      { path: "D:/stale", name: "stale", lastOpenedAt: 1 },
    ]);
  });
});
