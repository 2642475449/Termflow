import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session, WindowProjectContext } from "@/types";
import { createDefaultWorkspace } from "./utils/workspace";
import { applyPersistentSettingsToStore, createAppStore, getPersistentSettingsSnapshot } from "./index";
import { useAppStore } from "./index";

function createSession(
  id: string,
  name: string,
  path = "D:/workspace/demo",
  overrides: Partial<Session> = {}
): Session {
  return {
    id,
    name,
    path,
    createdAt: 100,
    active: true,
    status: "running",
    unreadCount: 0,
    ...overrides,
  };
}

function createProjectContext(
  projectPath = "D:/workspace/demo",
  overrides: Partial<WindowProjectContext> = {}
): WindowProjectContext {
  return {
    windowLabel: "project:test",
    mode: "project",
    projectPath,
    projectName: projectPath.split(/[\\/]/).pop(),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useAppStore actions", () => {
  it("initializeWindowContext hydrates project state and normalizes workspace", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));

    const store = createAppStore();
    const projectPath = "D:/workspace/demo";
    const session = createSession("s1", "会话一", projectPath, { unreadCount: 2 });
    const workspace = createDefaultWorkspace();

    workspace.panesById.main.tabIds = ["s1", "missing"];
    workspace.panesById.main.activeTabId = "missing";
    workspace.panesById.main.history = ["missing", "s1"];

    store.setState({
      projectSessions: { [projectPath]: [session] },
      projectWorkspaces: { [projectPath]: workspace },
      recentProjects: [],
    });

    store.getState().initializeWindowContext(createProjectContext(projectPath));

    const state = store.getState();
    expect(state.windowContextReady).toBe(true);
    expect(state.currentProject).toEqual({ path: projectPath, name: "demo" });
    expect(state.sessions).toHaveLength(1);
    expect(state.openTabs).toEqual(["s1"]);
    expect(state.activeSessionId).toBe("s1");
    expect(state.unreadTotal).toBe(2);
    expect(state.recentProjects[0]).toMatchObject({
      path: projectPath,
      name: "demo",
      lastOpenedAt: new Date("2026-05-15T12:00:00Z").getTime(),
    });
  });

  it("setCurrentProject switches project and updates recent projects", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:10:00Z"));

    const store = createAppStore();
    const projectPath = "D:/workspace/alpha";
    const session = createSession("s1", "Alpha", projectPath, { unreadCount: 3 });

    store.setState({
      projectSessions: { [projectPath]: [session] },
      recentProjects: [{ path: "D:/workspace/old", name: "old", lastOpenedAt: 1 }],
    });

    store.getState().setCurrentProject({ path: projectPath, name: "alpha" });

    const state = store.getState();
    expect(state.currentProject).toEqual({ path: projectPath, name: "alpha" });
    expect(state.sessions[0].id).toBe("s1");
    expect(state.unreadTotal).toBe(3);
    expect(state.recentProjects[0].path).toBe(projectPath);
  });

  it("addSession and setActiveSession open tab and clear unread count", () => {
    const store = createAppStore();
    const projectPath = "D:/workspace/demo";
    store.setState({
      currentProject: { path: projectPath, name: "demo" },
      projectSessions: { [projectPath]: [] },
      projectWorkspaces: { [projectPath]: createDefaultWorkspace() },
    });

    store.getState().addSession(
      createSession("s1", "新会话", projectPath, {
        unreadCount: 5,
        active: false,
        status: undefined,
        agentId: "codex",
        agentExecutablePath: "C:/tools/codex.exe",
      })
    );
    store.getState().setActiveSession("s1");

    const state = store.getState();
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].titleSource).toBe("default");
    expect(state.sessions[0].status).toBe("waiting");
    expect(state.sessions[0].unreadCount).toBe(0);
    expect(state.sessions[0].agentId).toBe("codex");
    expect(state.sessions[0].agentExecutablePath).toBe("C:/tools/codex.exe");
    expect(state.openTabs).toEqual(["s1"]);
    expect(state.activeSessionId).toBe("s1");
    expect(state.unreadTotal).toBe(0);
  });

  it("closeTab discards ephemeral terminal state instead of preserving a resumable session", () => {
    const store = createAppStore();
    const projectPath = "D:/workspace/demo";
    store.setState({
      currentProject: { path: projectPath, name: "demo" },
      projectSessions: { [projectPath]: [] },
      projectWorkspaces: { [projectPath]: createDefaultWorkspace() },
    });

    store.getState().addSession(
      createSession("terminal", "PowerShell", projectPath, {
        agentId: "powershell",
        ephemeral: true,
        hasPromptHistory: false,
      }),
    );
    expect(store.getState().openTabs).toEqual(["terminal"]);

    store.getState().closeTab("terminal");

    expect(store.getState().projectSessions[projectPath]).toEqual([]);
    expect(store.getState().sessions).toEqual([]);
    expect(store.getState().openTabs).toEqual([]);
  });

  it("splitTab moves the selected tab into a new pane and activates it", () => {
    const store = createAppStore();
    const projectPath = "D:/workspace/demo";
    const sessionA = createSession("a", "A", projectPath);
    const sessionB = createSession("b", "B", projectPath);
    const workspace = createDefaultWorkspace();
    workspace.panesById.main.tabIds = ["a", "b"];
    workspace.panesById.main.activeTabId = "b";
    workspace.panesById.main.history = ["a", "b"];
    workspace.tabsById = {
      a: { id: "a", kind: "session", resourceId: "a", title: "A", closable: true, pinned: false, dirty: false, preview: false, createdAt: 1, lastActivatedAt: 1 },
      b: { id: "b", kind: "session", resourceId: "b", title: "B", closable: true, pinned: false, dirty: false, preview: false, createdAt: 2, lastActivatedAt: 2 },
    };

    store.setState({
      currentProject: { path: projectPath, name: "demo" },
      projectSessions: { [projectPath]: [sessionA, sessionB] },
      projectWorkspaces: { [projectPath]: workspace },
      sessions: [sessionA, sessionB],
      tabsById: workspace.tabsById,
      panesById: workspace.panesById,
      activeSessionId: "b",
      openTabs: ["a", "b"],
    });

    store.getState().splitTab("b", "right", "main");

    const state = store.getState();
    const newPane = Object.values(state.panesById).find((pane) => pane.id !== "main");
    expect(state.panesById.main.tabIds).toEqual(["a"]);
    expect(newPane?.tabIds).toEqual(["b"]);
    expect(state.activePaneId).toBe(newPane?.id);
    expect(state.activeSessionId).toBe("b");
    expect(state.layout.root).toMatchObject({ type: "split", direction: "horizontal" });

    store.getState().closeTab("b");
    const collapsed = store.getState();
    expect(Object.keys(collapsed.panesById)).toEqual(["main"]);
    expect(collapsed.layout.root).toEqual({ type: "pane", paneId: "main" });
    expect(collapsed.activeSessionId).toBe("a");
  });

  it("removeSession and removeAllSessions clean workspace tabs", () => {
    const store = createAppStore();
    const projectPath = "D:/workspace/demo";
    const sessionA = createSession("a", "A", projectPath);
    const sessionB = createSession("b", "B", projectPath);
    const workspace = createDefaultWorkspace();
    workspace.panesById.main.tabIds = ["a", "b"];
    workspace.panesById.main.activeTabId = "b";
    workspace.panesById.main.history = ["a", "b"];

    store.setState({
      currentProject: { path: projectPath, name: "demo" },
      projectSessions: { [projectPath]: [sessionA, sessionB] },
      projectWorkspaces: { [projectPath]: workspace },
      sessions: [sessionA, sessionB],
      tabsById: {
        a: { id: "a", kind: "session", resourceId: "a", title: "A", closable: true, pinned: false, dirty: false, preview: false, createdAt: 1, lastActivatedAt: 1 },
        b: { id: "b", kind: "session", resourceId: "b", title: "B", closable: true, pinned: false, dirty: false, preview: false, createdAt: 2, lastActivatedAt: 2 },
      },
      panesById: workspace.panesById,
      activeSessionId: "b",
      openTabs: ["a", "b"],
    });

    store.getState().removeSession("b");
    let state = store.getState();
    expect(state.sessions.map((session) => session.id)).toEqual(["a"]);
    expect(state.openTabs).toEqual(["a"]);
    expect(state.activeSessionId).toBe("a");

    store.getState().removeAllSessions();
    state = store.getState();
    expect(state.sessions).toEqual([]);
    expect(state.openTabs).toEqual([]);
    expect(state.activeSessionId).toBeNull();
  });

  it("closeTab marks closed session inactive so it can be resumed from sidebar", () => {
    const store = createAppStore();
    const projectPath = "D:/workspace/demo";
    const session = createSession("s1", "会话一", projectPath, {
      active: true,
      status: "running",
    });
    const workspace = createDefaultWorkspace();
    workspace.panesById.main.tabIds = ["s1"];
    workspace.panesById.main.activeTabId = "s1";
    workspace.panesById.main.history = ["s1"];

    store.setState({
      currentProject: { path: projectPath, name: "demo" },
      projectSessions: { [projectPath]: [session] },
      projectWorkspaces: { [projectPath]: workspace },
      sessions: [session],
      tabsById: {
        s1: {
          id: "s1",
          kind: "session",
          resourceId: "s1",
          title: "会话一",
          closable: true,
          pinned: false,
          dirty: false,
          preview: false,
          createdAt: 1,
          lastActivatedAt: 1,
        },
      },
      panesById: workspace.panesById,
      activeSessionId: "s1",
      openTabs: ["s1"],
    });

    store.getState().closeTab("s1");

    const state = store.getState();
    expect(state.openTabs).toEqual([]);
    expect(state.activeSessionId).toBeNull();
    expect(state.sessions[0]).toMatchObject({
      id: "s1",
      active: false,
      status: "stopped",
    });
  });

  it("archiveSession stores archived session as inactive and stopped", () => {
    const store = createAppStore();
    const projectPath = "D:/workspace/demo";
    const session = createSession("s1", "会话一", projectPath, {
      active: true,
      status: "running",
    });
    const workspace = createDefaultWorkspace();
    workspace.panesById.main.tabIds = ["s1"];
    workspace.panesById.main.activeTabId = "s1";
    workspace.panesById.main.history = ["s1"];

    store.setState({
      currentProject: { path: projectPath, name: "demo" },
      projectSessions: { [projectPath]: [session] },
      projectWorkspaces: { [projectPath]: workspace },
      projectArchivedSessions: { [projectPath]: [] },
      sessions: [session],
      tabsById: {
        s1: {
          id: "s1",
          kind: "session",
          resourceId: "s1",
          title: "会话一",
          closable: true,
          pinned: false,
          dirty: false,
          preview: false,
          createdAt: 1,
          lastActivatedAt: 1,
        },
      },
      panesById: workspace.panesById,
      activeSessionId: "s1",
      openTabs: ["s1"],
    });

    store.getState().archiveSession("s1");

    const state = store.getState();
    expect(state.sessions).toEqual([]);
    expect(state.openTabs).toEqual([]);
    expect(state.activeSessionId).toBeNull();
    expect(state.projectArchivedSessions[projectPath][0]).toMatchObject({
      id: "s1",
      archived: true,
      active: false,
      status: "stopped",
    });
  });

  it("archiveAllSessionsInSection normalizes archived session runtime state", () => {
    const store = createAppStore();
    const projectPath = "D:/workspace/demo";
    const pinnedSession = createSession("p1", "Pinned", projectPath, {
      pinned: true,
      active: true,
      status: "running",
    });
    const normalSession = createSession("n1", "Normal", projectPath, {
      pinned: false,
      active: true,
      status: "running",
    });
    const workspace = createDefaultWorkspace();
    workspace.panesById.main.tabIds = ["p1", "n1"];
    workspace.panesById.main.activeTabId = "n1";
    workspace.panesById.main.history = ["p1", "n1"];

    store.setState({
      currentProject: { path: projectPath, name: "demo" },
      projectSessions: { [projectPath]: [pinnedSession, normalSession] },
      projectWorkspaces: { [projectPath]: workspace },
      projectArchivedSessions: { [projectPath]: [] },
      sessions: [pinnedSession, normalSession],
      tabsById: {
        p1: {
          id: "p1",
          kind: "session",
          resourceId: "p1",
          title: "Pinned",
          closable: true,
          pinned: true,
          dirty: false,
          preview: false,
          createdAt: 1,
          lastActivatedAt: 1,
        },
        n1: {
          id: "n1",
          kind: "session",
          resourceId: "n1",
          title: "Normal",
          closable: true,
          pinned: false,
          dirty: false,
          preview: false,
          createdAt: 2,
          lastActivatedAt: 2,
        },
      },
      panesById: workspace.panesById,
      activeSessionId: "n1",
      openTabs: ["p1", "n1"],
    });

    store.getState().archiveAllSessionsInSection("normal");

    const state = store.getState();
    expect(state.sessions.map((session) => session.id)).toEqual(["p1"]);
    expect(state.openTabs).toEqual(["p1"]);
    expect(state.projectArchivedSessions[projectPath][0]).toMatchObject({
      id: "n1",
      archived: true,
      active: false,
      status: "stopped",
    });
  });

  it("focusSessionFromEvent switches project, opens tab and marks event read", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:20:00Z"));

    const store = createAppStore();
    const targetPath = "D:/workspace/target";
    const targetSession = createSession("s2", "目标会话", targetPath, { unreadCount: 4 });

    store.setState({
      currentProject: { path: "D:/workspace/source", name: "source" },
      projectSessions: { [targetPath]: [targetSession] },
      projectWorkspaces: { [targetPath]: createDefaultWorkspace() },
      sessionEvents: [
        {
          id: "e1",
          sessionId: "s2",
          projectPath: targetPath,
          sessionName: "目标会话",
          eventType: "waiting_input",
          title: "等待输入",
          body: "",
          severity: "warning",
          source: "runtime",
          requiresAttention: true,
          actionable: true,
          createdAt: 200,
          read: false,
        },
      ],
      recentProjects: [],
    });

    store.getState().focusSessionFromEvent({
      id: "e1",
      sessionId: "s2",
      projectPath: targetPath,
      sessionName: "目标会话",
      eventType: "waiting_input",
      title: "等待输入",
      body: "",
      severity: "warning",
      source: "runtime",
      requiresAttention: true,
      actionable: true,
      createdAt: 200,
    });

    const state = store.getState();
    expect(state.currentProject).toEqual({ path: targetPath, name: "target" });
    expect(state.sessions[0].unreadCount).toBe(0);
    expect(state.openTabs).toEqual(["s2"]);
    expect(state.activeSessionId).toBe("s2");
    expect(state.sessionEvents[0].read).toBe(true);
    expect(state.recentProjects[0]).toMatchObject({
      path: targetPath,
      name: "target",
      lastOpenedAt: new Date("2026-05-15T12:20:00Z").getTime(),
    });
  });

  it("pushSessionEvent keeps newly started sessions in waiting state", () => {
    const store = createAppStore();
    const projectPath = "D:/workspace/demo";
    const session = createSession("s1", "新会话", projectPath, { status: "waiting" });

    store.setState({
      currentProject: { path: projectPath, name: "demo" },
      projectSessions: { [projectPath]: [session] },
      projectWorkspaces: { [projectPath]: createDefaultWorkspace() },
      sessions: [session],
    });

    store.getState().pushSessionEvent({
      id: "e1",
      sessionId: "s1",
      projectPath,
      sessionName: "新会话",
      eventType: "session_started",
      title: "会话已启动",
      body: "",
      severity: "info",
      source: "runtime",
      requiresAttention: false,
      actionable: true,
      createdAt: 200,
    });

    const state = store.getState();
    expect(state.sessions[0].status).toBe("waiting");
    expect(state.sessions[0].lastEventType).toBe("session_started");
  });

  it("pushSessionEvent deduplicates events before unread state changes", () => {
    const store = createAppStore();
    const projectPath = "D:/workspace/demo";
    const session = createSession("s1", "会话一", projectPath);
    store.setState({
      currentProject: { path: projectPath, name: "demo" },
      projectSessions: { [projectPath]: [session] },
      projectWorkspaces: { [projectPath]: createDefaultWorkspace() },
      sessions: [session],
    });
    const event = {
      id: "event-1",
      revision: 1,
      sessionId: "s1",
      projectPath,
      sessionName: "会话一",
      eventType: "permission_request" as const,
      title: "等待授权",
      body: "",
      severity: "warning" as const,
      source: "codex_hook",
      requiresAttention: true,
      actionable: true,
      dedupeKey: "permission-1",
      createdAt: 200,
    };

    expect(store.getState().pushSessionEvent(event)).toBe("accepted");
    expect(store.getState().pushSessionEvent({ ...event, id: "event-2" })).toBe("duplicate");
    expect(store.getState().sessionEvents).toHaveLength(1);
    expect(store.getState().sessions[0].unreadCount).toBe(1);

    store.getState().openTab("s1");
    expect(store.getState().sessionEvents[0].read).toBe(true);
    expect(store.getState().sessions[0].unreadCount).toBe(0);

    expect(store.getState().pushSessionEvent({
      id: "runtime-update",
      sessionId: "s1",
      projectPath,
      sessionName: "会话一",
      eventType: "session_started",
      title: "会话已启动",
      body: "",
      severity: "info",
      source: "runtime",
      requiresAttention: false,
      actionable: true,
      createdAt: 300,
    })).toBe("accepted");
    expect(store.getState().sessions[0].unreadCount).toBe(0);
  });

  it("pushSessionEvent treats non-attention events as read", () => {
    const store = createAppStore();
    const projectPath = "D:/workspace/demo";
    const session = createSession("s1", "会话一", projectPath, { status: "waiting" });
    store.setState({
      currentProject: { path: projectPath, name: "demo" },
      projectSessions: { [projectPath]: [session] },
      projectWorkspaces: { [projectPath]: createDefaultWorkspace() },
      sessions: [session],
    });

    expect(store.getState().pushSessionEvent({
      id: "started",
      sessionId: "s1",
      projectPath,
      sessionName: "会话一",
      eventType: "session_started",
      title: "会话已启动",
      body: "",
      severity: "info",
      source: "runtime",
      requiresAttention: false,
      actionable: true,
      createdAt: 200,
    })).toBe("accepted");

    expect(store.getState().sessionEvents[0].read).toBe(true);
    expect(store.getState().sessions[0].unreadCount).toBe(0);
  });

  it("revisioned attention events cannot roll back runtime status", () => {
    const store = createAppStore();
    const projectPath = "D:/workspace/demo";
    const session = createSession("s1", "会话一", projectPath, {
      status: "running",
      statusRevision: 3,
    });
    store.setState({
      currentProject: { path: projectPath, name: "demo" },
      projectSessions: { [projectPath]: [session] },
      projectWorkspaces: { [projectPath]: createDefaultWorkspace() },
      sessions: [session],
    });

    const staleResult = store.getState().pushSessionEvent({
      id: "old-waiting",
      revision: 2,
      sessionId: "s1",
      projectPath,
      sessionName: "会话一",
      eventType: "waiting_input",
      title: "等待输入",
      body: "",
      severity: "warning",
      source: "claude_hook",
      requiresAttention: true,
      actionable: true,
      createdAt: 200,
    });
    expect(staleResult).toBe("stale");

    const pairedResult = store.getState().pushSessionEvent({
      id: "current-complete",
      revision: 3,
      sessionId: "s1",
      projectPath,
      sessionName: "会话一",
      eventType: "assistant_complete",
      title: "已完成",
      body: "",
      severity: "info",
      source: "claude_hook",
      requiresAttention: true,
      actionable: true,
      createdAt: 300,
    });
    expect(pairedResult).toBe("accepted");
    expect(store.getState().sessions[0].status).toBe("running");
    expect(store.getState().sessionEvents).toHaveLength(1);
  });

  it("delayed completion cannot revive a stopped session", () => {
    const store = createAppStore();
    const projectPath = "D:/workspace/demo";
    const session = createSession("s1", "会话一", projectPath, {
      status: "stopped",
      statusRevision: 2,
      statusUpdatedAt: 400,
      lastEventAt: 400,
    });
    store.setState({
      currentProject: { path: projectPath, name: "demo" },
      projectSessions: { [projectPath]: [session] },
      projectWorkspaces: { [projectPath]: createDefaultWorkspace() },
      sessions: [session],
    });

    const result = store.getState().pushSessionEvent({
      id: "delayed-complete",
      revision: 3,
      sessionId: "s1",
      projectPath,
      sessionName: "会话一",
      eventType: "assistant_complete",
      title: "已完成",
      body: "",
      severity: "info",
      source: "claude_hook",
      requiresAttention: true,
      actionable: true,
      createdAt: 300,
    });

    expect(result).toBe("stale");
    expect(store.getState().sessions[0].status).toBe("stopped");
    expect(store.getState().sessionEvents).toHaveLength(0);
  });

  it("projects accepted events into one Attention item per Session", () => {
    const store = createAppStore();
    const projectPath = "D:/workspace/demo";
    const session = createSession("s1", "会话一", projectPath, {
      status: "waiting",
      statusRevision: 1,
      agentId: "codex",
    });
    store.setState({
      currentProject: { path: projectPath, name: "demo" },
      projectSessions: { [projectPath]: [session] },
      projectWorkspaces: { [projectPath]: createDefaultWorkspace() },
      sessions: [session],
    });

    const permissionEvent = {
      id: "permission-1",
      revision: 1,
      sessionId: "s1",
      projectPath,
      sessionName: "会话一",
      eventType: "permission_request" as const,
      title: "等待授权",
      body: "打开会话处理",
      severity: "warning" as const,
      source: "codex",
      requiresAttention: true,
      actionable: true,
      createdAt: 200,
    };

    expect(store.getState().pushSessionEvent(permissionEvent)).toBe("accepted");
    expect(store.getState().projectAttentionItems[projectPath]).toHaveLength(1);
    expect(store.getState().projectAttentionItems[projectPath][0]).toMatchObject({
      kind: "permission",
      disposition: "open",
      sourceEventId: "permission-1",
    });
    expect(store.getState().pushSessionEvent(permissionEvent)).toBe("duplicate");
    expect(store.getState().projectAttentionItems[projectPath]).toHaveLength(1);
  });

  it("does not open Attention for a completion already observed in the foreground", () => {
    const store = createAppStore();
    const projectPath = "D:/workspace/demo";
    const session = createSession("s1", "会话一", projectPath, {
      status: "completed",
      statusRevision: 1,
      agentId: "claude",
    });
    store.setState({
      currentProject: { path: projectPath, name: "demo" },
      projectSessions: { [projectPath]: [session] },
      projectWorkspaces: { [projectPath]: createDefaultWorkspace() },
      sessions: [session],
      activeSessionId: "s1",
    });

    expect(store.getState().pushSessionEvent({
      id: "foreground-complete",
      revision: 1,
      sessionId: "s1",
      projectPath,
      sessionName: "会话一",
      eventType: "assistant_complete",
      title: "已完成",
      body: "打开查看结果",
      severity: "success",
      source: "claude",
      requiresAttention: true,
      actionable: true,
      createdAt: 200,
      read: true,
      observedAtDelivery: true,
    })).toBe("accepted");

    expect(store.getState().projectAttentionItems[projectPath][0]).toMatchObject({
      kind: "completion",
      disposition: "resolved",
      seenAt: 200,
      resolutionReason: "observed-in-foreground",
    });
    expect(store.getState().sessions[0].unreadCount).toBe(0);
  });

  it("resolves an Attention item when a newer run starts", () => {
    const store = createAppStore();
    const projectPath = "D:/workspace/demo";
    const session = createSession("s1", "会话一", projectPath, {
      status: "waiting",
      statusRevision: 2,
      agentId: "claude",
    });
    store.setState({
      currentProject: { path: projectPath, name: "demo" },
      projectSessions: { [projectPath]: [session] },
      projectWorkspaces: { [projectPath]: createDefaultWorkspace() },
      sessions: [session],
    });
    store.getState().pushSessionEvent({
      id: "waiting-1",
      revision: 2,
      sessionId: "s1",
      projectPath,
      sessionName: "会话一",
      eventType: "waiting_input",
      title: "等待输入",
      body: "",
      severity: "warning",
      source: "claude",
      requiresAttention: true,
      actionable: true,
      createdAt: 200,
    });

    store.getState().updateSession("s1", {
      status: "running",
      statusRevision: 3,
      statusUpdatedAt: 300,
    });

    expect(store.getState().projectAttentionItems[projectPath][0]).toMatchObject({
      disposition: "resolved",
      resolvedAt: 300,
      resolutionReason: "new-run-started",
    });
  });

  it("opening a Session resolves completion but only sees waiting", () => {
    vi.useFakeTimers();
    vi.setSystemTime(500);
    const store = createAppStore();
    const projectPath = "D:/workspace/demo";
    const waitingSession = createSession("waiting", "等待会话", projectPath, {
      status: "waiting",
      agentId: "codex",
    });
    const completedSession = createSession("completed", "完成会话", projectPath, {
      status: "completed",
      agentId: "claude",
    });
    store.setState({
      currentProject: { path: projectPath, name: "demo" },
      projectSessions: { [projectPath]: [waitingSession, completedSession] },
      projectWorkspaces: { [projectPath]: createDefaultWorkspace() },
      sessions: [waitingSession, completedSession],
    });
    store.getState().pushSessionEvent({
      id: "waiting-event",
      sessionId: "waiting",
      projectPath,
      sessionName: "等待会话",
      eventType: "waiting_input",
      title: "等待输入",
      body: "",
      severity: "warning",
      source: "codex",
      requiresAttention: true,
      actionable: true,
      createdAt: 200,
    });
    store.getState().pushSessionEvent({
      id: "complete-event",
      sessionId: "completed",
      projectPath,
      sessionName: "完成会话",
      eventType: "assistant_complete",
      title: "已完成",
      body: "",
      severity: "success",
      source: "claude",
      requiresAttention: true,
      actionable: true,
      createdAt: 300,
    });

    store.getState().openTab("waiting");
    store.getState().openTab("completed");

    const items = store.getState().projectAttentionItems[projectPath];
    expect(items.find((item) => item.sessionId === "waiting")).toMatchObject({
      disposition: "open",
      seenAt: 500,
    });
    expect(items.find((item) => item.sessionId === "completed")).toMatchObject({
      disposition: "resolved",
      resolutionReason: "session-opened",
      resolvedAt: 500,
    });
  });

  it("switching directly to an existing Session tab resolves its completion", () => {
    vi.useFakeTimers();
    vi.setSystemTime(550);
    const store = createAppStore();
    const projectPath = "D:/workspace/demo";
    const backgroundSession = createSession("background", "后台会话", projectPath, {
      status: "completed",
      agentId: "claude",
    });
    const foregroundSession = createSession("foreground", "当前会话", projectPath, {
      status: "waiting",
      agentId: "codex",
    });
    store.setState({
      currentProject: { path: projectPath, name: "demo" },
      projectSessions: { [projectPath]: [backgroundSession, foregroundSession] },
      projectWorkspaces: { [projectPath]: createDefaultWorkspace() },
      sessions: [backgroundSession, foregroundSession],
    });

    // Both Sessions already exist as tabs, while the foreground Session covers
    // the completed background Session in the same Pane.
    store.getState().openTab("background");
    store.getState().openTab("foreground");
    store.getState().pushSessionEvent({
      id: "background-complete",
      sessionId: "background",
      projectPath,
      sessionName: "后台会话",
      eventType: "assistant_complete",
      title: "已完成",
      body: "",
      severity: "success",
      source: "claude",
      requiresAttention: true,
      actionable: true,
      createdAt: 500,
    });

    expect(store.getState().projectAttentionItems[projectPath][0]).toMatchObject({
      sessionId: "background",
      disposition: "open",
    });

    // Clicking the existing tab is enough evidence that the completion was
    // viewed; the user must not have to visit Attention Center as a second step.
    store.getState().setActiveSession("background");

    expect(store.getState().projectAttentionItems[projectPath][0]).toMatchObject({
      sessionId: "background",
      disposition: "resolved",
      resolutionReason: "session-opened",
      resolvedAt: 550,
    });
  });

  it("supports manual disposition and expires items when Sessions are deleted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(600);
    const store = createAppStore();
    const projectPath = "D:/workspace/demo";
    const session = createSession("s1", "会话一", projectPath, {
      status: "error",
      agentId: "antigravity",
    });
    store.setState({
      currentProject: { path: projectPath, name: "demo" },
      projectSessions: { [projectPath]: [session] },
      projectWorkspaces: { [projectPath]: createDefaultWorkspace() },
      sessions: [session],
    });
    store.getState().pushSessionEvent({
      id: "error-event",
      sessionId: "s1",
      projectPath,
      sessionName: "会话一",
      eventType: "process_error",
      title: "执行失败",
      body: "",
      severity: "error",
      source: "antigravity",
      requiresAttention: true,
      actionable: true,
      createdAt: 200,
    });
    const id = store.getState().projectAttentionItems[projectPath][0].id;

    store.getState().markAttentionSeen(id);
    expect(store.getState().projectAttentionItems[projectPath][0].seenAt).toBe(600);
    store.getState().dismissAttention(id);
    expect(store.getState().projectAttentionItems[projectPath][0].disposition).toBe("dismissed");

    store.getState().pushSessionEvent({
      id: "error-event-2",
      sessionId: "s1",
      projectPath,
      sessionName: "会话一",
      eventType: "process_error",
      title: "再次失败",
      body: "",
      severity: "error",
      source: "antigravity",
      requiresAttention: true,
      actionable: true,
      createdAt: 300,
    });
    store.getState().removeSession("s1");
    expect(store.getState().projectAttentionItems[projectPath][0]).toMatchObject({
      sourceEventId: "error-event-2",
      disposition: "expired",
      resolutionReason: "session-deleted",
    });
  });

  it("records Hook, event and notification diagnostics without persistence side effects", () => {
    const store = createAppStore();
    store.getState().setAgentHookDiagnostic({
      agentId: "codex",
      configured: true,
      configPath: "C:/Users/test/.codex/hooks.json",
      checkedAt: 100,
    });
    store.getState().recordAttentionEventDiagnostic({
      eventId: "event-1",
      sessionId: "s1",
      eventType: "assistant_complete",
      source: "codex",
      revision: 2,
      createdAt: 200,
      receivedAt: 210,
      outcome: "accepted",
      requiresAttention: true,
      foreground: true,
    });
    store.getState().recordNotificationDelivery({
      eventId: "event-1",
      eventType: "assistant_complete",
      status: "suppressed",
      reason: "foreground-session",
      updatedAt: 220,
    });

    expect(store.getState().attentionDiagnostics).toMatchObject({
      hooks: { codex: { configured: true, checkedAt: 100 } },
      lastEvent: { eventId: "event-1", outcome: "accepted", foreground: true },
      lastNotification: {
        eventId: "event-1",
        status: "suppressed",
        reason: "foreground-session",
      },
    });
  });
});

describe("Feishu notification settings", () => {
  const originalSettings = getPersistentSettingsSnapshot();

  afterEach(() => {
    applyPersistentSettingsToStore(originalSettings);
  });

  it("round-trips non-sensitive Feishu preferences through persistent settings", () => {
    applyPersistentSettingsToStore({
      ...originalSettings,
      feishuNotificationEnabled: true,
      feishuNotificationThresholdMs: 600000,
      feishuNotificationEvents: {
        completed: true,
        error: true,
        waiting: false,
        permission: true,
      },
    });

    expect(getPersistentSettingsSnapshot()).toMatchObject({
      feishuNotificationEnabled: true,
      feishuNotificationThresholdMs: 600000,
      feishuNotificationEvents: {
        completed: true,
        error: true,
        waiting: false,
        permission: true,
      },
    });
  });

  it("keeps the latest delivery diagnostic for each notification channel", () => {
    const store = createAppStore();
    store.getState().recordNotificationDelivery({
      channel: "system",
      eventId: "system-event",
      eventType: "assistant_complete",
      status: "sent",
      updatedAt: 100,
    });
    store.getState().recordNotificationDelivery({
      channel: "feishu",
      eventId: "feishu-event",
      eventType: "assistant_complete",
      status: "failed",
      error: "network unavailable",
      updatedAt: 110,
    });

    expect(store.getState().attentionDiagnostics.lastNotifications).toMatchObject({
      system: { eventId: "system-event", status: "sent" },
      feishu: { eventId: "feishu-event", status: "failed" },
    });
  });
});
describe("language persistence", () => {
  const originalLanguage = useAppStore.getState().language;

  afterEach(() => {
    useAppStore.setState({ language: originalLanguage });
  });

  it("preserves Japanese setting when applying persisted settings", () => {
    const baseSettings = getPersistentSettingsSnapshot();
    applyPersistentSettingsToStore({
      ...baseSettings,
      language: "ja",
    });

    expect(useAppStore.getState().language).toBe("ja");
  });
});

describe("git diff tab previews", () => {
  const createDiff = (path: string) => ({
    path,
    name: path.split("/").pop() ?? path,
    staged: false,
    hunkActionsAvailable: true,
    originalContent: "before",
    modifiedContent: "after",
    originalLabel: "HEAD",
    modifiedLabel: "Working Tree",
    isBinary: false,
  });

  it("reuses one preview tab when different changed files are single-clicked", () => {
    const store = createAppStore();
    const projectPath = "D:/workspace/demo";
    store.setState({
      currentProject: { path: projectPath, name: "demo" },
      projectWorkspaces: { [projectPath]: createDefaultWorkspace() },
    });

    const firstId = store.getState().openGitDiffTab(createDiff("src/one.ts"), { preview: true });
    const secondId = store.getState().openGitDiffTab(createDiff("src/two.ts"), { preview: true });
    const state = store.getState();

    expect(state.openTabs).toEqual([secondId]);
    expect(state.tabsById[firstId!]).toBeUndefined();
    expect(state.tabsById[secondId!]).toMatchObject({
      title: "two.ts (工作树)",
      preview: true,
    });
  });

  it("keeps a double-clicked diff and uses a new preview for the next single click", () => {
    const store = createAppStore();
    const projectPath = "D:/workspace/demo";
    store.setState({
      currentProject: { path: projectPath, name: "demo" },
      projectWorkspaces: { [projectPath]: createDefaultWorkspace() },
    });

    const pinnedId = store.getState().openGitDiffTab(createDiff("src/one.ts"), { preview: false });
    const previewId = store.getState().openGitDiffTab(createDiff("src/two.ts"), { preview: true });
    const state = store.getState();

    expect(state.openTabs).toEqual([pinnedId, previewId]);
    expect(state.tabsById[pinnedId!].preview).toBe(false);
    expect(state.tabsById[previewId!].preview).toBe(true);
  });
});

describe("editor typography persistence", () => {
  const originalEditorFontSize = useAppStore.getState().editorFontSize;

  afterEach(() => {
    useAppStore.setState({ editorFontSize: originalEditorFontSize });
  });

  it("persists editor font size independently from terminal font size", () => {
    const baseSettings = getPersistentSettingsSnapshot();
    applyPersistentSettingsToStore({
      ...baseSettings,
      editorFontSize: 16,
      terminalFontSize: 12,
    });

    const state = useAppStore.getState();
    expect(state.editorFontSize).toBe(16);
    expect(state.terminalFontSize).toBe(12);
  });
});

describe("ASR region persistence", () => {
  const originalAsrRegion = useAppStore.getState().asrRegion;

  afterEach(() => {
    useAppStore.setState({ asrRegion: originalAsrRegion });
  });

  it("round-trips a supported region through persistent settings", () => {
    const baseSettings = getPersistentSettingsSnapshot();
    applyPersistentSettingsToStore({
      ...baseSettings,
      asrRegion: "singapore",
    });

    expect(useAppStore.getState().asrRegion).toBe("singapore");
    expect(getPersistentSettingsSnapshot().asrRegion).toBe("singapore");
  });

  it("falls back to Beijing for an invalid or missing persisted region", () => {
    const baseSettings = getPersistentSettingsSnapshot();
    applyPersistentSettingsToStore({
      ...baseSettings,
      asrRegion: "unsupported",
    });

    expect(useAppStore.getState().asrRegion).toBe("beijing");
  });
});
