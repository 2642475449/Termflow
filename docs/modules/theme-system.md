# 主题系统模块

## 模块概述

主题系统是 Termflow 的视觉层基础设施，负责管理应用程序的色彩方案、明暗模式切换和用户偏好持久化。系统提供 4 套精心设计的主题，通过 CSS 变量（`--cs-` 前缀）驱动全局样式，并支持跟随操作系统主题自动切换。

**相关代码位置**：
- `src/styles/themes.css` - 4 套主题的 CSS 变量定义
- `src/styles/global.css` - 全局变量与覆盖
- `src/App.tsx` - 主题切换副作用处理、Ant Design 配置
- `src/store/index.ts` - 主题状态管理
- `src/components/SettingsPanel.tsx` - 主题选择 UI

## 核心机制

### 1. 主题类型与定义

**机制描述**：系统定义了两层主题概念 -- 主题类别（ThemeCategory）和主题模式（ThemeMode）。

**类型定义**：
- **ThemeCategory**（主题类别）：`"light"` | `"dark"` | `"system"`，决定使用明色系还是暗色系
- **ThemeMode**（主题模式）：具体的视觉主题方案

**四种主题模式**：

| 主题 | 类别 | 描述 | 主色 |
|------|------|------|------|
| `light-glass` | light | 清朗蓝白，网格背景 | `#4f6cf7` |
| `light-warm` | light | 暖木书房，暖色调 | `#c2713a` |
| `dark-starry` | dark | 星空沉浸，深邃蓝紫 | `#a78bfa` |
| `dark-mocha` | dark | 摩卡棕夜，暖棕暗色 | `#f5bd69` |

**代码位置**：
- 类型定义：`src/store/index.ts:19-20`
- 主题选项配置：`src/components/SettingsPanel.tsx:119-161`
- 主色映射：`src/App.tsx:21-26`（`THEME_COLORS`）

### 2. 主题切换机制

**机制描述**：用户在设置面板中选择主题类别和具体主题，状态通过 Zustand store 管理，最终写入 `document.documentElement.setAttribute("data-theme", ...)` 触发 CSS 变量切换。

**工作流程**：

1. 用户在 SettingsPanel 的 "通用" 页面中操作 Segmented 控件选择主题类别（light/dark/system）
2. `setThemeCategory()` 更新 store 中的 `themeCategory` 状态
3. 用户在 ThemeCard 网格中点击选择具体主题，调用 `setLightTheme()` 或 `setDarkTheme()`
4. `App.tsx` 中的 `useEffect` 监听 `currentTheme` 变化，执行 `document.documentElement.setAttribute("data-theme", currentTheme)`
5. CSS 文件中的 `[data-theme="xxx"]` 选择器激活对应的变量集

**activeTheme 计算逻辑**：

```typescript
activeTheme: () => {
  const state = get();
  if (state.themeCategory === "system") {
    return state.systemPrefersDark ? state.darkTheme : state.lightTheme;
  }
  return state.themeCategory === "light" ? state.lightTheme : state.darkTheme;
};
```

**Ant Design 集成**：`App.tsx` 中通过 `ConfigProvider` 的 `theme` 属性，根据 `isDark` 布尔值选择 `theme.darkAlgorithm` 或 `theme.defaultAlgorithm`，并将主色注入 `token.colorPrimary`。

**代码位置**：
- Store actions：`src/store/index.ts:986-992`（`activeTheme`），`src/store/index.ts:1510-1513`（setter）
- DOM 属性写入：`src/App.tsx:115-117`
- Ant Design 主题注入：`src/App.tsx:203-211`
- 设置面板 UI：`src/components/SettingsPanel.tsx:403-435`

### 3. CSS 变量系统

**机制描述**：每套主题通过 `[data-theme="xxx"]` 属性选择器定义一套完整的 CSS 自定义属性，统一使用 `--cs-` 前缀（"cs" 即 "color-scheme" 的缩写），供全局样式消费。

**变量分类**：

| 类别 | 变量名示例 | 说明 |
|------|-----------|------|
| 背景色 | `--cs-bg-app`, `--cs-bg-card`, `--cs-bg-sidebar`, `--cs-bg-header`, `--cs-bg-statusbar`, `--cs-bg-content` | 各区域背景 |
| 交互色 | `--cs-bg-hover`, `--cs-bg-active` | 悬停/激活态 |
| 文本色 | `--cs-text-primary`, `--cs-text-secondary`, `--cs-text-tertiary` | 三级文本色 |
| 边框色 | `--cs-border`, `--cs-border-card`, `--cs-border-sidebar` | 各区域边框 |
| 主题色 | `--cs-primary`, `--cs-primary-light`, `--cs-accent` | 品牌主色 |
| 语义色 | `--cs-accent-green`, `--cs-accent-yellow`, `--cs-danger`, `--cs-danger-hover` | 状态指示 |
| 滚动条 | `--cs-scrollbar-thumb`, `--cs-scrollbar-hover` | 滚动条样式 |

**额外全局变量**（定义在 `:root` 中）：
- `--cs-marker-thickness`、`--cs-marker-color`、`--cs-marker-width-*`、`--cs-marker-offset-*`：侧边栏指示条
- `--cs-panel-radius`：面板圆角

**主题背景特效**：每个主题在 `body` 和 `#root` 上应用独特的多层渐变背景（径向渐变 + 线性渐变），营造视觉深度。

**代码位置**：
- CSS 变量定义：`src/styles/themes.css`
- 全局变量与覆盖：`src/styles/global.css:7-18`（`:root`），`src/styles/global.css:20-76`（light-glass 覆盖）

### 4. 跟随系统主题

**机制描述**：当 `themeCategory` 为 `"system"` 时，通过 `window.matchMedia("(prefers-color-scheme: dark)")` 监听操作系统深色模式偏好，自动切换明暗主题。

**工作原理**：

1. `App.tsx` 中的 `useEffect` 在挂载时同步初始值：`setSystemPrefersDark(mq.matches)`
2. 注册 `change` 事件监听器，实时响应系统主题变化
3. `activeTheme()` 根据 `systemPrefersDark` 布尔值选择对应的 `lightTheme` 或 `darkTheme`
4. 系统主题变化时，自动同步 Claude Code 的主题设置（通过 `setClaudeTheme` API 调用）

**代码位置**：
- 系统偏好监听：`src/App.tsx:119-128`
- 系统主题变化同步：`src/App.tsx:130-136`
- Store 状态：`src/store/index.ts:333`（`systemPrefersDark`）

### 5. 主题持久化

**机制描述**：采用双层持久化策略 -- Zustand persist（localStorage）+ Tauri SQLite 后端。

**Zustand persist 层**：
- 存储键名：`termflow-settings`
- 版本号：`2`
- 持久化字段（通过 `partialize` 选择）：`lastProject`, `recentProjects`, `sessionEvents`, `projectSessions`, `projectArchivedSessions`, `projectWorkspaces`, `sidebarCollapsed`, `sidebarWidth` 等
- 主题设置不在此层持久化，而是通过 Tauri 后端

**Tauri SQLite 层**：
- `initializePersistentSettings()`：应用启动时从 SQLite 加载设置
- `savePersistentSettings()`：设置变更后 250ms 防抖写入 SQLite
- `PersistentSettings` 接口包含：`lightTheme`, `darkTheme`, `themeCategory`, `language` 等完整设置

**数据规范化**：加载时通过 `normalizeThemeModeValue()`、`normalizeDarkThemeModeValue()`、`normalizeThemeCategoryValue()` 确保值的合法性，无效值回退到默认值。

**代码位置**：
- Zustand persist 配置：`src/store/index.ts:1612-1666`
- SQLite 初始化：`src/App.tsx:138-159`
- SQLite 保存（防抖）：`src/App.tsx:161-184`
- 值规范化：`src/store/index.ts:83-97`

### 6. 设置面板主题 UI

**机制描述**：SettingsPanel 中的 "通用" 页面提供主题选择界面，包含主题类别切换和主题卡片网格。

**UI 组成**：
- **主题类别选择**：Ant Design `Segmented` 控件，选项为 "亮色" / "暗色" / "跟随系统"
- **主题卡片网格**：`ThemeCard` 组件，2列网格布局，每个卡片显示主题预览色、名称和描述
- **Claude Code 主题同步**：显示当前 Claude Code 的主题状态，并在切换时自动同步

**ThemeCard 组件**：每个卡片包含一个预览条（带径向渐变高光和迷你终端线条模拟），选中时显示勾选标记和主色边框。

**代码位置**：
- ThemeCard 组件：`src/components/SettingsPanel.tsx:164-231`
- 主题选择逻辑：`src/components/SettingsPanel.tsx:374-387`
- 主题类别选项：`src/components/SettingsPanel.tsx:352-356`

## 数据流

```
用户操作（SettingsPanel）
    │
    ├─ setThemeCategory(category)  ──┐
    ├─ setLightTheme(theme)         ──┤
    ├─ setDarkTheme(theme)          ──┤
    │                                 │
    ▼                                 │
Zustand Store (themeCategory,         │
  lightTheme, darkTheme,              │
  systemPrefersDark)                  │
    │                                 │
    ├─ activeTheme() 计算当前主题 ◄────┘
    │       │
    │       ▼
    │  App.tsx useEffect
    │       │
    │       ├─ document.documentElement.setAttribute("data-theme", currentTheme)
    │       │       │
    │       │       ▼
    │       │  CSS 变量激活（themes.css [data-theme="xxx"]）
    │       │       │
    │       │       ▼
    │       │  全局样式更新（global.css 中的 var(--cs-*) 引用）
    │       │
    │       ├─ ConfigProvider theme.algorithm 切换
    │       │       │
    │       │       ▼
    │       │  Ant Design 组件主题更新
    │       │
    │       └─ setClaudeTheme() 同步 Claude Code 主题
    │
    └─ persistentSettings 变化
            │
            ▼
       savePersistentSettings() → SQLite（250ms 防抖）
```

## 依赖关系

### 内部依赖

| 依赖模块 | 关系 | 说明 |
|----------|------|------|
| `src/store/index.ts` | 核心 | Zustand store，管理所有主题状态和 actions |
| `src/styles/themes.css` | 核心 | 4 套主题的 CSS 变量定义 |
| `src/styles/global.css` | 消费 | 引用 themes.css，使用 `--cs-*` 变量定义组件样式 |
| `src/App.tsx` | 编排 | 主题切换的副作用处理、Ant Design 配置、持久化同步 |
| `src/components/SettingsPanel.tsx` | UI | 主题选择界面 |
| `src/lib/api/index.ts` | 存储 | `initializePersistentSettings`、`savePersistentSettings`、`setClaudeTheme`、`getClaudeTheme` |
| `src/lib/monaco.ts` | 辅助 | `getMonacoThemeName()` 根据明暗返回 Monaco 编辑器主题名 |

### 外部依赖

| 依赖 | 用途 |
|------|------|
| `zustand` + `zustand/middleware` | 状态管理和持久化中间件 |
| `antd` (ConfigProvider, theme) | Ant Design 主题算法切换 |
| `@tauri-apps/api` (invoke) | Tauri 后端 SQLite 存储调用 |
| `react-i18next` | 主题名称的国际化 |
