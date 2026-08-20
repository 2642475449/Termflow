import type { StateCreator } from "zustand";
import type {
  AppState,
  RemoteNotificationChannels,
  RemoteNotificationEvent,
  RemoteNotificationProvider,
  NotificationEvent,
  NotificationSoundMap,
  NotificationSoundType,
  SessionStreamEvent,
} from "../types";
import { createDefaultRemoteNotificationChannels } from "../../lib/remoteNotifications";
import { mapStatusFromEvent } from "../utils/session";
import { createDefaultWorkspace, syncWorkspaceSnapshot, normalizeWorkspace } from "../utils/workspace";

export interface NotificationSlice {
  notificationEnabled: boolean;
  notificationSoundEnabled: boolean;
  notificationSoundMap: NotificationSoundMap;
  notificationThresholdMs: number;
  remoteNotificationChannels: RemoteNotificationChannels;
  sessionEvents: SessionStreamEvent[];
  unreadTotal: number;
  setNotificationEnabled: (enabled: boolean) => void;
  setNotificationSoundEnabled: (enabled: boolean) => void;
  setNotificationSoundMap: (event: NotificationEvent, sound: NotificationSoundType) => void;
  setNotificationThreshold: (thresholdMs: number) => void;
  setRemoteNotificationEnabled: (provider: RemoteNotificationProvider, enabled: boolean) => void;
  setRemoteNotificationThreshold: (provider: RemoteNotificationProvider, thresholdMs: number) => void;
  setRemoteNotificationEvent: (
    provider: RemoteNotificationProvider,
    event: RemoteNotificationEvent,
    enabled: boolean,
  ) => void;
  pushSessionEvent: (event: SessionStreamEvent) => void;
  markSessionRead: (sessionId: string) => void;
  focusSessionFromEvent: (event: SessionStreamEvent) => void;
}

export const createNotificationSlice: StateCreator<AppState, [], [], NotificationSlice> = (set, _get) => ({
  notificationEnabled: true,
  notificationSoundEnabled: true,
  notificationSoundMap: {
    taskComplete: "bloom",
    error: "signal",
    waiting: "pulse",
  },
  notificationThresholdMs: 10000,
  remoteNotificationChannels: createDefaultRemoteNotificationChannels(),
  sessionEvents: [],
  unreadTotal: 0,
  setNotificationEnabled: (enabled) => set({ notificationEnabled: enabled }),
  setNotificationSoundEnabled: (enabled) => set({ notificationSoundEnabled: enabled }),
  setNotificationSoundMap: (event, sound) =>
    set((state) => ({
      notificationSoundMap: { ...state.notificationSoundMap, [event]: sound },
    })),
  setNotificationThreshold: (notificationThresholdMs) => set({ notificationThresholdMs }),
  setRemoteNotificationEnabled: (provider, enabled) =>
    set((state) => ({
      remoteNotificationChannels: {
        ...state.remoteNotificationChannels,
        [provider]: { ...state.remoteNotificationChannels[provider], enabled },
      },
    })),
  setRemoteNotificationThreshold: (provider, thresholdMs) =>
    set((state) => ({
      remoteNotificationChannels: {
        ...state.remoteNotificationChannels,
        [provider]: { ...state.remoteNotificationChannels[provider], thresholdMs },
      },
    })),
  setRemoteNotificationEvent: (provider, event, enabled) =>
    set((state) => ({
      remoteNotificationChannels: {
        ...state.remoteNotificationChannels,
        [provider]: {
          ...state.remoteNotificationChannels[provider],
          events: { ...state.remoteNotificationChannels[provider].events, [event]: enabled },
        },
      },
    })),
  pushSessionEvent: (event) => {
    let outcome: "accepted" | "duplicate" | "stale" = "accepted";
    set((state) => {
      const eventKey = event.dedupeKey?.trim() || event.id;
      if (
        state.sessionEvents.some(
          (existing) => (existing.dedupeKey?.trim() || existing.id) === eventKey
        )
      ) {
        outcome = "duplicate";
        return state;
      }
      const targetSession = state.sessions.find((session) => session.id === event.sessionId);
      const latestObservedAt = Math.max(
        targetSession?.lastEventAt ?? 0,
        targetSession?.statusUpdatedAt ?? 0,
      );
      if (
        (event.revision !== null &&
          event.revision !== undefined &&
          targetSession?.statusRevision !== undefined &&
          event.revision < targetSession.statusRevision) ||
        event.createdAt < latestObservedAt
      ) {
        outcome = "stale";
        return state;
      }
      const read = !event.requiresAttention || event.read === true;
      const events = [{ ...event, read }, ...state.sessionEvents].slice(0, 200);
      const unreadBySession = new Map<string, number>();
      for (const item of events) {
        if (item.requiresAttention && !item.read) {
          unreadBySession.set(item.sessionId, (unreadBySession.get(item.sessionId) ?? 0) + 1);
        }
      }
      const sessions = state.sessions.map((session) => {
        const unreadCount = unreadBySession.get(session.id) ?? 0;
        if (session.id !== event.sessionId) {
          return session.unreadCount === unreadCount ? session : { ...session, unreadCount };
        }
        return {
          ...session,
          status:
            event.revision === null || event.revision === undefined
              ? mapStatusFromEvent(event.eventType)
              : session.status,
          unreadCount,
          lastEventAt: event.createdAt,
          lastEventType: event.eventType,
        };
      });
      const unreadTotal = sessions.reduce((acc, session) => acc + (session.unreadCount ?? 0), 0);
      if (!state.currentProject) {
        return { sessionEvents: events };
      }
      const path = state.currentProject.path;
      const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
      return {
        projectSessions: { ...state.projectSessions, [path]: sessions },
        projectWorkspaces: {
          ...state.projectWorkspaces,
          [path]: currentWorkspace,
        },
        sessions,
        ...syncWorkspaceSnapshot(currentWorkspace),
        sessionEvents: events,
        unreadTotal,
      };
    });
    return outcome;
  },
  markSessionRead: (sessionId) =>
    set((state) => {
      const sessions = state.sessions.map((session) =>
        session.id === sessionId ? { ...session, unreadCount: 0 } : session
      );
      const sessionEvents = state.sessionEvents.map((event) =>
        event.sessionId === sessionId ? { ...event, read: true } : event
      );
      const unreadTotal = sessions.reduce((acc, session) => acc + (session.unreadCount ?? 0), 0);
      if (!state.currentProject) {
        return { sessionEvents, unreadTotal };
      }
      const path = state.currentProject.path;
      const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
      return {
        projectSessions: { ...state.projectSessions, [path]: sessions },
        projectWorkspaces: {
          ...state.projectWorkspaces,
          [path]: currentWorkspace,
        },
        sessions,
        ...syncWorkspaceSnapshot(currentWorkspace),
        sessionEvents,
        unreadTotal,
      };
    }),
  focusSessionFromEvent: (event) =>
    set((state) => {
      const targetPath = event.projectPath;
      const nextProject = state.currentProject?.path === targetPath
        ? state.currentProject
        : {
            path: targetPath,
            name: targetPath.split(/[\\/]/).pop() || targetPath,
          };
      const targetSessions = (state.projectSessions[targetPath] || []).map((session) =>
        session.id === event.sessionId ? { ...session, unreadCount: 0 } : session
      );
      const currentWorkspace = state.projectWorkspaces[targetPath] || createDefaultWorkspace();
      const normalizedWorkspace = normalizeWorkspace(currentWorkspace, targetSessions);
      return {
        currentProject: nextProject,
        sessionEvents: state.sessionEvents.map((item) =>
          item.sessionId === event.sessionId ? { ...item, read: true } : item
        ),
        unreadTotal: targetSessions.reduce(
          (acc, session) => acc + (session.unreadCount ?? 0),
          0
        ),
        projectSessions: { ...state.projectSessions, [targetPath]: targetSessions },
        projectWorkspaces: {
          ...state.projectWorkspaces,
          [targetPath]: normalizedWorkspace,
        },
        sessions: targetSessions,
        ...syncWorkspaceSnapshot(normalizedWorkspace),
      };
    }),
});
