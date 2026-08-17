<h1 align="center">
  <img src="public/logo.png" width="56" alt="Termflow Logo" align="absmiddle">
  Termflow
</h1>

<p align="center">
  <strong>面向终端的 CLI 智能体工作台</strong><br>
  本地优先 · 项目与会话管理 · 嵌入式终端 · Git 工作流 · 检查点审阅
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tauri_2-24C8DB?style=flat-square&logo=tauri&logoColor=white" alt="Tauri 2">
  <img src="https://img.shields.io/badge/React_19-61DAFB?style=flat-square&logo=react&logoColor=white" alt="React 19">
  <img src="https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white" alt="Rust">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Windows-0078D6?style=flat-square&logo=windows&logoColor=white" alt="Windows">
  <img src="https://img.shields.io/badge/v1.8.19-blue?style=flat-square" alt="Version">
</p>

<p align="center">
  <img src="public/images/termflow-overview.png" alt="Termflow 界面预览" width="100%">
</p>

---

## 简介

**Termflow** 是一款基于 Tauri 2 构建、面向终端的 CLI 智能体工作台。它将多种 CLI 智能体的命令行体验组织到统一的本地图形界面中，让项目、会话、终端与 Git 工作流保持在同一个上下文里。

核心特性：
- 🤖 **多智能体与多会话**：按项目组织不同智能体的多个会话
- 🖥️ **嵌入式终端**：在图形界面中保留熟悉的 CLI 工作方式
- 🎤 **语音输入**：支持 DashScope ASR，全局快捷键触发
- 📊 **Git 面板**：完整的 Git 工作流 + AI 生成提交信息
- 🔍 **检查点审阅**：Agent 回合检查点审阅与差异对比
- ⚡ **快速命令**：自定义快捷命令，一键执行常用操作
- 🎨 **多套主题**：深色、浅色与跟随系统切换
- 💾 **会话持久化**：关闭应用后无缝恢复历史对话
- 🌐 **多语言支持**：中文、英文、日语界面

## 为什么开源

Termflow 最初是为了做一款符合自己使用习惯的应用。在功能与使用体验逐渐完善后，我将它开源，也希望为大家选择工具时提供另一种选择。

## 核心功能

| 功能说明 | 界面预览 |
| :--- | :--- |
| **多会话管理**：侧边栏树状导航会按项目目录自动分组；一键新建会话，并实时显示每个会话的活跃状态。 | ![Termflow 多会话管理界面](public/images/termflow-overview.png) |
| **嵌入式终端**：基于 xterm.js + ConPTY 提供原生终端体验，自动适配窗口大小并同步 PTY 尺寸，完整支持 ANSI 色彩和光标控制。 | ![Termflow 工作台界面](public/images/termflow-overview.png) |
| **会话持久化**：通过 `--session-id`（UUID）创建会话；关闭后保留数据，重新打开即可恢复，并支持 `--resume` 无缝续接历史对话。 | ![Termflow 会话工作台](public/images/termflow-overview.png) |
| **检查点审阅系统**：自动记录 Agent 回合检查点，提供差异对齐、文件摘要和辅助面板，并可一键回滚到任意检查点。 | ![Termflow 检查点审阅工作台](public/images/termflow-overview.png) |
| **快速命令系统**：自定义快捷命令库，一键执行常用操作；支持命令分类、搜索与参数化模板。 | ![Termflow 快捷操作界面](public/images/termflow-overview.png) |
| **语音输入系统**：支持 DashScope ASR、运行时切换识别提供商和全局快捷键；悬浮窗实时显示录音状态与音量。 | ![Termflow 语音输入工作台](public/images/termflow-overview.png) |
| **Git 面板**：覆盖提交、推送、拉取和同步等完整 Git 工作流，集成暂存区、差异查看、分支管理和 AI 提交信息生成。 | ![Termflow Git 工作台](public/images/termflow-overview.png) |
| **注意力中心与通知**：实时监控会话状态并推送智能通知；持久化记录注意力数据，帮助掌握工作节奏。 | ![Termflow 数据概览界面](public/images/termflow-overview.png) |
| **全局文本搜索**：在项目内进行全文搜索，支持正则表达式、文件类型过滤和结果高亮。 | ![Termflow 全局搜索界面](public/images/termflow-overview.png) |
| **自定义标题栏**：提供无边框窗口、自定义拖拽、快速搜索、项目切换、主题和语言设置，以及完整窗口控制。 | ![Termflow 自定义标题栏界面](public/images/termflow-overview.png) |

## 技术栈

| 层级 | 技术 | 用途 |
|------|------|------|
| 框架 | Tauri 2 | 跨平台桌面应用框架 |
| 后端 | Rust + portable-pty | PTY 终端模拟、进程管理 |
| 前端 | React 19 + TypeScript 5.8 | UI 渲染 |
| 终端 | xterm.js | 浏览器端终端模拟器 |
| 状态管理 | Zustand + persist | 全局状态 + 本地持久化 |
| UI 组件 | Ant Design 5 | 按钮、弹窗、标签等 |
| 样式 | TailwindCSS 3 + CSS 变量 | 原子化样式 + 主题系统 |
| 构建 | Vite 6 | 前端构建工具 |
| 国际化 | i18next | 多语言支持（中/英/日） |
| 代码编辑器 | Monaco Editor | 代码查看与编辑（Geist Mono 字体） |
| 图表渲染 | Mermaid | Git 提交历史图表 |
| 数据库 | sql.js / rusqlite | 前后端数据存储 |
| 语音识别 | DashScope ASR | 语音输入转文字 |
| Git 操作 | libgit2 (git2-rs) | Git 仓库操作 |
| HTTP 客户端 | reqwest | 后端网络请求 |

## 项目结构

```
Termflow/
├── src/                                # 前端源码
│   ├── App.tsx                         # 根组件（ConfigProvider + 主题驱动）
│   ├── main.tsx                        # 入口
│   ├── i18n.ts                         # i18next 国际化配置
│   ├── components/
│   │   ├── Terminal.tsx                # xterm.js 终端组件（含 4 套配色）
│   │   ├── VoiceButton.tsx             # 语音输入状态胶囊
│   │   ├── VoiceOverlayWindow.tsx      # 语音悬浮窗
│   │   ├── CheckpointReviewDrawer.tsx  # 检查点审阅抽屉
│   │   ├── SessionCheckpointSummaryBar.tsx # 检查点摘要栏
│   │   ├── QuickCommandDialog.tsx      # 快速命令对话框
│   │   ├── QuickCommandsButton.tsx     # 快速命令按钮
│   │   ├── GlobalTextSearchDialog.tsx  # 全局文本搜索
│   │   ├── AuxiliaryFileView.tsx       # 辅助文件视图
│   │   ├── SettingsPanel.tsx           # 设置面板（主题 + 语言 + 语音）
│   │   ├── layout/
│   │   │   ├── AppLayout.tsx           # 主布局
│   │   │   ├── Sidebar.tsx             # 侧边栏树状导航
│   │   │   ├── TitleBar.tsx            # 自定义标题栏
│   │   │   ├── StatusBar.tsx           # 状态栏
│   │   │   ├── AuxiliaryDock.tsx       # 辅助停靠面板
│   │   │   └── sidebar/
│   │   │       ├── SidebarGitPanel.tsx # Git 面板主组件
│   │   │       ├── GitCommitComposer.tsx # 提交表单
│   │   │       ├── GitFileList.tsx     # 文件列表
│   │   │       ├── GitGraphSection.tsx # 提交历史图表
│   │   │       └── GitBranchPanel.tsx  # 分支管理面板
│   │   ├── editors/
│   │   │   └── MonacoTextEditor.tsx    # Monaco 代码编辑器
│   │   ├── markdown/                   # Markdown 渲染组件
│   │   └── settings/
│   │       ├── AgentsPage.tsx          # 智能体设置页
│   │       ├── ClaudeMdPage.tsx        # Claude 配置页
│   │       ├── QuickCommandsPage.tsx   # 快速命令设置页
│   │       └── ArchivedSessionsPage.tsx # 归档会话页
│   ├── hooks/
│   │   ├── useVoiceRecognition.ts      # 语音识别 Hook
│   │   ├── useGitStatus.ts             # Git 状态 Hook
│   │   └── useGitCommit.ts             # Git 提交 Hook
│   ├── pages/home/index.tsx            # 首页（含问候语组件）
│   ├── store/
│   │   ├── index.ts                    # Zustand 全局状态
│   │   └── slices/                     # Store 分片（重构中）
│   ├── lib/
│   │   └── api/index.ts                # Tauri invoke 封装
│   ├── locales/                        # 国际化资源
│   │   ├── zh-CN.json                  # 中文
│   │   ├── en-US.json                  # 英文
│   │   └── ja-JP.json                  # 日语
│   ├── styles/
│   │   ├── global.css                  # 全局样式 + TailwindCSS
│   │   └── themes.css                  # 4 套主题 CSS 变量
│   └── types/index.ts                  # TypeScript 类型定义
│
├── src-tauri/                          # Rust 后端
│   ├── src/
│   │   ├── lib.rs                      # Tauri 入口（插件 + Command 注册）
│   │   ├── main.rs                     # 进程入口
│   │   ├── pty.rs                      # PTY 管理器（spawn/read/write/resize）
│   │   ├── commands/
│   │   │   ├── session.rs              # 会话 Commands
│   │   │   ├── git.rs                  # Git Commands
│   │   │   ├── voice.rs                # 语音 Commands
│   │   │   ├── agent_usage.rs          # 智能体用量统计
│   │   │   └── claude_config.rs        # Claude 配置命令
│   │   └── database/                   # SQLite 数据库层
│   ├── tauri.conf.json                 # Tauri 配置
│   ├── Cargo.toml                      # Rust 依赖
│   └── icons/                          # 应用图标
│
├── public/                             # 静态资源
├── docs/                               # 设计文档
├── scripts/                            # 构建脚本
└── package.json                        # Node.js 依赖
```

## 快速开始

### 环境要求

- **操作系统**：Windows 10 / 11
- **Node.js**：`20.14.0`
- **pnpm**：`10.33.0`
- **Rust**：`1.95.0`
- **Rust toolchain**：`1.95.0-x86_64-pc-windows-msvc`
- **Visual Studio Build Tools 2022**：安装 `Desktop development with C++`，并勾选 Windows 10/11 SDK
- **WebView2 Runtime**：Tauri Windows 桌面应用运行所需
- **Claude Code**：已安装（`npm install -g @anthropic-ai/claude-code`）

### 在新电脑复刻同一套开发环境

推荐按下面顺序安装，这样另一台电脑能尽量贴近当前仓库的实际开发环境。

#### 1. 安装 Node.js 与 pnpm

本项目当前使用的 Node / pnpm 基线如下：

```bash
node -v   # v20.14.0
pnpm -v   # 10.33.0
```

安装完成 Node.js 后，使用 Corepack 固定 pnpm 版本：

```bash
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm -v
```

> 仓库中的 `package.json` 已通过 `packageManager` 字段锁定 `pnpm@10.33.0`，配合 `pnpm-lock.yaml` 可以保证前端依赖解析结果尽量一致。

#### 2. 安装 Rust 与 MSVC 工具链

请安装 Rust，并显式使用和当前项目一致的 Windows MSVC 工具链：

```bash
rustup toolchain install 1.95.0-x86_64-pc-windows-msvc
rustup default 1.95.0-x86_64-pc-windows-msvc
rustc -V
cargo -V
```

为了让这个仓库在当前电脑上始终使用同一套 Rust 版本，建议在项目目录执行一次：

```bash
rustup override set 1.95.0-x86_64-pc-windows-msvc
rustup show active-toolchain
```

#### 3. 安装 Tauri 的 Windows 依赖

在 Windows 上开发 Tauri，除了 Rust 以外，还需要以下系统依赖：

- **Visual Studio Build Tools 2022**：至少包含 `MSVC v143` 与 Windows SDK
- **Microsoft Edge WebView2 Runtime**：用于桌面应用 WebView 容器

如果缺少这些依赖，`pnpm tauri dev` 或 `pnpm tauri build` 通常会在 Rust 编译或链接阶段失败。

#### 4. 克隆项目并安装依赖

```bash
git clone <your-repo-url>
cd Termflow
pnpm install
```

#### 5. 校验当前电脑是否与项目环境一致

建议在项目根目录执行下面的检查命令：

```bash
node -v
pnpm -v
rustc -V
cargo -V
rustup show active-toolchain
```

期望看到的关键版本：

| 工具 | 期望版本 |
|------|----------|
| Node.js | `v20.14.0` |
| pnpm | `10.33.0` |
| rustc | `1.95.0` |
| cargo | `1.95.0` |
| toolchain | `1.95.0-x86_64-pc-windows-msvc` |

### 安装依赖

```bash
pnpm install
```

### 前端开发

```bash
pnpm dev
```

默认启动前端开发服务器：`http://localhost:1420`

### 桌面应用开发

```bash
pnpm tauri dev
```

该命令会同时启动：

- Vite 前端开发服务器
- Tauri Rust 后端
- Windows 桌面应用壳

### 与当前仓库保持一致的关键点

- **前端包管理器版本**：由 `package.json` 的 `packageManager` 固定为 `pnpm@10.33.0`
- **前端依赖树**：由 `pnpm-lock.yaml` 固定
- **Rust 依赖版本**：由 `src-tauri/Cargo.toml` 固定
- **本机 Rust 工具链版本**：建议用 `rustup override set 1.95.0-x86_64-pc-windows-msvc` 在仓库级别固定
- **Tauri 开发入口**：由 `src-tauri/tauri.conf.json` 配置为 `beforeDevCommand = "pnpm dev"`

### 构建安装包

```bash
pnpm tauri build
```

构建产物位于 `src-tauri/target/release/bundle/nsis/`。

## 配置说明

### 语音识别

Termflow 支持多种语音识别提供商：

| 提供商 | 模型 | 说明 |
|--------|------|------|
| DashScope | `mimo-v2.5-asr` | 阿里云 DashScope ASR（默认） |
| 其他 | 可扩展 | 支持自定义 ASR 提供商 |

**配置项**：
- `asrModel`：语音识别模型（默认：`mimo-v2.5-asr`）
- `asrRuntime`：ASR 运行时（支持动态切换）
- `voiceShortcut`：语音输入快捷键（默认：`Ctrl+Shift+V`）
- `voiceInputTarget`：语音输入目标（`system` 或 `terminal`）

### 快速命令

快速命令系统允许用户自定义常用操作：

- **命令库管理**：创建、编辑、删除自定义命令
- **分类组织**：按项目或用途分类命令
- **参数化模板**：支持变量替换的命令模板
- **一键执行**：通过快捷键或按钮快速执行

### 主题系统

支持 4 套内置主题，通过 `data-theme` 属性切换：

| 主题 | 分类 | CSS 变量前缀 |
|------|------|--------------|
| 星空沉浸 | 深色 | `--cs-` |
| 摩卡棕夜 | 深色 | `--cs-` |
| 柔光毛玻璃 | 浅色 | `--cs-` |
| 暖木书房 | 浅色 | `--cs-` |

主题切换覆盖全局：标题栏、侧边栏、内容区、终端配色全部同步变化。

### 国际化

支持多语言切换：
- 中文（zh-CN）- 默认
- 英文（en-US）
- 日语（ja-JP）

语言设置通过 i18next 管理，支持动态切换。

## 工作原理

```
用户点击"新建会话"
    ↓
选择项目目录（Tauri dialog 插件）
    ↓
前端创建会话记录（UUID + Zustand store）
    ↓
调用 spawn_pty Command（Tauri IPC）
    ↓
Rust PTY 管理器创建 ConPTY
    ↓
启动 claude --dangerously-skip-permissions --session-id <uuid>
    ↓
后台线程读取 PTY 输出 → emit("pty-output") → 前端 xterm.js 渲染
    ↓
用户输入 → invoke("pty_input") → PTY 写入
```

会话恢复流程：

```
用户点击历史会话
    ↓
检测 active === false
    ↓
cleanupStaleSessions() — 清理残留 claude 进程
    ↓
spawnPty(sessionId, path, resume=true)
    ↓
claude --dangerously-skip-permissions --resume <uuid>
    ↓
Claude Code 恢复对话上下文
```

## 致谢

Termflow 使用了以下优秀的开源项目：

- [Tauri](https://tauri.app/) - 跨平台桌面应用框架
- [React](https://react.dev/) - UI 渲染库
- [xterm.js](https://xtermjs.org/) - 浏览器端终端模拟器
- [Ant Design](https://ant.design/) - UI 组件库
- [Zustand](https://zustand-demo.pmnd.rs/) - 状态管理库
- [Vite](https://vitejs.dev/) - 前端构建工具
- [i18next](https://www.i18next.com/) - 国际化框架
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) - 代码编辑器
- [Mermaid](https://mermaid-js.github.io/) - 图表渲染库
- [Geist Mono](https://vercel.com/font) - 等宽字体
- [reqwest](https://github.com/seanmonstar/reqwest) - Rust HTTP 客户端

## 许可证

本项目基于 [MIT 许可证](./LICENSE) 开源。
