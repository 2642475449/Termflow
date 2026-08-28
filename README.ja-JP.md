<h1 align="center">
  <img src="public/logo.png" width="56" alt="Termflow Logo" align="absmiddle">
  Termflow
</h1>

<p align="center">
  <a href="README.md">简体中文</a> | <a href="README.zh-TW.md">繁體中文</a> | <a href="README.en-US.md">English</a> | 日本語
</p>

<p align="center">
  <strong>ターミナル向け CLI エージェント・ワークスペース</strong><br>
  ローカルファースト · プロジェクトとセッションの管理 · 組み込みターミナル · Git ワークフロー · チェックポイントレビュー
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tauri_2-24C8DB?style=flat-square&logo=tauri&logoColor=white" alt="Tauri 2">
  <img src="https://img.shields.io/badge/React_19-61DAFB?style=flat-square&logo=react&logoColor=white" alt="React 19">
  <img src="https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white" alt="Rust">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Windows-0078D6?style=flat-square&logo=windows&logoColor=white" alt="Windows">
  <img src="https://img.shields.io/badge/v1.8.22-blue?style=flat-square" alt="バージョン">
</p>

![Termflow の概要](.github/assets/termflow-overview.png)

## 対応エージェント

Termflow は次の CLI エージェントをネイティブにサポートします。

<p align="center">
  <code><img src="public/agents/claude.svg" width="16" alt="" align="absmiddle"> Claude Code</code>
  <code><img src="public/agents/codex.svg" width="16" alt="" align="absmiddle"> Codex</code>
  <code><img src="public/agents/antigravity.svg" width="16" alt="" align="absmiddle"> Antigravity CLI</code>
  <code><img src="public/agents/opencode.svg" width="16" alt="" align="absmiddle"> OpenCode</code>
  <code><img src="public/agents/qoder.svg" width="16" alt="" align="absmiddle"> Qoder CLI</code>
</p>

---

## 概要

**Termflow** は、Tauri 2 で構築されたターミナル向け CLI エージェントのデスクトップワークスペースです。複数の CLI エージェントのコマンドライン体験を一つのローカル GUI にまとめ、プロジェクト、セッション、ターミナル、Git 作業を同じコンテキストで扱えます。

主な特長：

- **複数エージェント・複数セッション**：プロジェクトごとに複数の会話を整理します。
- **組み込みターミナル**：使い慣れた CLI ワークフローを GUI 内でも維持します。
- **ファイル管理と編集**：プロジェクトファイルを閲覧し、Markdown をプレビュー・その場で編集できます。ファイルをアクティブな CLI 入力欄へドラッグ＆ドロップすることもできます。
- **音声入力**：MiMo と DashScope ASR、グローバルショートカットをサポートします。
- **Git パネル**：完全な Git ワークフローと AI によるコミットメッセージ生成を提供します。
- **チェックポイントレビュー**：エージェントのターンごとのチェックポイントと変更差分を確認できます。
- **クイックコマンド**：よく使う操作を登録し、ワンクリックで実行できます。
- **セッション永続化**：再起動後も過去の会話を復元できます。

基本機能として、明暗・システム連動テーマと、簡体字中国語、繁体字中国語、英語、日本語の UI を提供します。

## オープンソースにした理由

Termflow は、日常的に使いたいワークフローに合わせて作り始めたアプリケーションです。機能と使い心地が整ってきたため、AI 支援開発ツールを選ぶ人に別の選択肢を届けるべくオープンソース化しました。

## コア機能

| 機能 | 内容 |
| :--- | :--- |
| **プロジェクトとセッションのワークスペース** | プロジェクトディレクトリごとに各エージェントのセッションを自動整理し、タスクを素早く作成・切替しながら、各セッションの稼働状態をリアルタイムで確認できます。<br><br><img src=".github/assets/demos/multi-session-management.gif" alt="Termflow プロジェクトとセッションのワークスペースデモ" width="480"> |
| **サイドタスクと補助ワークスペース** | ターミナルのエラーやファイルの問題が発生したとき、選択したターミナル出力からサイド質問を開始し、メインセッションを離れずに右側で関連ファイルの確認や独立したタスクの実行ができます。 |
| **ファイルとコンテキストの連携** | プロジェクトファイルの閲覧・検索・編集、Markdown のプレビュー、CLI 入力欄へのファイルのドラッグ＆ドロップにより、エージェントへ素早くコンテキストを渡せます。<br><br><img src=".github/assets/demos/file-context-collaboration.gif" alt="Termflow ファイルとコンテキストの連携デモ" width="480"> |
| **Git 変更ワークフロー** | 変更確認、ステージング、ブランチ管理、コミット、プッシュ、プル、同期を一か所で行い、AI によるコミットメッセージ生成も利用できます。 |
| **チェックポイントと差分レビュー** | エージェントターンのチェックポイントを自動記録し、ファイル概要と変更差分を確認して、任意のチェックポイントへ戻れます。 |
| **クイックコマンドと音声入力** | 検索可能でパラメータ化されたクイックコマンドから定型操作を実行できます。MiMo と DashScope ASR、グローバルショートカット、録音状態オーバーレイにも対応します。 |
| **作業状況の概要** | セッション活動、Token 使用量、作業ペースを集約し、アテンションセンターとスマート通知で対応が必要なタスクを示します。<br><br><img src=".github/assets/demos/work-status-overview.gif" alt="Termflow 作業状況の概要デモ" width="480"> |

そのほか、セッションの永続化、カスタムタイトルバーとフレームレスウィンドウ操作、明暗・システム連動テーマ、簡体字中国語・繁体字中国語・英語・日本語の UI を提供します。

## 技術スタック

| レイヤー | 技術 | 用途 |
| :--- | :--- | :--- |
| フレームワーク | Tauri 2 | クロスプラットフォームのデスクトップアプリケーションフレームワーク |
| バックエンド | Rust + portable-pty | PTY 端末エミュレーションとプロセス管理 |
| フロントエンド | React 19 + TypeScript 5.8 | ユーザーインターフェース |
| ターミナル | xterm.js | ブラウザー側ターミナルエミュレーター |
| 状態管理 | Zustand + persist | グローバル状態とローカル永続化 |
| UI | Ant Design 5 | ボタン、ダイアログ、タグなどのコンポーネント |
| スタイル | TailwindCSS 3 + CSS 変数 | ユーティリティスタイルとテーマ |
| ビルド | Vite 6 | フロントエンドのビルドツール |
| 国際化 | i18next | 実行時の言語切替 |
| エディター | Monaco Editor | コードの閲覧と編集 |
| 図表 | Mermaid | Git 履歴図 |
| データベース | sql.js / rusqlite | フロントエンドとバックエンドのデータ保存 |
| 音声認識 | MiMo + DashScope ASR | 音声からテキストへの入力 |
| Git | libgit2 (git2-rs) | リポジトリ操作 |
| HTTP | reqwest | バックエンドのネットワーク要求 |

## 謝辞

Termflow は [Tauri](https://tauri.app/)、[React](https://react.dev/)、[xterm.js](https://xtermjs.org/)、[Ant Design](https://ant.design/)、[Zustand](https://zustand-demo.pmnd.rs/)、[Vite](https://vitejs.dev/)、[i18next](https://www.i18next.com/)、[Monaco Editor](https://microsoft.github.io/monaco-editor/)、[Mermaid](https://mermaid.js.org/)、[Geist Mono](https://vercel.com/font)、[reqwest](https://github.com/seanmonstar/reqwest) などの優れたオープンソースプロジェクトを利用しています。

## ライセンス

このプロジェクトは [MIT License](./LICENSE) の下で公開されています。
