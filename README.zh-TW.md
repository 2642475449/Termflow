# Termflow

<p align="center">
  <a href="README.md">简体中文</a> | 繁體中文 | <a href="README.en-US.md">English</a> | <a href="README.ja-JP.md">日本語</a>
</p>

<p align="center">
  <strong>面向終端機的 CLI 智慧代理工作臺</strong><br>
  本機優先 · 專案與工作階段管理 · 內嵌式終端機 · Git 工作流程 · 檢查點審閱
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tauri_2-24C8DB?style=flat-square&logo=tauri&logoColor=white" alt="Tauri 2">
  <img src="https://img.shields.io/badge/React_19-61DAFB?style=flat-square&logo=react&logoColor=white" alt="React 19">
  <img src="https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white" alt="Rust">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Windows-0078D6?style=flat-square&logo=windows&logoColor=white" alt="Windows">
  <img src="https://img.shields.io/badge/v1.8.19-blue?style=flat-square" alt="版本">
</p>

![Termflow 介面總覽](public/images/termflow-overview.png)

---

## 簡介

**Termflow** 是以 Tauri 2 建置、面向終端機 CLI 智慧代理的桌面工作臺。它將多個 CLI 智慧代理的命令列體驗整合到同一個本機圖形介面，讓專案、工作階段、終端機與 Git 工作保有相同的上下文。

核心特色：

- **多智慧代理與多工作階段**：依專案管理多個對話。
- **內嵌式終端機**：在圖形介面中保留熟悉的 CLI 工作方式。
- **語音輸入**：支援 DashScope ASR 與全域快速鍵。
- **Git 面板**：完整 Git 工作流程，以及 AI 產生的提交訊息。
- **檢查點審閱**：檢視智慧代理回合檢查點及變更差異。
- **快速命令**：自訂並一鍵執行常用操作。
- **主題與持久化**：提供明暗主題，並能在重啟後恢復歷史對話。
- **介面語言**：簡體中文、繁體中文、英文與日文。

## 為什麼開源？

Termflow 最初是為了打造符合自己日常習慣的應用程式。隨著功能與使用體驗逐漸完善，便將它開源，希望為正在挑選 AI 輔助開發工具的人提供另一種選擇。

## 核心功能

| 功能 | 說明 |
| :--- | :--- |
| **工作階段管理** | 側邊欄會依專案目錄分組工作階段；可快速建立工作階段並即時顯示活動狀態。 |
| **內嵌式終端機** | xterm.js 與 ConPTY 提供近似原生的終端機體驗，隨視窗大小調整，並支援 ANSI 色彩與游標控制。 |
| **工作階段持久化** | 透過 `--session-id`（UUID）建立工作階段；關閉後仍保留資料，並能以 `--resume` 接續對話。 |
| **檢查點審閱** | 記錄智慧代理回合檢查點，提供差異對齊、檔案摘要與輔助面板，且可回到任何檢查點。 |
| **快速命令** | 可自訂命令庫，支援分類、搜尋、參數化範本與一鍵執行。 |
| **語音輸入** | 支援 DashScope ASR、執行期間切換提供者、全域快速鍵，以及顯示錄音狀態和音量的懸浮視窗。 |
| **Git 工作流程** | 支援提交、推送、拉取、同步、暫存、差異檢視、分支管理與 AI 提交訊息。 |
| **注意力與通知** | 監控工作階段狀態並推送智慧通知，持久化記錄注意力資料以供回顧。 |
| **全文搜尋** | 在專案中全文搜尋，支援正規表示式、檔案類型篩選與結果醒目提示。 |
| **自訂標題列** | 提供無框視窗控制、拖曳區域、快速搜尋、專案切換、主題與語言設定。 |

## 技術棧

| 層級 | 技術 | 用途 |
| :--- | :--- | :--- |
| 框架 | Tauri 2 | 跨平台桌面應用程式框架 |
| 後端 | Rust + portable-pty | PTY 終端機模擬與程序管理 |
| 前端 | React 19 + TypeScript 5.8 | 使用者介面 |
| 終端機 | xterm.js | 瀏覽器端終端機模擬器 |
| 狀態管理 | Zustand + persist | 全域狀態與本機持久化 |
| UI | Ant Design 5 | 按鈕、對話方塊、標籤等元件 |
| 樣式 | TailwindCSS 3 + CSS 變數 | 原子化樣式與主題 |
| 建置 | Vite 6 | 前端建置工具 |
| 國際化 | i18next | 動態語言切換 |
| 編輯器 | Monaco Editor | 程式碼檢視與編輯 |
| 圖表 | Mermaid | Git 歷史圖表 |
| 資料庫 | sql.js / rusqlite | 前後端資料儲存 |
| 語音辨識 | DashScope ASR | 語音轉文字輸入 |
| Git | libgit2 (git2-rs) | 儲存庫操作 |
| HTTP | reqwest | 後端網路請求 |

## 快速開始

### 環境需求

- **作業系統**：Windows 10 或 11
- **Node.js**：`v20.14.0`
- **pnpm**：`10.33.0`
- **Rust**：`1.95.0`
- **Rust toolchain**：`1.95.0-x86_64-pc-windows-msvc`
- **Visual Studio Build Tools 2022**：安裝 **Desktop development with C++** 與 Windows 10/11 SDK
- **WebView2 Runtime**：Windows 上執行 Tauri 桌面應用程式所需
- **Claude Code**：以 `npm install -g @anthropic-ai/claude-code` 安裝

### 建立相同的開發環境

安裝 Node.js 後，使用 Corepack 固定 pnpm 版本：

```bash
node -v   # v20.14.0
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm -v   # 10.33.0
```

安裝並選用 Windows MSVC Rust 工具鏈：

```bash
rustup toolchain install 1.95.0-x86_64-pc-windows-msvc
rustup default 1.95.0-x86_64-pc-windows-msvc
rustup override set 1.95.0-x86_64-pc-windows-msvc
rustc -V
cargo -V
```

複製專案並安裝相依套件：

```bash
git clone <your-repository-url>
cd Termflow
pnpm install
```

驗證工具版本：

```bash
node -v
pnpm -v
rustc -V
cargo -V
rustup show active-toolchain
```

`package.json` 的 `packageManager` 固定前端套件管理器；`pnpm-lock.yaml` 固定前端相依版本；`src-tauri/Cargo.toml` 固定 Rust 相依版本。

### 執行應用程式

僅啟動前端開發伺服器：

```bash
pnpm dev
```

預設網址為 `http://localhost:1420`。

啟動完整桌面應用程式：

```bash
pnpm tauri dev
```

此命令會啟動 Vite 開發伺服器、Tauri Rust 後端與 Windows 應用程式視窗。

### 建置安裝程式

```bash
pnpm tauri build
```

NSIS 安裝程式會產生在 `src-tauri/target/release/bundle/nsis/`。

## 設定說明

### 語音辨識

| 提供者 | 模型 | 說明 |
| :--- | :--- | :--- |
| DashScope | `mimo-v2.5-asr` | 阿里雲 DashScope ASR；預設提供者 |
| 其他 | 可擴充 | 可加入自訂 ASR 提供者 |

- `asrModel`：語音辨識模型；預設為 `mimo-v2.5-asr`
- `asrRuntime`：ASR 執行環境；支援動態切換
- `voiceShortcut`：語音輸入快速鍵；預設為 `Ctrl+Shift+V`
- `voiceInputTarget`：輸入目標：`system` 或 `terminal`

### 快速命令與主題

快速命令可建立、編輯與刪除命令，依專案或用途分類，並可在範本中使用變數替換，再透過快速鍵或按鈕執行。四套內建主題由 `data-theme` 屬性切換，標題列、側邊欄、內容區與終端機配色會同步更新。

### 國際化

應用程式使用 i18next，可動態切換下列語言：

- 簡體中文（`zh-CN`，預設）
- 繁體中文（`zh-TW`）
- 英文（`en-US`）
- 日文（`ja-JP`）

## 工作原理

建立工作階段的流程：

```text
新增工作階段 → 選擇專案目錄 → 建立 UUID 工作階段記錄
→ 透過 Tauri IPC 呼叫 spawn_pty → Rust 建立 ConPTY
→ 啟動 claude --dangerously-skip-permissions --session-id <uuid>
→ PTY 輸出傳送至 xterm.js → 使用者輸入再寫回 PTY
```

重新開啟歷史工作階段時，Termflow 會清理殘留的 Claude 程序，並以 `claude --dangerously-skip-permissions --resume <uuid>` 恢復對話。

## 致謝

Termflow 使用了 [Tauri](https://tauri.app/)、[React](https://react.dev/)、[xterm.js](https://xtermjs.org/)、[Ant Design](https://ant.design/)、[Zustand](https://zustand-demo.pmnd.rs/)、[Vite](https://vitejs.dev/)、[i18next](https://www.i18next.com/)、[Monaco Editor](https://microsoft.github.io/monaco-editor/)、[Mermaid](https://mermaid.js.org/)、[Geist Mono](https://vercel.com/font) 與 [reqwest](https://github.com/seanmonstar/reqwest) 等優秀開源專案。

## 授權條款

本專案以 [MIT License](./LICENSE) 開源。
