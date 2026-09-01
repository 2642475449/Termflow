<h1 align="center">
  <img src="public/logo.png" width="56" alt="Termflow Logo" align="absmiddle">
  Termflow
</h1>

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
  <img src="https://img.shields.io/badge/v1.8.22-blue?style=flat-square" alt="版本">
</p>

![Termflow 介面總覽](.github/assets/termflow-overview.png)

## 支援的智慧代理

Termflow 原生支援以下 CLI 智慧代理：

<p align="center">
  <code><img src="public/agents/claude.svg" width="16" alt="" align="absmiddle"> Claude Code</code>
  <code><img src="public/agents/codex.svg" width="16" alt="" align="absmiddle"> Codex</code>
  <code><img src="public/agents/antigravity.svg" width="16" alt="" align="absmiddle"> Antigravity CLI</code>
  <code><img src="public/agents/opencode.svg" width="16" alt="" align="absmiddle"> OpenCode</code>
  <code><img src="public/agents/qoder.svg" width="16" alt="" align="absmiddle"> Qoder CLI</code>
  <code><img src="public/agents/pi.svg" width="16" alt="" align="absmiddle"> Pi</code>
</p>

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
| **專案與工作階段工作區** | 依專案目錄自動整理不同智慧代理的工作階段，快速建立和切換任務，並即時掌握每個工作階段的執行狀態。<br><br><img src=".github/assets/demos/multi-session-management.gif" alt="Termflow 專案與工作階段工作區示範" width="480"> |
| **旁路任務與輔助工作區** | 遇到終端機錯誤或檔案問題時，可從選取的終端機輸出發起側邊提問，並在不離開主要工作階段的情況下，於右側檢視相關檔案或執行獨立任務。 |
| **檔案與上下文協作** | 瀏覽、搜尋和編輯專案檔案，預覽 Markdown，並將檔案從專案樹拖放到目前 CLI 輸入欄，快速為智慧代理補充上下文。<br><br><img src=".github/assets/demos/file-context-collaboration.gif" alt="Termflow 檔案與上下文協作示範" width="480"> |
| **Git 變更工作流程** | 集中完成變更檢視、暫存、分支管理、提交、推送、拉取和同步，並可使用 AI 產生提交訊息。 |
| **檢查點與差異審閱** | 自動記錄智慧代理回合檢查點，集中檢視檔案摘要和變更差異，並可回到任何檢查點。 |
| **快速命令與語音輸入** | 透過可搜尋、可參數化的快速命令執行常用操作；支援 MiMo 與 DashScope ASR、全域快速鍵和錄音狀態懸浮視窗。 |
| **工作狀態總覽** | 彙整工作階段活動、Token 使用量和工作節奏，透過注意力中心與智慧通知提示需要處理的任務。<br><br><img src=".github/assets/demos/work-status-overview.gif" alt="Termflow 工作狀態總覽示範" width="480"> |

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

## 致謝

Termflow 使用了 [Tauri](https://tauri.app/)、[React](https://react.dev/)、[xterm.js](https://xtermjs.org/)、[Ant Design](https://ant.design/)、[Zustand](https://zustand-demo.pmnd.rs/)、[Vite](https://vitejs.dev/)、[i18next](https://www.i18next.com/)、[Monaco Editor](https://microsoft.github.io/monaco-editor/)、[Mermaid](https://mermaid.js.org/)、[Geist Mono](https://vercel.com/font) 與 [reqwest](https://github.com/seanmonstar/reqwest) 等優秀開源專案。

## 授權條款

本專案以 [MIT License](./LICENSE) 開源。
