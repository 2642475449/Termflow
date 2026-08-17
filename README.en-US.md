# Termflow

<p align="center">
  <a href="README.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a> | English | <a href="README.ja-JP.md">日本語</a>
</p>

<p align="center">
  <strong>A CLI agent workspace for the terminal</strong><br>
  Local-first · Project and session management · Embedded terminal · Git workflow · Checkpoint review
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tauri_2-24C8DB?style=flat-square&logo=tauri&logoColor=white" alt="Tauri 2">
  <img src="https://img.shields.io/badge/React_19-61DAFB?style=flat-square&logo=react&logoColor=white" alt="React 19">
  <img src="https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white" alt="Rust">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Windows-0078D6?style=flat-square&logo=windows&logoColor=white" alt="Windows">
  <img src="https://img.shields.io/badge/v1.8.19-blue?style=flat-square" alt="Version">
</p>

![Termflow overview](public/images/termflow-overview.png)

---

## Overview

**Termflow** is a Tauri 2 desktop workspace for terminal-based CLI agents. It brings the command-line experience of multiple agents into one local graphical application, keeping projects, sessions, terminals, and Git work in the same context.

Key capabilities:

- **Multiple agents and sessions** — organize several conversations for each project.
- **Embedded terminal** — keep a familiar CLI workflow inside the application.
- **Voice input** — DashScope ASR support with a global shortcut.
- **Git panel** — a complete Git workflow plus AI-generated commit messages.
- **Checkpoint review** — inspect agent-turn checkpoints and compare changes.
- **Quick commands** — define and run common actions with one click.
- **Themes** — dark, light, and system-following appearance options.
- **Persistent sessions** — reopen historical conversations after restarting the app.
- **Interface languages** — Simplified Chinese, Traditional Chinese, English, and Japanese.

## Why open source?

Termflow started as an application built around the workflow I wanted to use every day. As its features and experience matured, it was open-sourced to offer another choice to people selecting an AI-assisted development tool.

## Core features

| Feature | What it provides |
| :--- | :--- |
| **Session management** | The sidebar groups sessions by project directory, lets you create sessions quickly, and shows their active state in real time. |
| **Embedded terminal** | xterm.js and ConPTY provide a native-like terminal that resizes with the window and supports ANSI colours and cursor controls. |
| **Session persistence** | Sessions use `--session-id` (UUID). Their data remains after the app closes and can be continued with `--resume`. |
| **Checkpoint review** | Records agent-turn checkpoints, aligns diffs, shows file summaries and helper panels, and lets you return to any checkpoint. |
| **Quick commands** | A customizable command library with categories, search, parameterized templates, and one-click execution. |
| **Voice input** | Supports DashScope ASR, runtime provider switching, global shortcuts, and an overlay showing recording status and volume. |
| **Git workflow** | Commit, push, pull, sync, staging, diffs, branch management, and AI-generated commit messages. |
| **Attention and notifications** | Tracks session state and sends smart notifications while preserving attention data for later review. |
| **Full-text search** | Search project files using regular expressions, file-type filters, and highlighted results. |
| **Custom title bar** | Borderless window controls, drag region, fast search, project switching, and theme and language settings. |

## Technology stack

| Layer | Technology | Purpose |
| :--- | :--- | :--- |
| Framework | Tauri 2 | Cross-platform desktop application framework |
| Backend | Rust + portable-pty | PTY emulation and process management |
| Frontend | React 19 + TypeScript 5.8 | User interface |
| Terminal | xterm.js | Browser-side terminal emulator |
| State | Zustand + persist | Global state and local persistence |
| UI | Ant Design 5 | Components such as buttons, dialogs, and tags |
| Styling | TailwindCSS 3 + CSS variables | Utility styles and themes |
| Build | Vite 6 | Frontend build tooling |
| Localization | i18next | Runtime language switching |
| Editor | Monaco Editor | Code viewing and editing |
| Charts | Mermaid | Git history diagrams |
| Database | sql.js / rusqlite | Frontend and backend storage |
| Speech recognition | DashScope ASR | Speech-to-text input |
| Git | libgit2 (git2-rs) | Repository operations |
| HTTP | reqwest | Backend network requests |

## Project layout

```text
Termflow/
├── src/                 # React frontend
│   ├── components/      # Terminal, Git, settings, and review UI
│   ├── hooks/           # Voice and Git hooks
│   ├── locales/         # zh-CN, zh-TW, en-US, and ja-JP translations
│   ├── pages/           # Application pages
│   ├── store/           # Zustand state
│   └── i18n.ts          # i18next configuration
├── src-tauri/           # Rust/Tauri backend
│   ├── src/commands/    # Session, Git, voice, and agent commands
│   ├── src/database/    # SQLite layer
│   └── tauri.conf.json  # Tauri configuration
├── public/              # Static assets
├── docs/                # Design and module documentation
└── scripts/             # Build and release scripts
```

## Quick start

### Requirements

- **Operating system:** Windows 10 or 11
- **Node.js:** `v20.14.0`
- **pnpm:** `10.33.0`
- **Rust:** `1.95.0`
- **Rust toolchain:** `1.95.0-x86_64-pc-windows-msvc`
- **Visual Studio Build Tools 2022:** install **Desktop development with C++** and a Windows 10/11 SDK
- **WebView2 Runtime:** required for Tauri desktop apps on Windows
- **Claude Code:** install with `npm install -g @anthropic-ai/claude-code`

### Reproduce the development environment

Install Node.js, then pin pnpm with Corepack:

```bash
node -v   # v20.14.0
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm -v   # 10.33.0
```

Install and select the Windows MSVC Rust toolchain:

```bash
rustup toolchain install 1.95.0-x86_64-pc-windows-msvc
rustup default 1.95.0-x86_64-pc-windows-msvc
rustup override set 1.95.0-x86_64-pc-windows-msvc
rustc -V
cargo -V
```

Then clone and install the project:

```bash
git clone <your-repository-url>
cd Termflow
pnpm install
```

Verify the important versions:

```bash
node -v
pnpm -v
rustc -V
cargo -V
rustup show active-toolchain
```

The repository pins the frontend package manager through `packageManager` in `package.json`, frontend dependencies through `pnpm-lock.yaml`, and Rust dependencies through `src-tauri/Cargo.toml`.

### Run the application

Start only the frontend development server:

```bash
pnpm dev
```

It is served at `http://localhost:1420` by default.

Start the complete desktop application:

```bash
pnpm tauri dev
```

This starts the Vite development server, the Tauri Rust backend, and the Windows application window.

### Build an installer

```bash
pnpm tauri build
```

The NSIS installer is generated under `src-tauri/target/release/bundle/nsis/`.

## Configuration

### Speech recognition

Termflow supports multiple speech-recognition providers.

| Provider | Model | Notes |
| :--- | :--- | :--- |
| DashScope | `mimo-v2.5-asr` | Alibaba Cloud DashScope ASR; the default provider |
| Other | Extensible | Custom ASR providers can be added |

Relevant settings:

- `asrModel` — speech-recognition model; default: `mimo-v2.5-asr`
- `asrRuntime` — ASR runtime; can be switched dynamically
- `voiceShortcut` — voice-input shortcut; default: `Ctrl+Shift+V`
- `voiceInputTarget` — target: `system` or `terminal`

### Quick commands

The quick-command system lets you create, edit, and delete commands; group them by project or purpose; use variable substitution in templates; and run them via a shortcut or button.

### Themes

Four built-in themes are selected with the `data-theme` attribute. Theme changes update the title bar, sidebar, content area, and terminal colours together.

### Localization

The application uses i18next and supports dynamic switching between:

- Simplified Chinese (`zh-CN`, default)
- Traditional Chinese (`zh-TW`)
- English (`en-US`)
- Japanese (`ja-JP`)

## How it works

Creating a session follows this flow:

```text
New session → choose a project directory → create a UUID session record
→ invoke spawn_pty via Tauri IPC → Rust creates a ConPTY instance
→ start claude --dangerously-skip-permissions --session-id <uuid>
→ PTY output is emitted to xterm.js → user input is written back to the PTY
```

When a historical session is reopened, Termflow cleans up stale Claude processes and starts the session with `claude --dangerously-skip-permissions --resume <uuid>`.

## Acknowledgements

Termflow is built with excellent open-source projects including [Tauri](https://tauri.app/), [React](https://react.dev/), [xterm.js](https://xtermjs.org/), [Ant Design](https://ant.design/), [Zustand](https://zustand-demo.pmnd.rs/), [Vite](https://vitejs.dev/), [i18next](https://www.i18next.com/), [Monaco Editor](https://microsoft.github.io/monaco-editor/), [Mermaid](https://mermaid.js.org/), [Geist Mono](https://vercel.com/font), and [reqwest](https://github.com/seanmonstar/reqwest).

## License

This project is open source under the [MIT License](./LICENSE).
