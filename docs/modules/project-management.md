# 项目管理模块

## 模块概述

项目管理模块负责项目的打开、关闭、切换和状态管理。它维护当前项目、最近项目列表和项目会话状态。

**相关代码位置**：
- `src/store/index.ts` - 项目状态管理
- `src/store/slices/sessionSlice.ts` - 会话状态切片
- `src-tauri/src/commands/window.rs` - 项目窗口管理

## 核心机制

### 1. 项目状态

系统维护以下项目状态：

| 状态 | 类型 | 说明 |
|------|------|------|
| `currentProject` | `ProjectInfo \| null` | 当前打开的项目 |
| `lastProject` | `ProjectInfo \| null` | 上次关闭的项目 |
| `recentProjects` | `RecentProjectEntry[]` | 最近打开的项目列表 |
| `projectSessions` | `Record<string, Session[]>` | 每个项目的会话列表 |

**代码位置**：`src/store/index.ts:296-305`

```typescript
interface AppState {
  currentProject: ProjectInfo | null;
  lastProject: ProjectInfo | null;
  recentProjects: RecentProjectEntry[];
  projectSessions: Record<string, Session[]>;
  // ...
}
```

### 2. 打开项目

**机制描述**：打开项目时，更新项目状态并加载相关会话。

**工作原理**：

1. 调用 `setCurrentProject` 更新当前项目
2. 从 `projectSessions` 加载该项目的会话列表
3. 从 `projectWorkspaces` 加载该项目的工作区布局
4. 更新 `lastProject` 和 `recentProjects`

**代码位置**：`src/store/index.ts:994-1012`

```typescript
setCurrentProject: (project) =>
  set((state) => {
    const sessions = state.projectSessions[project.path] || [];
    const workspace = state.projectWorkspaces[project.path] || createDefaultWorkspace();
    const normalizedWorkspace = normalizeWorkspace(workspace, sessions);
    return {
      currentProject: project,
      activeSidebarSection: "sessions",
      lastProject: project,
      recentProjects: touchRecentProjects(state.recentProjects, project),
      sessions,
      projectWorkspaces: {
        ...state.projectWorkspaces,
        [project.path]: normalizedWorkspace,
      },
      unreadTotal: sessions.reduce((acc, session) => acc + (session.unreadCount ?? 0), 0),
      ...syncWorkspaceSnapshot(normalizedWorkspace),
    };
  }),
```

### 3. 关闭项目

**机制描述**：关闭项目时，清理当前项目状态但保留项目会话数据。

**工作原理**：

1. 保存当前项目的工作区布局到 `projectWorkspaces`
2. 清空 `currentProject`、`sessions` 等当前状态
3. 保留 `projectSessions` 中的会话数据（用于下次打开）

**代码位置**：窗口关闭时触发 `on_window_event`

```rust
// src-tauri/src/lib.rs:41-72
.on_window_event(|window, event| {
    if matches!(event, WindowEvent::Destroyed) {
        commands::window::cleanup_window_project_sessions(
            window.label(),
            &registry,
            &manager,
        );
    }
})
```

### 4. 切换项目

**机制描述**：切换项目时，保存当前项目状态并加载新项目状态。

**工作原理**：

1. 保存当前项目的工作区布局
2. 调用 `setCurrentProject` 切换到新项目
3. 加载新项目的会话和工作区

### 5. 最近项目管理

**机制描述**：维护最近打开的项目列表，按最后打开时间排序。

**工作原理**：

1. 打开项目时，调用 `touchRecentProjects` 更新列表
2. 最多保留 10 个最近项目
3. 按 `lastOpenedAt` 降序排序

**代码位置**：`src/store/index.ts:438-443`

```typescript
function sortRecentProjects(projects: RecentProjectEntry[]) {
  return [...projects]
    .filter((item) => item.path.trim().length > 0)
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .slice(0, 10);
}
```

### 6. 项目会话持久化

**机制描述**：项目会话数据通过 Zustand persist 中间件持久化到 localStorage。

**工作原理**：

1. `projectSessions` 包含所有项目的会话数据
2. 通过 `partialize` 选项持久化到 localStorage
3. 应用启动时自动恢复

**代码位置**：`src/store/index.ts:1619-1631`

```typescript
partialize: (state: AppState) => ({
  lastProject: state.lastProject,
  recentProjects: state.recentProjects,
  projectSessions: state.projectSessions,
  projectWorkspaces: state.projectWorkspaces,
  // ...
}),
```

### 7. 项目路径规范化

**机制描述**：规范化项目路径，处理 Windows 长路径前缀。

**工作原理**：

1. 移除 `\\?\` 前缀（Windows 长路径）
2. 移除 `\\?\UNC\` 前缀，转换为 `\\server\share` 格式

**代码位置**：`src-tauri/src/commands/window.rs:477-490`

```rust
#[cfg(target_os = "windows")]
pub(crate) fn normalize_windows_verbatim_path(path: String) -> String {
    if let Some(stripped) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", stripped)
    } else if let Some(stripped) = path.strip_prefix(r"\\?\") {
        stripped.to_string()
    } else {
        path
    }
}
```

## 数据流

```
┌─────────────────────────────────────────────────────────────┐
│                      前端 UI                                │
├─────────────────────────────────────────────────────────────┤
│  HomePage - 项目选择                                         │
│  Sidebar - 会话列表                                          │
│  TitleBar - 项目切换                                         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Zustand Store                             │
├─────────────────────────────────────────────────────────────┤
│  currentProject - 当前项目                                    │
│  lastProject - 上次项目                                       │
│  recentProjects - 最近项目                                    │
│  projectSessions - 项目会话                                   │
│  projectWorkspaces - 项目工作区                               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   持久化层                                   │
├─────────────────────────────────────────────────────────────┤
│  localStorage (Zustand persist)                              │
│  SQLite (通过 Tauri 命令)                                     │
└─────────────────────────────────────────────────────────────┘
```

## 依赖关系

- **窗口管理模块** - 项目打开/关闭通过窗口管理模块执行
- **会话管理模块** - 项目包含多个会话
- **设置模块** - 项目设置通过设置模块持久化
