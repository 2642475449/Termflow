# Termflow

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
  <img src="https://img.shields.io/badge/v1.8.19-blue?style=flat-square" alt="バージョン">
</p>

![Termflow の概要](public/images/termflow-overview.png)

---

## 概要

**Termflow** は、Tauri 2 で構築されたターミナル向け CLI エージェントのデスクトップワークスペースです。複数の CLI エージェントのコマンドライン体験を一つのローカル GUI にまとめ、プロジェクト、セッション、ターミナル、Git 作業を同じコンテキストで扱えます。

主な特長：

- **複数エージェント・複数セッション**：プロジェクトごとに複数の会話を整理します。
- **組み込みターミナル**：使い慣れた CLI ワークフローを GUI 内でも維持します。
- **音声入力**：DashScope ASR とグローバルショートカットをサポートします。
- **Git パネル**：完全な Git ワークフローと AI によるコミットメッセージ生成を提供します。
- **チェックポイントレビュー**：エージェントのターンごとのチェックポイントと変更差分を確認できます。
- **クイックコマンド**：よく使う操作を登録し、ワンクリックで実行できます。
- **テーマと永続化**：明暗テーマを用意し、再起動後も過去の会話を復元できます。
- **UI 言語**：簡体字中国語、繁体字中国語、英語、日本語を利用できます。

## オープンソースにした理由

Termflow は、日常的に使いたいワークフローに合わせて作り始めたアプリケーションです。機能と使い心地が整ってきたため、AI 支援開発ツールを選ぶ人に別の選択肢を届けるべくオープンソース化しました。

## コア機能

| 機能 | 内容 |
| :--- | :--- |
| **セッション管理** | サイドバーでセッションをプロジェクトディレクトリごとに整理し、素早く作成できます。稼働状態もリアルタイムで表示します。 |
| **組み込みターミナル** | xterm.js と ConPTY により、ウィンドウサイズに追従し ANSI カラーとカーソル制御に対応したネイティブに近い端末を提供します。 |
| **セッション永続化** | `--session-id`（UUID）でセッションを作成します。終了後もデータを保持し、`--resume` で会話を再開できます。 |
| **チェックポイントレビュー** | エージェントターンのチェックポイントを記録し、差分整列、ファイル概要、補助パネルを表示します。任意のチェックポイントへ戻ることもできます。 |
| **クイックコマンド** | カスタマイズ可能なコマンドライブラリです。分類、検索、パラメータ化テンプレート、ワンクリック実行に対応します。 |
| **音声入力** | DashScope ASR、実行中のプロバイダー切替、グローバルショートカット、録音状態と音量を示すオーバーレイをサポートします。 |
| **Git ワークフロー** | コミット、プッシュ、プル、同期、ステージング、差分確認、ブランチ管理、AI コミットメッセージを扱えます。 |
| **注意と通知** | セッション状態を監視してスマート通知を送り、注意に関するデータを保存して後から振り返れます。 |
| **全文検索** | 正規表現、ファイル種別フィルター、結果ハイライトを使ってプロジェクト全体を検索します。 |
| **カスタムタイトルバー** | フレームレスウィンドウ操作、ドラッグ領域、クイック検索、プロジェクト切替、テーマと言語設定を提供します。 |

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
| 音声認識 | DashScope ASR | 音声からテキストへの入力 |
| Git | libgit2 (git2-rs) | リポジトリ操作 |
| HTTP | reqwest | バックエンドのネットワーク要求 |

## クイックスタート

### 必要な環境

- **OS**：Windows 10 または 11
- **Node.js**：`v20.14.0`
- **pnpm**：`10.33.0`
- **Rust**：`1.95.0`
- **Rust toolchain**：`1.95.0-x86_64-pc-windows-msvc`
- **Visual Studio Build Tools 2022**：**Desktop development with C++** と Windows 10/11 SDK をインストール
- **WebView2 Runtime**：Windows 上で Tauri デスクトップアプリを動かすために必要
- **Claude Code**：`npm install -g @anthropic-ai/claude-code` でインストール

### 開発環境を再現する

Node.js のインストール後、Corepack で pnpm のバージョンを固定します。

```bash
node -v   # v20.14.0
corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm -v   # 10.33.0
```

Windows MSVC 向け Rust ツールチェーンをインストールして選択します。

```bash
rustup toolchain install 1.95.0-x86_64-pc-windows-msvc
rustup default 1.95.0-x86_64-pc-windows-msvc
rustup override set 1.95.0-x86_64-pc-windows-msvc
rustc -V
cargo -V
```

次にプロジェクトを取得し、依存関係をインストールします。

```bash
git clone <your-repository-url>
cd Termflow
pnpm install
```

ツールのバージョンを確認します。

```bash
node -v
pnpm -v
rustc -V
cargo -V
rustup show active-toolchain
```

`package.json` の `packageManager` はフロントエンドのパッケージマネージャーを、`pnpm-lock.yaml` はフロントエンド依存関係を、`src-tauri/Cargo.toml` は Rust 依存関係を固定します。

### アプリケーションを実行する

フロントエンド開発サーバーだけを起動する場合：

```bash
pnpm dev
```

既定では `http://localhost:1420` で提供されます。

完全なデスクトップアプリケーションを起動する場合：

```bash
pnpm tauri dev
```

このコマンドは Vite 開発サーバー、Tauri Rust バックエンド、Windows アプリケーションウィンドウを起動します。

### インストーラーをビルドする

```bash
pnpm tauri build
```

NSIS インストーラーは `src-tauri/target/release/bundle/nsis/` に生成されます。

## 設定

### 音声認識

| プロバイダー | モデル | 説明 |
| :--- | :--- | :--- |
| DashScope | `mimo-v2.5-asr` | Alibaba Cloud DashScope ASR。既定のプロバイダー |
| その他 | 拡張可能 | カスタム ASR プロバイダーを追加可能 |

- `asrModel`：音声認識モデル。既定値は `mimo-v2.5-asr`
- `asrRuntime`：ASR ランタイム。動的に切り替え可能
- `voiceShortcut`：音声入力ショートカット。既定値は `Ctrl+Shift+V`
- `voiceInputTarget`：入力先。`system` または `terminal`

### クイックコマンドとテーマ

クイックコマンドでは、コマンドの作成、編集、削除、プロジェクトや用途ごとの分類、テンプレート内の変数置換、ショートカットまたはボタンからの実行ができます。4 種類の組み込みテーマは `data-theme` 属性で切り替え、タイトルバー、サイドバー、コンテンツ領域、ターミナルの配色をまとめて更新します。

### 国際化

アプリケーションは i18next を使用し、次の言語を動的に切り替えられます。

- 簡体字中国語（`zh-CN`、既定）
- 繁体字中国語（`zh-TW`）
- 英語（`en-US`）
- 日本語（`ja-JP`）

## 仕組み

セッション作成時の処理フロー：

```text
新規セッション → プロジェクトディレクトリを選択 → UUID のセッション記録を作成
→ Tauri IPC 経由で spawn_pty を呼び出す → Rust が ConPTY を作成
→ claude --dangerously-skip-permissions --session-id <uuid> を起動
→ PTY 出力を xterm.js に送る → ユーザー入力を PTY に書き戻す
```

履歴セッションを開き直すと、Termflow は残っている Claude プロセスをクリーンアップし、`claude --dangerously-skip-permissions --resume <uuid>` で会話を復元します。

## 謝辞

Termflow は [Tauri](https://tauri.app/)、[React](https://react.dev/)、[xterm.js](https://xtermjs.org/)、[Ant Design](https://ant.design/)、[Zustand](https://zustand-demo.pmnd.rs/)、[Vite](https://vitejs.dev/)、[i18next](https://www.i18next.com/)、[Monaco Editor](https://microsoft.github.io/monaco-editor/)、[Mermaid](https://mermaid.js.org/)、[Geist Mono](https://vercel.com/font)、[reqwest](https://github.com/seanmonstar/reqwest) などの優れたオープンソースプロジェクトを利用しています。

## ライセンス

このプロジェクトは [MIT License](./LICENSE) の下で公開されています。
