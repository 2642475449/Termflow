<h1 align="center">
  <img src="public/logo.png" width="56" alt="Termflow Logo" align="absmiddle">
  Termflow
</h1>

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
  <img src="https://img.shields.io/badge/v1.8.20-blue?style=flat-square" alt="Version">
</p>

![Termflow overview](public/images/termflow-overview.png)

## Supported agents

Termflow natively supports the following CLI agents:

<p align="center">
  <code><img src="public/agents/claude.svg" width="16" alt="" align="absmiddle"> Claude Code</code>
  <code><img src="public/agents/codex.svg" width="16" alt="" align="absmiddle"> Codex</code>
  <code><img src="public/agents/antigravity.svg" width="16" alt="" align="absmiddle"> Antigravity CLI</code>
  <code><img src="public/agents/opencode.svg" width="16" alt="" align="absmiddle"> OpenCode</code>
  <code><img src="public/agents/qoder.svg" width="16" alt="" align="absmiddle"> Qoder CLI</code>
</p>

---

## Overview

**Termflow** is a Tauri 2 desktop workspace for terminal-based CLI agents. It brings the command-line experience of multiple agents into one local graphical application, keeping projects, sessions, terminals, and Git work in the same context.

Key capabilities:

- **Multiple agents and sessions** — organize several conversations for each project.
- **Embedded terminal** — keep a familiar CLI workflow inside the application.
- **File management and editing** — browse project files, preview and edit Markdown in place, and drag files into the active CLI input.
- **Voice input** — MiMo and DashScope ASR with a global shortcut.
- **Git panel** — a complete Git workflow plus AI-generated commit messages.
- **Checkpoint review** — inspect agent-turn checkpoints and compare changes.
- **Quick commands** — define and run common actions with one click.
- **Persistent sessions** — reopen historical conversations after restarting the app.

The baseline experience also includes dark, light, and system-following themes, plus Simplified Chinese, Traditional Chinese, English, and Japanese interfaces.

## Why open source?

Termflow started as an application built around the workflow I wanted to use every day. As its features and experience matured, it was open-sourced to offer another choice to people selecting an AI-assisted development tool.

## Core features

| Feature | What it provides |
| :--- | :--- |
| **Project and session workspace** | Automatically organize sessions from different agents by project directory, create and switch tasks quickly, and see the live state of every session.<br><br>![Termflow project and session workspace demo](public/images/demos/multi-session-management.gif) |
| **Multi-agent terminal** | Use Claude Code, Codex, Antigravity CLI, OpenCode, and Qoder CLI in one workspace, with full terminal interaction powered by xterm.js and ConPTY. |
| **File and context collaboration** | Browse, search, and edit project files, preview Markdown, and drag files from the project tree into the active CLI input to give an agent context quickly. |
| **Git change workflow** | Review and stage changes, manage branches, commit, push, pull, and sync from one place, with optional AI-generated commit messages. |
| **Checkpoint and diff review** | Record checkpoints for agent turns automatically, review file summaries and diffs, and return to any checkpoint. |
| **Quick commands and voice input** | Run common actions through searchable, parameterized quick commands; use MiMo or DashScope ASR with a global shortcut and recording-status overlay. |
| **Work status overview** | Summarize session activity, token usage, and work patterns, while the attention center and smart notifications highlight tasks that need action.<br><br>![Termflow work status overview demo](public/images/demos/work-status-overview.gif) |

Additional capabilities include persistent sessions, a custom title bar and borderless window controls, dark/light/system themes, and Simplified Chinese, Traditional Chinese, English, and Japanese interfaces.

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
| Speech recognition | MiMo + DashScope ASR | Speech-to-text input |
| Git | libgit2 (git2-rs) | Repository operations |
| HTTP | reqwest | Backend network requests |

## Quick start

### Requirements

- **Operating system:** Windows 10 or 11
- **Node.js:** `v20.14.0`
- **pnpm:** `10.33.0`
- **Rust:** `1.95.0`
- **Rust toolchain:** `1.95.0-x86_64-pc-windows-msvc`
- **Visual Studio Build Tools 2022:** install **Desktop development with C++** and a Windows 10/11 SDK
- **WebView2 Runtime:** required for Tauri desktop apps on Windows
- **At least one supported agent CLI:** Claude Code, Codex, Antigravity CLI, OpenCode, or Qoder CLI; install the one you plan to use.

### Development notes

Prepare the development environment in the following order to match this repository's toolchain and dependency resolution. Install Node.js, then pin pnpm with Corepack:

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

### Open a project from Explorer (Windows)

After installing the NSIS package, Termflow registers an **Open with Termflow** entry for the current Windows user:

- right-click a project folder, or
- right-click an empty area inside a folder to open that directory.

Termflow uses the selected directory as the project root. If that project is already open, it focuses the existing window instead of creating a duplicate window or session. The integration is registered only for the installing user, requires no administrator privileges, and does not affect other users on the same computer. Uninstalling Termflow removes entries that still point to that installation.

You can turn the integration off in **Settings → General → Windows integration**. Termflow preserves that preference across later installer updates.

On Windows 11, this first version is available from the classic **Show more options** menu.

## Configuration

### Speech recognition

Termflow supports multiple speech-recognition providers.

| Provider | Model | Notes |
| :--- | :--- | :--- |
| MiMo | `mimo-v2.5-asr` | Default provider; uses the MiMo API or Token Plan |
| DashScope | `qwen3-asr-flash` | Alibaba Cloud Bailian DashScope ASR |

Relevant settings:

- `asrModel` — speech-recognition model; default: `mimo-v2.5-asr`
- Switch providers in Settings; this updates the corresponding model and authentication method.
- `voiceShortcut` — voice-input shortcut; default: `Ctrl+Shift+V`
- `voiceInputTarget` — target: `system` or `terminal`

### Quick commands

The quick-command system lets you create, edit, and delete commands; group them by project or purpose; use variable substitution in templates; and run them via a shortcut or button.

## How it works

The following is the shared PTY session flow, using Claude Code as an example. Every agent reuses this flow, while the agent adapter generates its own native start and resume commands.

```text
New session → choose a project directory → create a UUID session record
→ invoke spawn_pty via Tauri IPC → Rust creates a ConPTY instance
→ start the selected agent (for example, `claude [--dangerously-skip-permissions] [--effort <level>] --session-id <uuid>`)
→ PTY output is emitted to xterm.js → user input is written back to the PTY
```

When a historical session is reopened, Termflow cleans up the current session's residual process, then the agent adapter generates its native resume command (for example, `claude [--dangerously-skip-permissions] [--effort <level>] --resume <uuid>`). Bracketed options are only included when selected.

## Acknowledgements

Termflow is built with excellent open-source projects including [Tauri](https://tauri.app/), [React](https://react.dev/), [xterm.js](https://xtermjs.org/), [Ant Design](https://ant.design/), [Zustand](https://zustand-demo.pmnd.rs/), [Vite](https://vitejs.dev/), [i18next](https://www.i18next.com/), [Monaco Editor](https://microsoft.github.io/monaco-editor/), [Mermaid](https://mermaid.js.org/), [Geist Mono](https://vercel.com/font), and [reqwest](https://github.com/seanmonstar/reqwest).

## License

This project is open source under the [MIT License](./LICENSE).
