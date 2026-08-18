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
- **檔案管理與編輯**：瀏覽專案檔案，支援 Markdown 預覽與即時編輯，也可將檔案拖放至目前 CLI 輸入欄。
- **語音輸入**：支援 MiMo 與 DashScope ASR，以及全域快速鍵。
- **Git 面板**：完整 Git 工作流程，以及 AI 產生的提交訊息。
- **檢查點審閱**：檢視智慧代理回合檢查點及變更差異。
- **快速命令**：自訂並一鍵執行常用操作。
- **工作階段持久化**：可在重啟後恢復歷史對話。

基礎體驗包含明暗與跟隨系統的主題切換，以及簡體中文、繁體中文、英文與日文介面。

## 為什麼開源？

Termflow 最初是為了打造符合自己日常習慣的應用程式。隨著功能與使用體驗逐漸完善，便將它開源，希望為正在挑選 AI 輔助開發工具的人提供另一種選擇。

## 核心功能

| 功能 | 說明 |
| :--- | :--- |
| **專案與工作階段工作區** | 依專案目錄自動整理不同智慧代理的工作階段，快速建立和切換任務，並即時掌握每個工作階段的執行狀態。<br><br>![Termflow 專案與工作階段工作區示範](public/images/demos/multi-session-management.gif) |
| **多智慧代理終端機** | 在統一工作臺中使用 Claude Code、Codex、Antigravity CLI、OpenCode 與 Qoder CLI；以 xterm.js + ConPTY 提供完整的終端機互動體驗。 |
| **檔案與上下文協作** | 瀏覽、搜尋和編輯專案檔案，預覽 Markdown，並將檔案從專案樹拖放到目前 CLI 輸入欄，快速為智慧代理補充上下文。 |
| **Git 變更工作流程** | 集中完成變更檢視、暫存、分支管理、提交、推送、拉取和同步，並可使用 AI 產生提交訊息。 |
| **檢查點與差異審閱** | 自動記錄智慧代理回合檢查點，集中檢視檔案摘要和變更差異，並可回到任何檢查點。 |
| **快速命令與語音輸入** | 透過可搜尋、可參數化的快速命令執行常用操作；支援 MiMo 與 DashScope ASR、全域快速鍵和錄音狀態懸浮視窗。 |
| **工作狀態總覽** | 彙整工作階段活動、Token 使用量和工作節奏，透過注意力中心與智慧通知提示需要處理的任務。<br><br>![Termflow 工作狀態總覽示範](public/images/demos/work-status-overview.gif) |

其他基礎能力包含工作階段持久化、自訂標題列與無框視窗控制、明暗與跟隨系統主題，以及簡體中文、繁體中文、英文與日文介面。

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
| 語音辨識 | MiMo + DashScope ASR | 語音轉文字輸入 |
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
- **至少一個受支援的 Agent CLI**：Claude Code、Codex、Antigravity CLI、OpenCode 或 Qoder CLI；依需求安裝。

### 開發須知

請依下列順序準備開發環境，以保持與目前儲存庫的工具鏈和相依套件解析結果一致。安裝 Node.js 後，使用 Corepack 固定 pnpm 版本：

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

### 從檔案總管開啟專案（Windows）

安裝 NSIS 套件後，Termflow 會為**目前 Windows 使用者**註冊「Open with Termflow」選單項目：

- 在專案資料夾上按右鍵；
- 或在資料夾空白處按右鍵，以開啟目前目錄。

Termflow 會將所選目錄作為專案根目錄開啟；若該專案已在 Termflow 中開啟，則直接聚焦既有視窗，避免重複建立視窗或工作階段。整合只寫入安裝者的使用者登錄，不需要系統管理員權限，也不會影響同一台電腦的其他使用者。解除安裝 Termflow 時，仍指向該安裝位置的選單項目會一併移除。

如需移除此整合，可在「設定 → 一般 → Windows 整合」中關閉「檔案總管右鍵選單」；Termflow 會在之後的安裝更新中保留這項偏好。

在 Windows 11 中，首版整合位於「顯示更多選項」的傳統右鍵選單內。

## 設定說明

### 語音辨識

| 提供者 | 模型 | 說明 |
| :--- | :--- | :--- |
| MiMo | `mimo-v2.5-asr` | 預設提供者；使用 MiMo API 或 Token Plan |
| DashScope | `qwen3-asr-flash` | 阿里雲百煉 DashScope ASR |

- `asrModel`：語音辨識模型；預設為 `mimo-v2.5-asr`
- 在設定頁切換 MiMo 與 DashScope 提供者；切換時會更新對應模型與驗證方式。
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

以下以 Claude Code 為例說明共用的 PTY 工作階段流程。所有 Agent 都會重用此流程，但由 Agent 介接層產生各自的原生啟動與恢復命令。

```text
新增工作階段 → 選擇專案目錄 → 建立 UUID 工作階段記錄
→ 透過 Tauri IPC 呼叫 spawn_pty → Rust 建立 ConPTY
→ 啟動所選 Agent（例如：claude [--dangerously-skip-permissions] [--effort <level>] --session-id <uuid>）
→ PTY 輸出傳送至 xterm.js → 使用者輸入再寫回 PTY
```

重新開啟歷史工作階段時，Termflow 會清理目前工作階段的殘留程序，再由 Agent 介接層產生其原生恢復命令（例如：`claude [--dangerously-skip-permissions] [--effort <level>] --resume <uuid>`）。中括號中的選項僅會在使用者選取時加入。

## 致謝

Termflow 使用了 [Tauri](https://tauri.app/)、[React](https://react.dev/)、[xterm.js](https://xtermjs.org/)、[Ant Design](https://ant.design/)、[Zustand](https://zustand-demo.pmnd.rs/)、[Vite](https://vitejs.dev/)、[i18next](https://www.i18next.com/)、[Monaco Editor](https://microsoft.github.io/monaco-editor/)、[Mermaid](https://mermaid.js.org/)、[Geist Mono](https://vercel.com/font) 與 [reqwest](https://github.com/seanmonstar/reqwest) 等優秀開源專案。

## 授權條款

本專案以 [MIT License](./LICENSE) 開源。
