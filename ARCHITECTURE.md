# 项目架构

## 概述

Termflow 是一个基于 Tauri 的现代化终端应用程序，采用前后端分离架构。

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
│   │   └── events/        # 事件处理
│   └── capabilities/      # 权限配置
├── docs/                  # 设计文档
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

### 语音系统
- 语音识别 (ASR)
- 语音合成 (TTS)
- 语音命令处理

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
pnpm build:tauri

# 测试
pnpm test
```
