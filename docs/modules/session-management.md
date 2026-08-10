# 会话管理模块

## 模块概述

会话管理模块负责终端会话的创建、销毁、状态管理和生命周期控制。每个会话对应一个 Claude Code 进程。

**相关代码位置**：
- `src/store/slices/sessionSlice.ts` - 会话状态切片
- `src-tauri/src/commands/session.rs` - Tauri 会话命令
- `src-tauri/src/pty.rs` - PTY 进程管理

## 核心机制

### 1. 会话状态

会话实体包含以下状态：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 会话唯一标识 |
| `name` | `string` | 会话名称 |
| `status` | `SessionRuntimeStatus` | 运行状态 |
| `active` | `boolean` | 是否活跃 |
| `pinned` | `boolean` | 是否固定 |
| `unreadCount` | `number` | 未读消息数 |
| `runtimeModel` | `string \| null` | 运行时模型 |
| `runtimeMode` | `string \| null` | 运行时模式 |

**代码位置**：`src/types/index.ts`

```typescript
interface Session {
  id: string;
  name: string;
  status: SessionRuntimeStatus;
  active: boolean;
  pinned: boolean;
  unreadCount: number;
  runtimeModel: string | null;
  runtimeMode: string | null;
  // ...
}
```

### 2. 会话生命周期

**机制描述**：会话从创建到销毁的完整生命周期。

**状态流转**：

```
创建 → waiting → running → completed
                  ↓
                error → stopped
                  ↓
                stopped
```

**工作原理**：

1. **创建会话**
   - 调用 `addSession` 创建会话实体
   - 调用 Tauri 命令 `spawn_pty` 创建 PTY 进程
   - 会话状态初始化为 `waiting`

2. **会话运行**
   - PTY 输出通过事件 `pty-output` 发送到前端
   - 前端检测运行时状态并更新会话
   - 会话状态变为 `running`

3. **会话完成**
   - 进程退出时触发 `process_exit` 事件
   - 会话状态变为 `completed` 或 `stopped`

4. **会话错误**
   - 进程错误时触发 `process_error` 事件
   - 会话状态变为 `error`

**代码位置**：`src/store/index.ts:1691-1698`

```typescript
function mapStatusFromEvent(eventType: SessionEventType): SessionRuntimeStatus {
  if (eventType === "session_started" || eventType === "session_resumed") return "waiting";
  if (eventType === "assistant_complete") return "completed";
  if (eventType === "waiting_input" || eventType === "permission_request") return "waiting";
  if (eventType === "process_error" || eventType === "hook_error") return "error";
  if (eventType === "process_exit") return "stopped";
  return "running";
}
```

### 3. 创建会话

**机制描述**：创建新的终端会话。

**工作原理**：

1. 调用 `addSession` 创建会话实体
2. 会话自动添加到当前项目的会话列表
3. 会话标签自动打开

**代码位置**：`src/store/index.ts:1014-1030`

```typescript
addSession: (session) =>
  set((state) => {
    if (!state.currentProject) return state;
    const path = state.currentProject.path;
    const existingSessions = state.projectSessions[path] || [];
    const normalizedSession = {
      ...session,
      titleSource: session.titleSource ?? "default",
      status: session.status ?? "waiting",
      unreadCount: session.unreadCount ?? 0,
      pinned: session.pinned ?? false,
    };
    const sessions = [normalizedSession, ...existingSessions];
    const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
    const nextWorkspace = openTabInWorkspace(currentWorkspace, normalizedSession.id, sessions);
    return syncProjectState(state, path, sessions, nextWorkspace);
  }),
```

### 4. 删除会话

**机制描述**：删除会话并清理相关资源。

**工作原理**：

1. 调用 Tauri 命令 `close_pty` 关闭 PTY 进程
2. 调用 `removeSession` 从状态中移除会话
3. 关闭会话标签

**代码位置**：`src/store/index.ts:1314-1324`

```typescript
removeSession: (sessionId) =>
  set((state) => {
    if (!state.currentProject) return state;
    const path = state.currentProject.path;
    const sessions = (state.projectSessions[path] || []).filter(
      (session) => session.id !== sessionId
    );
    const currentWorkspace = state.projectWorkspaces[path] || createDefaultWorkspace();
    const nextWorkspace = closeTabInWorkspace(currentWorkspace, sessionId);
    return syncProjectState(state, path, sessions, nextWorkspace);
  }),
```

### 5. 会话归档

**机制描述**：将不活跃的会话归档，减少界面干扰。

**工作原理**：

1. 调用 `archiveSession` 将会话移到归档列表
2. 归档会话标记为 `archived: true`
3. 归档会话可以从归档列表恢复

**代码位置**：`src/store/index.ts:1385-1414`

```typescript
archiveSession: (sessionId) =>
  set((state) => {
    if (!state.currentProject) return state;
    const path = state.currentProject.path;
    const existingSessions = state.projectSessions[path] || [];
    const sessionToArchive = existingSessions.find((s) => s.id === sessionId);
    if (!sessionToArchive) return state;

    const sessions = existingSessions.filter((s) => s.id !== sessionId);
    const archivedSession = {
      ...sessionToArchive,
      active: false,
      status: "stopped" as const,
      archived: true,
      archivedAt: Date.now(),
    };
    const existingArchived = state.projectArchivedSessions[path] || [];
    const archivedSessions = [archivedSession, ...existingArchived];

    return {
      ...syncProjectState(state, path, sessions, nextWorkspace),
      projectArchivedSessions: {
        ...state.projectArchivedSessions,
        [path]: archivedSessions,
      },
    };
  }),
```

### 6. 会话固定

**机制描述**：固定重要会话，防止被意外归档或删除。

**工作原理**：

1. 调用 `togglePinSession` 切换会话固定状态
2. 固定会话在侧边栏中显示在单独区域
3. 固定会话不会被批量归档

**代码位置**：`src/store/index.ts:1335-1353`

```typescript
togglePinSession: (sessionId) =>
  set((state) => {
    if (!state.currentProject) return state;
    const path = state.currentProject.path;
    const sessions = (state.projectSessions[path] || []).map((session) =>
      session.id === sessionId
        ? { ...session, pinned: !session.pinned }
        : session
    );
    // ...
  }),
```

### 7. 会话事件处理

**机制描述**：处理来自 PTY 的会话事件，更新会话状态。

**工作原理**：

1. 监听 `pty-output` 事件
2. 检测运行时状态变化（模型、模式、静默状态）
3. 调用 `updateSession` 更新会话状态

**代码位置**：`src/components/layout/AppLayout.tsx:333-344`

```typescript
useEffect(() => {
  const unlistenPromise = listen<{ session_id: string; data: string }>("pty-output", (event) => {
    const sessionId = event.payload.session_id;
    const detected = detectClaudeRuntimeState(event.payload.data);
    if (!detected) return;

    const currentSession = useAppStore.getState().sessions.find((session) => session.id === sessionId);
    if (!currentSession) return;

    const updates: Record<string, unknown> = {};
    // ... 检测变化并更新
    updateSession(sessionId, updates);
  });
}, [updateSession]);
```

### 8. 会话使用量更新

**机制描述**：跟踪会话的 token 使用量和上下文窗口。

**工作原理**：

1. 监听 `session-usage-update` 事件
2. 更新会话的 `contextUsage` 信息
3. 包括已用 token、总 token、使用率、模型等

**代码位置**：`src/components/layout/AppLayout.tsx:346-376`

```typescript
useEffect(() => {
  const unlistenPromise = listen<SessionUsageUpdatePayload>("session-usage-update", (event) => {
    const payload = event.payload;
    updateSession(sessionId, {
      contextUsage: {
        usedTokens: payload.usedTokens,
        totalTokens: payload.contextWindow,
        ratio: payload.usageRatio,
        model: payload.model,
        // ...
      },
    });
  });
}, [updateSession]);
```

## 数据流

```
┌─────────────────────────────────────────────────────────────┐
│                    PTY 进程                                 │
├─────────────────────────────────────────────────────────────┤
│  Claude Code 进程                                            │
│  stdout/stderr 输出                                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Tauri 事件系统                            │
├─────────────────────────────────────────────────────────────┤
│  pty-output - 终端输出                                        │
│  session-event - 会话事件                                     │
│  session-usage-update - 使用量更新                            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   前端状态管理                               │
├─────────────────────────────────────────────────────────────┤
│  Zustand Store - 会话状态                                     │
│  运行时检测 - detectClaudeRuntimeState()                      │
│  事件处理 - pushSessionEvent()                                │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      UI 组件                                │
├─────────────────────────────────────────────────────────────┤
│  Terminal - 终端渲染                                          │
│  Sidebar - 会话列表                                          │
│  TabBar - 会话标签                                           │
└─────────────────────────────────────────────────────────────┘
```

## 依赖关系

- **项目管理模块** - 会话属于项目
- **窗口管理模块** - 会话在窗口中显示
- **PTY 模块** - 会话通过 PTY 管理进程
