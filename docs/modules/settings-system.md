# 设置系统模块

## 模块概述

设置系统模块负责应用设置的持久化和同步。它实现了双轨持久化机制，确保设置在不同会话间保持一致。

**相关代码位置**：
- `src/store/index.ts` - 设置状态管理
- `src-tauri/src/commands/settings.rs` - Tauri 设置命令
- `src/App.tsx` - 设置同步逻辑

## 核心机制

### 1. 双轨持久化

**机制描述**：设置同时通过两条路径持久化，确保数据安全。

**两条路径**：

1. **Zustand persist (localStorage)**
   - 前端状态管理库的持久化中间件
   - 数据存储在浏览器 localStorage
   - 启动时自动恢复

2. **SQLite (通过 Tauri 命令)**
   - 后端 SQLite 数据库
   - 通过 Tauri 命令读写
   - 更可靠，支持跨窗口同步

**代码位置**：`src/App.tsx:161-184`

```typescript
// 保存到 SQLite
useEffect(() => {
  if (isVoiceOverlayWindow || !persistentSettingsReady) {
    return;
  }

  const serialized = JSON.stringify(persistentSettings);
  if (serialized === lastPersistedSnapshotRef.current) {
    return;
  }

  const timer = window.setTimeout(() => {
    savePersistentSettings(persistentSettings)
      .then(() => {
        lastPersistedSnapshotRef.current = serialized;
      })
      .catch((error) => {
        console.error("Failed to persist settings to SQLite:", error);
      });
  }, 250);

  return () => {
    window.clearTimeout(timer);
  };
}, [isVoiceOverlayWindow, persistentSettings, persistentSettingsReady]);
```

### 2. 设置初始化

**机制描述**：应用启动时从 SQLite 加载设置并应用到前端状态。

**工作原理**：

1. 调用 Tauri 命令 `initializePersistentSettings` 获取设置
2. 调用 `applyPersistentSettingsToStore` 应用到 Zustand store
3. 设置 `persistentSettingsReady` 为 true，触发后续同步

**代码位置**：`src/App.tsx:138-159`

```typescript
useEffect(() => {
  if (isVoiceOverlayWindow) {
    return;
  }

  let disposed = false;
  initializePersistentSettings(getPersistentSettingsSnapshot())
    .then((settings) => {
      if (!disposed) {
        applyPersistentSettingsToStore(settings);
        lastPersistedSnapshotRef.current = JSON.stringify(settings);
        setPersistentSettingsReady(true);
      }
    })
    .catch((error) => {
      console.error("Failed to initialize persistent settings from SQLite:", error);
    });

  return () => {
    disposed = true;
  };
}, [isVoiceOverlayWindow, isVoiceWorkerWindow]);
```

### 3. 设置快照

**机制描述**：获取当前设置的快照，用于持久化和比较。

**工作原理**：

1. 从 Zustand store 获取所有设置字段
2. 返回 `PersistentSettings` 对象
3. 用于保存到 SQLite 和比较变化

**代码位置**：`src/store/index.ts:130-154`

```typescript
export function getPersistentSettingsSnapshot(): PersistentSettings {
  const state = useAppStore.getState();
  return {
    lightTheme: state.lightTheme,
    darkTheme: state.darkTheme,
    themeCategory: state.themeCategory,
    language: state.language,
    startupRestoreLastProject: state.startupRestoreLastProject,
    lastProjectPath: state.lastProject?.path ?? null,
    terminalFontSize: state.terminalFontSize,
    terminalCursorBlink: state.terminalCursorBlink,
    terminalLineHeight: state.terminalLineHeight,
    skipPermissions: state.skipPermissions,
    notificationEnabled: state.notificationEnabled,
    notificationSoundEnabled: state.notificationSoundEnabled,
    notificationSoundMap: state.notificationSoundMap,
    notificationVolume: state.notificationVolume,
    notificationThresholdMs: state.notificationThresholdMs,
    asrApiKey: state.asrApiKey,
    asrModel: state.asrModel,
    voiceShortcut: state.voiceShortcut,
    voiceInputTarget: state.voiceInputTarget,
    voiceTriggerVisible: state.voiceTriggerVisible,
  };
}
```

### 4. 应用设置到 Store

**机制描述**：将从 SQLite 加载的设置应用到 Zustand store。

**工作原理**：

1. 对每个设置字段进行规范化处理
2. 确保值在有效范围内
3. 使用默认值处理 null/undefined

**代码位置**：`src/store/index.ts:156-186`

```typescript
export function applyPersistentSettingsToStore(settings: PersistentSettings) {
  const lastProjectPath = normalizeLastProjectPathValue(settings.lastProjectPath);
  useAppStore.setState({
    lightTheme: normalizeThemeModeValue(settings.lightTheme),
    darkTheme: normalizeDarkThemeModeValue(settings.darkTheme),
    themeCategory: normalizeThemeCategoryValue(settings.themeCategory),
    language: normalizeLanguageValue(settings.language),
    startupRestoreLastProject: normalizeStartupRestoreLastProjectValue(
      settings.startupRestoreLastProject
    ),
    lastProject: lastProjectPath ? projectInfoFromPath(lastProjectPath) : null,
    terminalFontSize: Math.max(10, Math.round(settings.terminalFontSize || 14)),
    terminalCursorBlink: settings.terminalCursorBlink ?? true,
    terminalLineHeight: settings.terminalLineHeight || 1.2,
    skipPermissions: Boolean(settings.skipPermissions),
    // ...
  });
}
```

### 5. 设置防抖保存

**机制描述**：设置变化时延迟保存，避免频繁写入。

**工作原理**：

1. 监听 `persistentSettings` 变化
2. 使用 250ms 防抖延迟
3. 只在设置实际变化时保存
4. 保存成功后更新 `lastPersistedSnapshotRef`

**代码位置**：`src/App.tsx:161-184`

```typescript
const timer = window.setTimeout(() => {
  savePersistentSettings(persistentSettings)
    .then(() => {
      lastPersistedSnapshotRef.current = serialized;
    })
    .catch((error) => {
      console.error("Failed to persist settings to SQLite:", error);
    });
}, 250);
```

### 6. 设置字段规范化

**机制描述**：对设置字段进行规范化处理，确保值在有效范围内。

**规范化函数**：

| 函数 | 说明 |
|------|------|
| `normalizeThemeModeValue` | 规范化主题模式 |
| `normalizeDarkThemeModeValue` | 规范化深色主题模式 |
| `normalizeThemeCategoryValue` | 规范化主题类别 |
| `normalizeLanguageValue` | 规范化语言设置 |
| `normalizeStartupRestoreLastProjectValue` | 规范化启动恢复设置 |
| `normalizeLastProjectPathValue` | 规范化上次项目路径 |
| `normalizeAsrModel` | 规范化 ASR 模型 |
| `normalizeVoiceInputTarget` | 规范化语音输入目标 |
| `normalizeNotificationSoundValue` | 规范化通知声音 |

**代码位置**：`src/store/index.ts:83-128`

```typescript
function normalizeThemeModeValue(mode: string | null | undefined): ThemeMode {
  return mode === "light-warm" ||
    mode === "dark-starry" ||
    mode === "dark-mocha"
    ? mode
    : "light-glass";
}

function normalizeStartupRestoreLastProjectValue(
  value: boolean | null | undefined
): boolean {
  return value ?? true;
}
```

### 7. 持久化存储结构

**机制描述**：Zustand persist 只持久化部分状态，不持久化临时状态。

**持久化的字段**：

```typescript
partialize: (state: AppState) => ({
  lastProject: state.lastProject,
  recentProjects: state.recentProjects,
  sessionEvents: state.sessionEvents,
  projectSessions: state.projectSessions,
  projectArchivedSessions: state.projectArchivedSessions,
  projectWorkspaces: state.projectWorkspaces,
  sidebarCollapsed: state.sidebarCollapsed,
  sidebarWidth: state.sidebarWidth,
  sidebarPinnedCollapsed: state.sidebarPinnedCollapsed,
  sidebarSessionsCollapsed: state.sidebarSessionsCollapsed,
  sidebarGitChangesCollapsed: state.sidebarGitChangesCollapsed,
  sidebarGitGraphCollapsed: state.sidebarGitGraphCollapsed,
}),
```

**不持久化的字段**（临时状态）：

- `currentProject` - 当前项目（启动时恢复）
- `sessions` - 当前会话（启动时恢复）
- `tabsById` - 标签状态（启动时恢复）
- `panesById` - 面板状态（启动时恢复）
- `windowMode` - 窗口模式（启动时恢复）
- `windowLabel` - 窗口标签（启动时恢复）

### 8. 设置迁移

**机制描述**：处理设置版本迁移，确保旧版本设置能正确升级。

**工作原理**：

1. Zustand persist 的 `migrate` 函数处理版本迁移
2. `rehydrateMigrationState` 函数处理具体迁移逻辑
3. 确保旧版本设置字段有正确的默认值

**代码位置**：`src/store/index.ts:1674-1689`

```typescript
function rehydrateMigrationState(persistedState: Partial<AppState> | undefined) {
  const migratedState = migrateRecentProjectState(persistedState) as
    | Partial<AppState>
    | undefined;
  if (migratedState) {
    migratedState.asrModel = normalizeAsrModel(migratedState.asrModel);
    migratedState.voiceInputTarget = normalizeVoiceInputTarget(
      migratedState.voiceInputTarget
    );
    migratedState.voiceTriggerVisible = migratedState.voiceTriggerVisible ?? true;
    migratedState.startupRestoreLastProject = normalizeStartupRestoreLastProjectValue(
      migratedState.startupRestoreLastProject
    );
  }
  return migratedState;
}
```

## 数据流

```
┌─────────────────────────────────────────────────────────────┐
│                      UI 组件                                │
├─────────────────────────────────────────────────────────────┤
│  SettingsPanel - 设置面板                                    │
│  Sidebar - 快速切换                                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Zustand Store                             │
├─────────────────────────────────────────────────────────────┤
│  设置状态 (lightTheme, darkTheme, ...)                        │
│  设置动作 (setLightTheme, setDarkTheme, ...)                  │
└─────────────────────────────────────────────────────────────┘
                              │
                ┌─────────────┴─────────────┐
                ▼                           ▼
┌───────────────────────────┐ ┌───────────────────────────┐
│   localStorage            │ │   SQLite                  │
│   (Zustand persist)       │ │   (Tauri 命令)            │
│   - 快速读写               │ │   - 可靠存储               │
│   - 浏览器限制             │ │   - 跨窗口同步             │
└───────────────────────────┘ └───────────────────────────┘
```

## 依赖关系

- **主题系统模块** - 主题设置通过设置系统持久化
- **语音模块** - 语音设置通过设置系统持久化
- **通知模块** - 通知设置通过设置系统持久化
- **窗口管理模块** - 窗口设置通过设置系统持久化
