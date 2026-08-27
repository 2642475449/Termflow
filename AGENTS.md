# AGENTS.md — Termflow 智能体协作指南

本文件为 AI 编码智能体（Claude Code、Codex、Qoder 等）提供 Termflow 项目的模块职责、编码约定和变更注意事项。  
在对本项目做任何修改之前，**必须**先阅读本文件以确保变更符合架构约束和工程规范。

---

## 1. 项目概览

Termflow 是基于 **Tauri 2** 的本地桌面工作台，在同一项目上下文中整合多个 CLI 智能体、终端与 Git 工作流。

| 层 | 技术 |
|---|---|
| 前端 | React 19 + TypeScript 5.8+（严格模式）+ Vite 6 |
| 状态管理 | Zustand 5（带 persist 中间件） |
| UI | Ant Design 5 + Tailwind CSS 3 |
| 终端 | xterm.js 6 |
| 编辑器 | Monaco Editor |
| 国际化 | i18next + react-i18next |
| 后端 | Rust (edition 2021) + Tauri 2 |
| PTY | portable-pty |
| Git | git2 (libgit2) |
| 数据库 | rusqlite (bundled) |
| 包管理器 | pnpm 10 |

---

## 2. 核心模块职责

### 2.1 `src/components/` — React UI 组件

负责所有可视化组件。子目录按功能域划分：

| 子目录 / 文件 | 职责 |
|---|---|
| `layout/` | 应用骨架：AppLayout、TitleBar、StatusBar、Sidebar、AuxiliaryDock |
| `layout/sidebar/` | 侧边栏子组件：Git 面板（分支/提交/冲突/图形）、项目面板、会话面板 |
| `layout/TitleBarProjectSwitcher.tsx` | 标题栏项目切换器 |
| `layout/TitleBarQuickSearch.tsx` | 标题栏快速搜索 |
| `layout/CloneRepositoryModal.tsx` | 克隆仓库模态框 |
| `editors/` | Monaco 代码编辑器：MonacoTextEditor、MonacoContextMenu |
| `markdown/` | Markdown 渲染与预览：MarkdownPreview、starryNight 语法高亮、源块映射 |
| `settings/` | 设置面板分区页面：Agents、ArchivedSessions、ClaudeMd、DataPrivacy、Git、Notifications、QuickCommands、SearchIndex |
| `terminal/` | 终端子组件：FilePathLinkProvider（文件路径可点击链接） |
| `pdf/` | PDF 预览（PdfPreview） |
| `ui/` | 通用 UI 基础组件：ShortcutHint |
| `Terminal.tsx` | xterm.js 终端主组件，处理 PTY 数据流 |
| `TabBar.tsx` | 多标签栏管理（终端/编辑器/会话） |
| `SettingsPanel.tsx` | 设置入口面板 |
| `VoiceButton.tsx` / `VoiceOverlayWindow.tsx` / `VoiceWorkerWindow.tsx` | 语音输入三件套：触发、悬浮窗、Worker |
| `CheckpointReviewDrawer.tsx` | 检查点审阅抽屉 |
| `SessionCheckpointSummaryBar.tsx` | 会话检查点摘要栏 |
| `GitDiffTabView.tsx` | Git 差异对比标签页 |
| `FileTabView.tsx` | 文件标签页视图 |
| `QuickCommandDialog.tsx` / `QuickCommandsButton.tsx` | 快速命令入口 |
| `GlobalTextSearchDialog.tsx` | 全局文本搜索对话框 |
| `NewSessionDialog.tsx` | 新建会话对话框 |
| `SideQuestionComposer.tsx` | 侧边提问输入框 |
| `AgentActivityIcon.tsx` / `AgentIcon.tsx` | 智能体状态图标 |
| `GitIcon.tsx` | Git 图标组件 |
| `ContentOverviewPopover.tsx` | 内容概览气泡卡 |
| `AuxiliaryFileView.tsx` | 辅助文件视图 |
| `terminalTitle.ts` | 终端标题格式化工具 |

**约定**：
- 组件文件使用 **PascalCase**（`AppLayout.tsx`）
- 组件内部只通过 `src/lib/api/` 调用后端，禁止直接 `invoke()`
- 状态读写统一走 Zustand store，不维护本地业务状态
- 样式优先使用 Tailwind CSS 类名，不使用 inline style
- CSS 类名使用 `app-` 前缀的 BEM-like 命名（`app-sidebar-surface`）

### 2.2 `src/lib/` — 工具库与业务逻辑

纯逻辑层，不含 React 组件。按功能域拆分为独立文件：

| 文件 / 子目录 | 职责 |
|---|---|
| `api/` | **所有 Tauri IPC 调用封装**（`invoke()` 的唯一出口） |
| `agents.ts` | 智能体检测、启动、配置管理 |
| `agentUserResponse.ts` | 智能体用户响应处理 |
| `sessions.ts` | 会话生命周期管理 |
| `archivedSessions.ts` | 已归档会话管理 |
| `attention.ts` | 终端注意力（未读/提及）检测 |
| `attentionDiagnostics.ts` | 注意力诊断工具 |
| `attentionPersistence.ts` | 注意力状态持久化 |
| `runtimeDetection.ts` | 运行时环境检测（Node、CLI 工具） |
| `terminalTheme.ts` | 终端主题映射 |
| `terminalResize.ts` | 终端尺寸同步 |
| `terminalSubmission.ts` | 终端输入提交逻辑 |
| `terminalSettings.ts` | 终端设置管理 |
| `terminalImeOutput.ts` | 终端 IME 输入法输出处理 |
| `textContent.ts` | 终端文本内容处理（ANSI 转义序列剥离） |
| `gitStatusEvents.ts` / `gitGraphEvents.ts` / `gitDiffNavigation.ts` | Git 状态事件、图形事件、差异导航 |
| `gitDiffLayout.ts` | Git 差异视图布局 |
| `gitFileHistory.ts` | Git 文件历史 |
| `gitSyncPolicy.ts` / `gitRemoteError.ts` | Git 同步策略与远程错误处理 |
| `gitCommitMessageProfiles.ts` | Git 提交消息配置 |
| `checkpointDiff.ts` / `checkpointReview.ts` | 检查点差异与审阅 |
| `quickCommands.ts` / `quickCommandSearch.ts` | 快速命令逻辑 |
| `quickSettingsMenu.ts` | 快速设置菜单 |
| `globalSearch.ts` / `globalSearchLayout.ts` | 全局搜索逻辑 |
| `monaco.ts` / `monacoContextMenu.ts` / `monacoContextMenuActions.ts` | Monaco 编辑器配置与右键菜单 |
| `asrRuntime.ts` / `mimoAsr.ts` / `dashscopeAsr.ts` | ASR 语音识别运行时 |
| `contentOverview.ts` | 内容概览数据聚合 |
| `fileNavigation.ts` / `fileIcon.tsx` | 文件导航与图标 |
| `explorer.ts` | 文件浏览器事件（路径定位、全选） |
| `sideQuestion.ts` | 侧边提问预设与上下文管理 |
| `codexUsage.ts` | Codex/Claude 用量与速率限制状态判断 |
| `backgroundTasks.ts` | 后台任务状态（克隆、索引） |
| `remoteNotifications.ts` | 远程通知提供商配置（飞书等） |
| `sessionVisibility.ts` | 会话可见性布局分析 |
| `tabClose.ts` | 标签页关闭与归档逻辑 |
| `auxiliaryDock.ts` | 辅助停靠逻辑 |
| `sounds.ts` | 提示音管理 |
| `toast.ts` | Toast 通知封装 |
| `shortcut.ts` | 快捷键工具 |
| `antd.ts` | Ant Design 按需引入与定制（tsconfig paths 映射） |

**约定**：
- 非组件文件使用 **camelCase**（`terminalTitle.ts`）
- 每个文件职责单一，配套 `.test.ts` 测试文件
- 导出函数使用具名导出，避免默认导出（除非是 React 组件）
- 新增工具文件必须附带单元测试

### 2.3 `src/store/` — Zustand 状态管理

集中管理前端全局状态。

| 文件 / 子目录 | 职责 |
|---|---|
| `index.ts` | 主 store 定义（大型单文件，正在重构中） |
| `types.ts` | Store 状态与 Action 类型定义 |
| `slices/` | Store 分片（重构目标目录） |
| `slices/sessionSlice.ts` | 会话相关状态 |
| `slices/terminal.ts` | 终端相关状态 |
| `slices/theme.ts` | 主题相关状态 |
| `slices/windowSlice.ts` | 窗口相关状态 |
| `slices/workspaceSlice.ts` | 工作区相关状态 |
| `slices/notification.ts` | 通知相关状态 |
| `slices/security.ts` | 安全/权限相关状态 |
| `utils/` | Store 工具函数 |
| `utils/recentProjects.ts` | 最近项目管理 |
| `utils/session.ts` | 会话工具函数 |
| `utils/workspace.ts` | 工作区工具函数 |
| `auxiliaryDock.ts` | 辅助停靠状态 |

**约定**：
- Action 函数使用 `set` 前缀（`setLightTheme`）或 `toggle` 前缀（`toggleSidebar`）
- Normalize 函数使用 `normalize` 前缀（`normalizeAsrModel`）
- **新状态必须放入 `slices/` 目录**，不要修改 `index.ts` 中的大型 store
- 持久化走双轨：Zustand persist（localStorage）+ SQLite（通过 Tauri 命令）
- 禁止在组件中绕过 store 直接操作状态

### 2.4 `src/hooks/` — 自定义 React Hooks

| 文件 | 职责 |
|---|---|
| `useGitCommit.ts` | Git 提交逻辑 |
| `useGitFileWatcher.ts` | Git 文件变更监听 |
| `useGitRefreshController.ts` | Git 刷新控制器 |
| `useGitStatus.ts` | Git 状态 Hook |
| `useKeyboardShortcuts.ts` | 全局快捷键绑定 |
| `useProjectLauncher.ts` | 项目启动器 |
| `useResumeSession.ts` | 会话恢复 |
| `useVoiceRecognition.ts` | 语音识别 Hook |
| `useDefaultInstalledAgentSelection.ts` | 默认已安装智能体选择 |
| `useRecentProjectSync.ts` | 最近项目同步 |

**约定**：
- 文件名以 `use` 开头 + PascalCase（`useGitCommit.ts`）
- Hook 内部调用 `src/lib/api/` 与 store，不直接包含业务逻辑
- 配套 `.test.ts` 测试

### 2.5 `src/pages/` — 页面组件

顶层路由页面，组合 layout 与业务组件。当前位于 `pages/home/`。

### 2.6 `src/locales/` — 国际化资源

包含 `zh-CN.json`、`en-US.json` 等翻译文件。

**约定**：
- 所有用户可见文本必须使用翻译键，禁止硬编码
- 主要语言为中文，新增键必须同时提供中英文翻译

### 2.7 `src-tauri/src/` — Rust 后端

| 文件 / 子目录 | 职责 |
|---|---|
| `main.rs` | Rust 入口 |
| `lib.rs` | Tauri Builder 配置 + 命令注册 |
| `pty.rs` | PTY 进程创建与管理（portable-pty） |
| `events.rs` | 应用事件系统（前端推送） |
| `hook_ingest.rs` | Agent Hook 数据摄入 |
| `path_utils.rs` | 路径工具 |
| `claude_usage.rs` / `codex_usage.rs` / `qoder_usage.rs` | 各智能体用量统计 |
| `claude_rate_limits.rs` / `codex_rate_limits.rs` | 智能体速率限制 |
| `opencode_control.rs` | OpenCode 进程控制 |
| `qoder_config.rs` | Qoder 配置管理 |
| `commands/` | Tauri 命令模块（按功能域拆分） |
| `commands/agents.rs` | 智能体相关命令 |
| `commands/agent_hooks.rs` | Agent Hook 命令 |
| `commands/agent_runner.rs` | 智能体运行器命令 |
| `commands/agent_usage.rs` | 智能体用量聚合与查询 |
| `commands/session.rs` | 会话管理命令 |
| `commands/settings.rs` | 设置持久化命令 |
| `commands/claude_config.rs` | Claude 配置与用量查询（大型模块） |
| `commands/command_library.rs` | 命令库管理（AGENTS.md、CLAUDE.md 等配置文件解析与执行） |
| `commands/file_tree.rs` | 文件树操作命令 |
| `commands/explorer_context_menu.rs` | Windows 资源管理器右键菜单集成 |
| `commands/feishu.rs` | 飞书通知集成 |
| `commands/image.rs` | 图片保存与管理 |
| `commands/system_input.rs` | 系统级输入（Unicode 键盘事件发送） |
| `commands/git/` | Git 操作命令子模块（branch、commit、diff、graph、status、remote、clone、checkpoint、conflict、ai、watcher 等） |
| `commands/voice.rs` / `commands/voice_shortcut.rs` | 语音相关命令 |
| `commands/window.rs` | 窗口管理命令 |
| `commands/notification.rs` / `commands/remote_notification.rs` | 通知命令 |
| `commands/search_index.rs` / `commands/content_search.rs` | 搜索索引命令 |
| `commands/mcp_servers.rs` | MCP 服务器管理命令 |
| `commands/skills.rs` | 技能管理命令 |
| `database/` | SQLite 数据库层（mod.rs + schema.rs） |

**约定**：
- Rust 文件使用 **snake_case**（`hook_ingest.rs`）
- Tauri 命令在 Rust 端使用 snake_case（`spawn_pty`），前端封装为 camelCase（`spawnPty`）
- 所有新命令必须在 `lib.rs` 中注册
- 数据库操作集中在 `database/` 目录

---

## 3. 编码约定

### 3.1 TypeScript / 前端

| 规则 | 说明 |
|---|---|
| 严格模式 | `strict: true` + `noUnusedLocals` + `noUnusedParameters` |
| 路径别名 | `@/` → `src/`（tsconfig paths） |
| 类型安全 | 禁止 `any`，除非有注释说明原因 |
| 组件命名 | PascalCase 文件，函数组件导出同名 |
| 工具命名 | camelCase 文件，具名导出 |
| 常量命名 | UPPER_SNAKE_CASE（`MAIN_PANE_ID`） |
| CSS 类名 | `app-` 前缀 BEM-like（`app-main-stage-body`） |
| 主题变量 | `--cs-` 前缀（`--cs-bg-app`、`--cs-text-primary`） |
| 注释语言 | 以中文注释为主 |
| 测试 | Vitest（node 环境），测试文件 `*.test.ts`，扁平结构不嵌套 `describe` |

### 3.2 Rust / 后端

| 规则 | 说明 |
|---|---|
| Edition | Rust 2021 |
| 命名 | snake_case 函数/文件，PascalCase 类型 |
| 序列化 | serde + serde_json + serde_yaml |
| 错误处理 | 使用 `Result` + `thiserror`，不 `unwrap()` |
| 命令注册 | 在 `lib.rs` 的 `invoke_handler` 中统一注册 |

### 3.3 Git 提交

使用约定式提交（Conventional Commits）：

```
<type>(<scope>): <subject>
```

类型：`feat`、`fix`、`docs`、`style`、`refactor`、`test`、`chore`

---

## 4. 变更注意事项

### 4.1 通用原则

1. **不要绕过 IPC 封装层**：所有前端对 Rust 的调用必须通过 `src/lib/api/index.ts`，禁止在组件中直接 `invoke()`。
2. **不要绕过 Zustand store**：全局状态读写统一通过 store，不要在组件中维护平行业务状态。
3. **不要硬编码文本**：所有用户可见字符串走 i18next 翻译键。
4. **不要硬编码颜色**：使用 CSS 变量（`--cs-` 前缀），支持多主题。
5. **不要使用 inline style**：优先 Tailwind CSS 类名。
6. **变更前后运行验证**：`pnpm test` + `pnpm build`（涉及 Rust 时在 `src-tauri/` 运行 `cargo test`）。

### 4.2 新增前端功能

- 新组件放入 `src/components/` 对应子目录，PascalCase 命名
- 新工具函数放入 `src/lib/`，camelCase 命名，附带 `.test.ts`
- 新全局状态放入 `src/store/slices/`，**不要**修改 `src/store/index.ts` 主文件
- 新 Hook 放入 `src/hooks/`，以 `use` 开头命名
- 新增 Tauri 命令调用时，先在 `src/lib/api/index.ts` 添加封装函数

### 4.3 新增 Rust 后端功能

- 新命令文件放入 `src-tauri/src/commands/`，在 `mod.rs` 中声明
- 在 `lib.rs` 的 `invoke_handler` 中注册新命令
- 数据库操作放入 `src-tauri/src/database/`
- 事件定义放入 `src-tauri/src/events.rs`
- PTY 相关逻辑放入 `src-tauri/src/pty.rs`

### 4.4 主题与样式变更

- 新增/修改主题变量时，同步更新 `src/styles/themes.css` 中所有 4 套主题
- 变量命名保持 `--cs-` 前缀
- 不要删除已有 CSS 变量（可能有多处引用）

### 4.5 国际化变更

- 新增翻译键时，**必须同时更新** `zh-CN.json` 和 `en-US.json`
- 翻译键使用点分隔命名空间（`settings.general.language`）
- 不要遗漏中文翻译

### 4.6 Store 重构注意

- `src/store/index.ts` 是大型单文件，正在向 `slices/` 迁移
- 新状态**只放入** `slices/` 目录下的分片文件
- 修改 store 类型定义时，同步更新 `src/store/types.ts`
- 持久化字段变更需检查双轨同步逻辑（`App.tsx` 中的 250ms 防抖同步）

### 4.7 多窗口架构注意

- 主窗口、`VoiceOverlayWindow`（`?overlay=voice`）、`VoiceWorkerWindow`（`?worker=voice`）共享同一前端代码
- 修改 `App.tsx` 或路由逻辑时，确保不影响其他窗口的查询参数判断
- 窗口间通信通过 Tauri 事件系统，不共享内存状态

### 4.8 测试注意

- 测试环境为 **node**（非 jsdom），不要依赖 DOM API
- 测试文件与源文件同目录，命名 `*.test.ts`
- 保持扁平 `describe` 结构，不嵌套过深
- 新增 `src/lib/` 工具文件必须附带测试

---

## 5. 常用命令

```bash
# 开发
pnpm dev                          # 启动 Vite 开发服务器
pnpm tauri dev                    # 启动完整 Tauri 桌面应用

# 构建
pnpm build                        # TypeScript 检查 + Vite 前端构建
pnpm build:tauri                  # 完整 Tauri 应用构建

# 测试
pnpm test                         # 运行 Vitest 测试
pnpm test:watch                   # 监听模式

# Rust 后端（在 src-tauri/ 目录）
cargo test                        # Rust 单元测试
cargo build                       # Rust 构建

# 代码质量
pnpm lint                         # ESLint
pnpm format                       # Prettier
```

---

## 6. 数据流速查

```
用户操作 → React 组件 → Zustand Store Action
                         ↓
                    src/lib/api/ (invoke 封装)
                         ↓
                    Tauri IPC → Rust 命令
                         ↓
                    业务逻辑 / SQLite / PTY / Git
                         ↓
                    Tauri 事件 → 前端监听 → Store 更新 → UI 重渲染
```

---

## 7. 禁忌速查

| 禁止 | 替代方案 |
|---|---|
| 组件内直接 `invoke()` | 通过 `src/lib/api/` 封装 |
| 绕过 Zustand store | 使用 store action |
| 修改 `store/index.ts` 主文件 | 新增 `store/slices/` 分片 |
| 使用 `any` 类型 | 定义具体类型或加注释说明 |
| inline style | Tailwind CSS 类名 |
| 硬编码颜色 | CSS 变量 `--cs-*` |
| 硬编码文本 | i18next 翻译键 |
| jsdom 测试环境 | node 环境 (Vitest) |
| 嵌套 `describe` | 扁平测试结构 |
| 前端直接操作数据库 | 通过 Tauri 命令 |
