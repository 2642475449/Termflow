# 项目架构

## 概述

Termflow 是一个基于 Tauri 2 的本地桌面工作台，用于在同一项目上下文中使用多个 CLI 智能体、终端和 Git 工作流。

## 技术栈

### 前端 (src/)
- **框架**: React 19 + TypeScript 5.8+
- **构建工具**: Vite 6
- **状态管理**: Zustand 5
- **UI 组件**: Ant Design 5
- **样式**: Tailwind CSS 3
- **终端模拟**: xterm.js 6
- **代码编辑器**: Monaco Editor

### 后端 (src-tauri/)
- **语言**: Rust
- **框架**: Tauri 2
- **PTY 管理**: portable-pty
- **Git 操作**: git2
- **数据库**: rusqlite

## 目录结构

```
Termflow/
├── src/                    # 前端源码
│   ├── components/         # React 组件
│   ├── store/             # Zustand 状态管理
│   ├── hooks/             # 自定义 Hooks
│   ├── lib/               # 工具库
│   ├── pages/             # 页面组件
│   ├── styles/            # 样式文件
│   └── types/             # TypeScript 类型定义
├── src-tauri/             # Rust 后端
│   ├── src/
│   │   ├── commands/      # Tauri 命令
│   │   ├── database/      # 数据库操作
│   │   ├── events.rs      # 应用事件
│   │   └── pty.rs         # PTY 与进程管理
│   └── capabilities/      # 权限配置
└── scripts/               # 构建脚本
```

## 数据流

1. **前端 → 后端**: 通过 Tauri IPC 调用 Rust 命令
2. **后端 → 前端**: 通过事件系统推送数据
3. **状态管理**: Zustand store 统一管理前端状态
4. **持久化**: 双轨模式（localStorage + SQLite）

## 核心模块

### 终端管理
- PTY 进程创建和管理
- 多标签页支持
- 会话持久化

### 文件管理与编辑
- 项目文件树浏览、全文搜索和文件标签页
- Markdown 预览与即时编辑
- 将项目文件拖放到当前 CLI 输入

### 智能体与终端
- Claude Code、Codex、Antigravity CLI、OpenCode 与 Qoder CLI 的检测和启动
- 基于 portable-pty 的嵌入式终端与会话恢复
- Agent Hook、检查点审阅和会话状态事件

### 语音输入
- MiMo 与 DashScope 语音识别 (ASR)
- 全局快捷键和录音状态悬浮窗
- 将识别文本写入系统输入目标或当前终端

### 主题系统
- 4 套内置主题
- CSS 变量管理
- 跟随系统主题

## 构建流程

```bash
# 开发
pnpm dev

# 构建
pnpm build
pnpm tauri build

# 测试
pnpm test
```
