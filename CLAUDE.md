# Termflow 项目指南

## 技术栈

### 前端（src/）
- **语言**: TypeScript 5.8+（严格模式）
- **UI 框架**: React 19
- **构建工具**: Vite 6
- **测试**: Vitest（node 环境）
- **CSS**: Tailwind CSS 3 + PostCSS
- **组件库**: Ant Design 5
- **状态管理**: Zustand 5（带 persist 中间件）
- **国际化**: i18next + react-i18next
- **终端模拟**: xterm.js 6
- **代码编辑器**: Monaco Editor
- **图表渲染**: Mermaid
- **数据库**: sql.js（前端）
- **路径别名**: `@/` → `src/`

### 后端（src-tauri/）
- **语言**: Rust (edition 2021)
- **框架**: Tauri 2
- **PTY 管理**: portable-pty
- **Git 操作**: git2 (libgit2)
- **HTTP 客户端**: reqwest (rustls-tls)
- **数据库**: rusqlite (bundled)
- **序列化**: serde + serde_json + serde_yaml

### 构建与打包
- **包管理器**: pnpm 10
- **前端构建**: `tsc && vite build`
- **开发服务器**: 端口 1420
- **打包目标**: NSIS 安装程序（仅 Windows）

---

## 目录结构

```
Termflow/
├── src/                          # 前端源码
│   ├── App.tsx                   # 根组件，主题/i18n/设置管理
│   ├── main.tsx                  # React 入口
│   ├── i18n.ts                   # i18next 初始化
│   ├── components/               # UI 组件
│   │   ├── Terminal.tsx          # xterm.js 终端组件
│   │   ├── TabBar.tsx            # 标签栏
│   │   ├── SettingsPanel.tsx     # 设置面板
│   │   ├── VoiceButton.tsx       # 语音触发按钮
│   │   ├── layout/               # 布局组件（AppLayout, TitleBar, StatusBar, Sidebar）
│   │   ├── editors/              # 编辑器组件（MonacoTextEditor）
│   │   ├── markdown/             # Markdown 渲染
│   │   ├── settings/             # 设置页面
│   │   └── ui/                   # 通用 UI 组件
│   ├── constants/                # 常量定义
│   ├── hooks/                    # 自定义 React Hooks
│   ├── lib/                      # 工具库
│   │   └── api/                  # Tauri IPC 调用封装（所有 invoke() 集中在此）
│   ├── locales/                  # 国际化资源（zh-CN.json, en-US.json）
│   ├── pages/                    # 页面组件
│   ├── store/                    # Zustand 状态管理
│   │   ├── index.ts              # 主 store（大型单文件，正在重构中）
│   │   ├── types.ts              # Store 类型定义
│   │   └── slices/               # Store 分片（重构目标）
│   ├── styles/                   # 样式（global.css, themes.css）
│   └── types/                    # 全局 TypeScript 类型定义
├── src-tauri/                    # Rust 后端
│   ├── src/
│   │   ├── main.rs               # Rust 入口
│   │   ├── lib.rs                # Tauri Builder 配置 + 命令注册
│   │   ├── pty.rs                # PTY 进程管理
│   │   ├── events.rs             # 事件系统
│   │   ├── database/             # SQLite 数据库层
│   │   └── commands/             # Tauri 命令模块
│   └── capabilities/             # Tauri 权限配置
├── docs/                         # 设计文档
├── scripts/                      # 构建脚本
└── public/                       # 静态资源
```

---

## 命名约定

### 文件名
- **React 组件**: PascalCase（`AppLayout.tsx`, `VoiceButton.tsx`）
- **非组件文件**: camelCase（`terminalTitle.ts`, `runtimeDetection.ts`）
- **测试文件**: 与源文件同名 + `.test.ts`（`terminalTitle.test.ts`）
- **样式文件**: kebab-case（`global.css`, `themes.css`）
- **Rust 文件**: snake_case（`hook_ingest.rs`, `path_utils.rs`）

### 代码命名
- **变量/函数**: camelCase（`currentProject`, `toggleSidebar()`）
- **类型/接口**: PascalCase（`SessionStreamEvent`, `TabEntity`）
- **常量**: UPPER_SNAKE_CASE（`MAIN_PANE_ID`, `DEFAULT_SIDEBAR_WIDTH`）
- **Action 函数**: `set` 前缀（`setLightTheme`）或 `toggle` 前缀（`toggleSidebar`）
- **Normalize 函数**: `normalize` 前缀（`normalizeAsrModel`）

### CSS 类名
- 使用 `app-` 前缀的 BEM-like 命名（`app-sidebar-surface`, `app-main-stage-body`）
- 语音相关使用 `voice-settings-` 前缀
- 主题通过 `data-theme` 属性切换

### Tauri 命令
- **Rust 端**: snake_case（`spawn_pty`, `get_claude_cli_info`）
- **前端封装**: camelCase（`spawnPty()`, `getClaudeCliInfo()`）
- **所有 IPC 调用**: 集中在 `src/lib/api/index.ts`

---

## 禁忌

### 代码规范
- ❌ 不要使用 `any` 类型，除非绝对必要且有注释说明原因
- ❌ 不要引入未使用的依赖（TypeScript 严格模式会报错）
- ❌ 不要在组件内直接调用 Tauri invoke，统一使用 `src/lib/api/` 封装
- ❌ 不要绕过 Zustand store 直接操作状态
- ❌ 不要使用 inline style，优先使用 Tailwind CSS 类名

### 架构约束
- ❌ 不要创建新的全局状态管理方案，使用现有 Zustand store
- ❌ 不要直接修改 `src/store/index.ts` 中的大型 store，新状态应放入 `slices/` 目录
- ❌ 不要在前端直接操作数据库，所有数据持久化通过 Tauri 命令
- ❌ 不要硬编码主题颜色，使用 CSS 变量（`--cs-` 前缀）

### 命名禁忌
- ❌ 组件文件不要使用 camelCase（`appLayout.tsx` ❌ → `AppLayout.tsx` ✅）
- ❌ 非组件文件不要使用 PascalCase（`TerminalTitle.ts` ❌ → `terminalTitle.ts` ✅）
- ❌ CSS 类名不要使用无前缀的名称（`sidebar` ❌ → `app-sidebar` ✅）

### 测试与构建
- ❌ 不要使用 jsdom 环境运行测试（项目配置为 node 环境）
- ❌ 不要在测试文件中使用 `describe` 嵌套过深（保持扁平结构）
- ❌ 不要提交未通过 `tsc` 类型检查的代码

### 国际化
- ❌ 不要硬编码用户界面文本，使用 i18next 翻译键
- ❌ 不要遗漏中文翻译（主要语言为中文）

---

## 特殊模式

### 主题系统
- 4 套主题：`light-glass`, `light-warm`, `dark-starry`, `dark-mocha`
- 分为 light/dark 两组，支持跟随系统主题
- CSS 变量前缀：`--cs-`（`--cs-bg-app`, `--cs-text-primary`, `--cs-primary`）

### 持久化双轨
- 设置通过两条路径持久化：
  1. Zustand persist（localStorage）
  2. SQLite（通过 Tauri 命令 `save_persistent_settings`）
- `App.tsx` 中有 250ms 防抖的同步逻辑

### 多窗口架构
- 主窗口
- `VoiceOverlayWindow`（`?overlay=voice`）
- `VoiceWorkerWindow`（`?worker=voice`）

### 代码风格
- 中文注释为主
- TypeScript 严格模式（`noUnusedLocals`, `noUnusedParameters`）
- 组件使用 Ant Design `ConfigProvider` 包裹

---

## 常用命令

```bash
# 开发
pnpm dev                    # 启动开发服务器（Vite + Tauri）

# 构建
pnpm build                  # TypeScript 检查 + Vite 构建
pnpm build:tauri            # 完整 Tauri 应用构建

# 测试
pnpm test                   # 运行 Vitest 测试
pnpm test:watch             # 监听模式运行测试

# 代码质量
pnpm lint                   # ESLint 检查
pnpm format                 # Prettier 格式化
```
