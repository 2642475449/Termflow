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
| **プロジェクトとセッションのワークスペース** | プロジェクトディレクトリごとに各エージェントのセッションを自動整理し、タスクを素早く作成・切替しながら、各セッションの稼働状態をリアルタイムで確認できます。<br><br>![Termflow プロジェクトとセッションのワークスペースデモ](public/images/demos/multi-session-management.gif) |
| **マルチエージェント・ターミナル** | Claude Code、Codex、Antigravity CLI、OpenCode、Qoder CLI を一つのワークスペースで利用し、xterm.js + ConPTY による完全なターミナル操作を行えます。 |
| **ファイルとコンテキストの連携** | プロジェクトファイルの閲覧・検索・編集、Markdown のプレビュー、CLI 入力欄へのファイルのドラッグ＆ドロップにより、エージェントへ素早くコンテキストを渡せます。 |
| **Git 変更ワークフロー** | 変更確認、ステージング、ブランチ管理、コミット、プッシュ、プル、同期を一か所で行い、AI によるコミットメッセージ生成も利用できます。 |
| **チェックポイントと差分レビュー** | エージェントターンのチェックポイントを自動記録し、ファイル概要と変更差分を確認して、任意のチェックポイントへ戻れます。 |
| **クイックコマンドと音声入力** | 検索可能でパラメータ化されたクイックコマンドから定型操作を実行できます。MiMo と DashScope ASR、グローバルショートカット、録音状態オーバーレイにも対応します。 |
| **作業状況の概要** | セッション活動、Token 使用量、作業ペースを集約し、アテンションセンターとスマート通知で対応が必要なタスクを示します。<br><br>![Termflow 作業状況の概要デモ](public/images/demos/work-status-overview.gif) |

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

## クイックスタート

### 必要な環境

- **OS**：Windows 10 または 11
- **Node.js**：`v20.14.0`
- **pnpm**：`10.33.0`
- **Rust**：`1.95.0`
- **Rust toolchain**：`1.95.0-x86_64-pc-windows-msvc`
- **Visual Studio Build Tools 2022**：**Desktop development with C++** と Windows 10/11 SDK をインストール
- **WebView2 Runtime**：Windows 上で Tauri デスクトップアプリを動かすために必要
- **対応 Agent CLI を少なくとも一つ**：Claude Code、Codex、Antigravity CLI、OpenCode、Qoder CLI のうち、使用するものをインストール

### 開発時の注意事項

このリポジトリのツールチェーンと依存関係の解決結果に合わせるため、次の順序で開発環境を準備します。Node.js のインストール後、Corepack で pnpm のバージョンを固定します。

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

### エクスプローラーからプロジェクトを開く（Windows）

NSIS パッケージをインストールすると、Termflow は**現在の Windows ユーザー**向けに「Open with Termflow」メニューを登録します。

- プロジェクトフォルダーを右クリックする。
- またはフォルダー内の空白部分を右クリックして、そのディレクトリを開く。

選択したディレクトリがプロジェクトルートになります。同じプロジェクトがすでに開かれている場合は、重複したウィンドウやセッションを作らず既存のウィンドウにフォーカスします。この統合はインストールしたユーザーのレジストリにのみ登録され、管理者権限は不要で、同じ PC の他のユーザーには影響しません。Termflow をアンインストールすると、当該インストール先を指しているメニュー項目を削除します。

この連携は「設定 → 一般 → Windows 連携」の「エクスプローラーの右クリックメニュー」から無効にでき、以後のインストーラー更新でも設定が維持されます。

Windows 11 では、この初版の統合は従来の「その他のオプションを表示」メニューにあります。

## 設定

### 音声認識

| プロバイダー | モデル | 説明 |
| :--- | :--- | :--- |
| MiMo | `mimo-v2.5-asr` | 既定のプロバイダー。MiMo API または Token Plan を使用 |
| DashScope | `qwen3-asr-flash` | Alibaba Cloud Bailian DashScope ASR |

- `asrModel`：音声認識モデル。既定値は `mimo-v2.5-asr`
- 設定画面で MiMo と DashScope を切り替えます。切替時に対応するモデルと認証方式が更新されます。
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

以下は Claude Code を例にした共通 PTY セッションフローです。すべての Agent がこのフローを共有し、Agent アダプターが各 Agent 固有の起動・再開コマンドを生成します。

```text
新規セッション → プロジェクトディレクトリを選択 → UUID のセッション記録を作成
→ Tauri IPC 経由で spawn_pty を呼び出す → Rust が ConPTY を作成
→ 選択した Agent を起動（例：claude [--dangerously-skip-permissions] [--effort <level>] --session-id <uuid>）
→ PTY 出力を xterm.js に送る → ユーザー入力を PTY に書き戻す
```

履歴セッションを開き直すと、Termflow は現在のセッションに残ったプロセスをクリーンアップし、Agent アダプターが各 Agent 固有の再開コマンドを生成します（例：`claude [--dangerously-skip-permissions] [--effort <level>] --resume <uuid>`）。角括弧内のオプションは、選択された場合にのみ追加されます。

## 謝辞

Termflow は [Tauri](https://tauri.app/)、[React](https://react.dev/)、[xterm.js](https://xtermjs.org/)、[Ant Design](https://ant.design/)、[Zustand](https://zustand-demo.pmnd.rs/)、[Vite](https://vitejs.dev/)、[i18next](https://www.i18next.com/)、[Monaco Editor](https://microsoft.github.io/monaco-editor/)、[Mermaid](https://mermaid.js.org/)、[Geist Mono](https://vercel.com/font)、[reqwest](https://github.com/seanmonstar/reqwest) などの優れたオープンソースプロジェクトを利用しています。

## ライセンス

このプロジェクトは [MIT License](./LICENSE) の下で公開されています。
