# 语音识别模块

## 模块概述

语音识别模块为 Termflow 提供系统级语音输入能力。用户通过全局快捷键或界面按钮触发录音，录音完成后调用小米 MiMo ASR API 进行语音转写，识别结果通过 Windows 键盘事件模拟输入到当前聚焦窗口。整个模块采用 Worker/Overlay 双窗口架构，将语音处理逻辑与 UI 展示分离，确保录音和转录过程不受主窗口状态影响。

**相关代码位置**：
- `src/hooks/useVoiceRecognition.ts` - ASR 状态机实现
- `src/lib/mimoAsr.ts` - ASR 请求构建、响应解析
- `src/components/VoiceWorkerWindow.tsx` - 后台工作窗口
- `src/components/VoiceOverlayWindow.tsx` - 悬浮窗
- `src/components/VoiceButton.tsx` - 触发按钮
- `src-tauri/src/commands/voice.rs` - Rust 后端 ASR 转录
- `src-tauri/src/commands/voice_shortcut.rs` - 全局快捷键
- `src-tauri/src/commands/system_input.rs` - 系统级输入

## 核心机制

### 1. 语音输入目标

**机制描述**：语音识别模块支持两种输入目标（`VoiceInputTarget`）。

**输入目标类型**：
- **`system`**（默认）：识别结果通过 `send_text_to_focused_window` 命令，使用 Windows `SendInput` API 模拟 Unicode 键盘事件，将文本发送到当前前台窗口的焦点输入框。这种方式不依赖应用内部的输入框，可以向任意应用输入文本。
- **`terminal`**：识别结果发送到终端输入。

**系统级输入实现**：Rust 实现位于 `src-tauri/src/commands/system_input.rs`，通过 `Win32_UI_Input_KeyboardAndMouse` 模块的 `SendInput` 函数逐字符发送 UTF-16 编码的键盘事件。每个字符生成按下和抬起两个输入事件，使用 `KEYEVENTF_UNICODE` 标志确保支持中文等多字节字符。

**代码位置**：
- `src-tauri/src/commands/system_input.rs` - `send_text_to_focused_window` 命令实现
- `src/store/index.ts:26-29` - `VoiceInputTarget` 类型定义及默认值

### 2. 全局快捷键机制

**机制描述**：全局快捷键系统分为两层：Tauri 插件层（操作系统级）和 DOM 事件层（窗口内级）。

**Tauri 插件层**：使用 `tauri-plugin-global-shortcut` 插件注册操作系统级全局快捷键。`VoiceShortcutState` 结构体维护当前激活的快捷键状态，通过 `configure_voice_global_shortcut` 命令注册/注销快捷键。当快捷键被触发时，插件通过 `handle_voice_shortcut_event` 函数将 `press`/`release` 事件通过 Tauri 事件系统转发到前端。

**DOM 事件层**：作为全局快捷键的回退方案，`useKeyboardShortcuts` hook 监听窗口内的 `keydown`/`keyup` 事件。当全局快捷键注册失败时，启用窗口内快捷键监听（`enableVoiceShortcut` 控制）。快捷键支持"按住录音，松开结束"的交互模式。

**快捷键配置流程**：
1. 用户在设置页面录制快捷键
2. `captureShortcutFromEvent` 捕获按键组合
3. `parseShortcut` 解析为结构化数据
4. `toTauriShortcut` 转换为 Tauri 格式
5. 调用 `configure_voice_global_shortcut` 注册

快捷键必须包含至少一个修饰键（Ctrl/Alt/Shift/Cmd）。

**代码位置**：
- `src-tauri/src/commands/voice_shortcut.rs` - 全局快捷键注册、事件处理、状态管理
- `src/hooks/useKeyboardShortcuts.ts` - 窗口内快捷键监听（回退方案）
- `src/lib/shortcut.ts` - 快捷键解析、匹配、格式化工具函数
- `src/constants/shortcuts.ts` - 默认快捷键定义（`voiceInput: "Ctrl + Shift + V"`）
- `src/components/layout/AppLayout.tsx:136-265` - 快捷键配置与事件桥接

### 3. 悬浮窗（VoiceOverlayWindow）机制

**机制描述**：VoiceOverlayWindow 是一个透明、置顶、不可交互的浮层窗口，用于在录音过程中向用户展示语音状态胶囊（phase、音量电平、耗时、错误信息）。

**窗口特性**：
- 尺寸：520x88 像素，不可调整
- 装饰：无标题栏、无边框、透明背景
- 层级：始终置顶（`always_on_top`）
- 交互：忽略鼠标事件（`set_ignore_cursor_events(true)`），不参与任务栏显示
- 路由：通过 URL 参数 `?overlay=voice` 加载，App.tsx 根据此参数渲染 `VoiceOverlayWindow` 组件

**生命周期**：VoiceWorkerWindow 在录音/转录阶段（phase 非 idle 且非 done）自动调用 `ensure_voice_overlay_window` 显示悬浮窗，完成后调用 `hide_voice_overlay_window` 隐藏。窗口位置计算基于当前显示器尺寸，居中显示在屏幕底部（距底部 72px）。`VoiceOverlayState` 跟踪窗口所有者（owner_label），确保只有创建者可以隐藏窗口。

**渲染内容**：监听 `voice-overlay-state` 事件获取状态，渲染 `VoiceStatusCapsule` 组件（非交互模式），展示录音状态图标、音量电平动画（Equalizer）、耗时徽章、状态文字。

**代码位置**：
- `src/components/VoiceOverlayWindow.tsx` - 悬浮窗 React 组件
- `src-tauri/src/commands/window.rs:15-21, 176-199, 364-400` - 窗口创建、显示、隐藏的 Rust 实现
- `src-tauri/src/commands/window.rs:51-78` - `VoiceOverlayState` 所有权跟踪

### 4. 后台工作窗（VoiceWorkerWindow）机制

**机制描述**：VoiceWorkerWindow 是一个隐藏的后台窗口，承担所有语音处理的核心逻辑，包括录音、转录、快捷键事件转发、悬浮窗管理。

**窗口特性**：
- 尺寸：320x240 像素，不可调整
- 装饰：无标题栏、无边框、透明背景
- 可见性：始终隐藏（`visible: false`），不参与任务栏显示
- 路由：通过 URL 参数 `?worker=voice` 加载，App.tsx 根据此参数渲染 `VoiceWorkerWindow` 组件

**职责**：
- 实例化 `useVoiceRecognition` hook，管理完整的 ASR 生命周期
- 监听 `voice-worker-control` 事件接收控制指令（press/release/toggle/cancel）
- 监听 `voice-worker-config` 事件接收配置更新（apiKey、model、shortcut、inputTarget）
- 监听 `voice-global-shortcut-trigger` 事件转发全局快捷键触发
- 转录完成后调用 `send_text_to_focused_window` 将文本发送到前台窗口
- 将状态变化通过 `voice-worker-state` 和 `voice-overlay-state` 事件广播给主窗口和悬浮窗
- 根据 phase 状态自动控制悬浮窗的显示/隐藏

**事件通信**：Worker 窗口通过 Tauri 事件系统与主窗口通信，主窗口（AppLayout）监听 `voice-worker-state` 获取当前语音状态，监听 `voice-worker-error` 处理错误提示。

**代码位置**：
- `src/components/VoiceWorkerWindow.tsx` - 后台工作窗口 React 组件
- `src-tauri/src/commands/window.rs:201-221` - `create_voice_worker_window` Rust 实现
- `src/lib/api/index.ts:569-575` - `ensureVoiceOverlayWindow`、`hideVoiceOverlayWindow` API 封装

### 5. ASR 模型配置

**机制描述**：语音识别支持多个 ASR 提供者，包括小米 MiMo 和阿里百炼 DashScope。

#### 5.1 支持的模型

| 提供者 | 模型 | 说明 |
|--------|------|------|
| 小米 MiMo | `mimo-v2.5-asr` | 默认模型，实时语音识别 |
| 阿里百炼 | `fun-asr-flash-2026-06-15` | Fun-ASR-Flash，支持上下文增强 |
| 阿里百炼 | `qwen3-asr-flash` | Qwen3-ASR-Flash，支持流式输出 |
| 阿里百炼 | `qwen3-asr-flash-2026-02-10` | Qwen3-ASR-Flash 最新快照版 |

#### 5.2 小米 MiMo ASR

**API 配置**：
- **API 端点**：`https://api.xiaomimimo.com/v1/chat/completions`
- **默认模型**：`mimo-v2.5-asr`
- **请求格式**：使用 OpenAI 兼容的 chat completions 格式，音频数据以 `data:audio/wav;base64,...` 格式嵌入 `input_audio` 消息中，携带 `asr_options.language` 参数（默认 `zh`）

**响应解析**：支持多种响应格式的文本提取，包括：
- 直接 `text` 字段
- `choices[].message.content`（字符串或数组）
- `choices[].delta.content`
- 数组中的 `text`/`content`/`transcript` 字段

#### 5.3 阿里百炼 DashScope ASR

**API 配置**：
- **API 端点**：`https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`
- **OpenAI 兼容端点**：`https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`
- **请求格式**：使用 OpenAI 兼容的 chat completions 格式

**支持特性**：
- 上下文增强（仅 fun-asr-flash-2026-06-15）
- 自定义热词
- 说话人分离
- 敏感词过滤
- 句子/词语级时间戳
- 情感识别（Qwen3-ASR-Flash 系列）

#### 5.4 音频预处理

录音完成后，音频数据会经过以下处理：
1. 格式转换：非 WAV 格式的音频通过 Web Audio API 转换为 16kHz 采样率的单声道 16-bit PCM WAV
2. Base64 编码：转换后的音频编码为 Base64 字符串
3. 双通道请求：
   - MiMo 模型：前端优先使用 `fetch` 直接调用 API，遇到 CORS 错误时自动回退到 Rust 后端代理
   - DashScope 模型：优先使用 OpenAI 兼容接口，失败时回退到原生接口

**代码位置**：
- `src-tauri/src/commands/voice.rs` - Rust 后端 ASR 转录实现（`transcribe_audio` 命令）
- `src/lib/mimoAsr.ts` - 前端 MiMo ASR 请求构建、响应解析
- `src/lib/dashscopeAsr.ts` - 前端 DashScope ASR 请求构建、响应解析
- `src/hooks/useVoiceRecognition.ts` - 语音识别 hook，包含多提供者支持
- `src/hooks/useVoiceRecognition.ts:179-201` - `convertBlobToWav` 音频格式转换

### 6. 语音识别状态管理

**机制描述**：语音识别状态通过 Zustand store 和 React hook 两层管理。

**Zustand Store 层**：全局持久化设置存储在 `AppState` 中，包含以下语音相关字段：
- `asrApiKey: string` - ASR API 密钥
- `asrModel: string` - ASR 模型名称（默认 `mimo-v2.5-asr`）
- `voiceShortcut: string` - 语音输入快捷键（默认 `Ctrl+Shift+V`）
- `voiceInputTarget: VoiceInputTarget` - 输入目标（默认 `system`）
- `voiceTriggerVisible: boolean` - 麦克风图标是否显示（默认 `true`）

设置通过 `PersistentSettings` 持久化到 SQLite 数据库，启动时恢复。

**React Hook 层**：`useVoiceRecognition` hook 管理 ASR 生命周期状态，定义了以下阶段（`AsrPhase`）：
- `idle` - 空闲，等待触发
- `requesting_permission` - 正在请求麦克风权限
- `recording` - 录音中（250ms 采样间隔，64kbps 比特率）
- `transcribing` - 转录中
- `done` - 转录完成（2 秒后自动回到 idle）
- `error` - 发生错误（2.6 秒后自动回到 idle）

**错误码**（`AsrErrorCode`）：`permission_denied`、`no_microphone`、`no_api_key`、`not_supported`、`network`、`http_4xx`、`http_5xx`、`timeout`、`empty_audio`、`unknown`。

**代码位置**：
- `src/store/index.ts:349-354, 908-913, 1529-1534` - Store 语音状态定义、默认值、actions
- `src/store/index.ts:62-81` - ASR 模型别名映射与输入目标规范化
- `src/hooks/useVoiceRecognition.ts` - 完整的 ASR 状态机实现

## 数据流

```
用户触发（快捷键 press / 点击麦克风按钮）
    |
    v
主窗口 AppLayout
    |-- emit("voice-worker-control", { action: "press" })
    |       或 emit("voice-worker-control", { action: "toggle" })
    v
VoiceWorkerWindow（隐藏后台窗口）
    |-- useVoiceRecognition.start()
    |       |-- navigator.mediaDevices.getUserMedia() 获取麦克风
    |       |-- MediaRecorder 开始录音（250ms 采样）
    |       |-- AudioContext + AnalyserNode 分析音量电平
    |       |-- setInterval 更新 elapsedMs 和 level
    |
    |-- emit("voice-worker-state", state)  -->  主窗口监听更新 UI
    |-- emit("voice-overlay-state", state) -->  悬浮窗监听更新胶囊
    |-- ensureVoiceOverlayWindow()          -->  显示悬浮窗
    |
用户松开快捷键 / 再次点击
    |
    v
VoiceWorkerWindow
    |-- useVoiceRecognition.stop()
    |       |-- MediaRecorder.stop() -> ondataavailable -> onstop
    |       |-- Blob 音频数据
    |       |-- convertBlobToWav() 格式转换为 16kHz WAV
    |       |-- prepareAudioForAsr() 编码为 Base64
    |
    |-- 转录（双通道）
    |       |-- 优先: transcribeWithFetch() 直接调用 MiMo API
    |       |-- 回退: transcribeWithRustProxy() 通过 Rust 后端代理
    |
    |-- 转录成功
    |       |-- sendTextToFocusedWindow(text)  -->  Rust SendInput 模拟键盘输入
    |       |-- emit("voice-worker-state", { phase: "done" })
    |       |-- hideVoiceOverlayWindow()       -->  隐藏悬浮窗
    |
    |-- 转录失败
            |-- emit("voice-worker-error", error)
            |-- 主窗口监听并显示错误提示
```

## 依赖关系

### 外部依赖

| 依赖 | 用途 |
|------|------|
| `tauri-plugin-global-shortcut` (v2.3.2) | 操作系统级全局快捷键注册与监听 |
| `reqwest` (v0.12, rustls-tls) | Rust 后端 HTTP 请求（ASR API 代理） |
| `parking_lot` (v0.12) | Rust 状态管理互斥锁 |
| `windows` (v0.58) | Windows API 调用（SendInput 键盘模拟） |
| 小米 MiMo ASR API | 语音识别后端服务 |

### 内部模块依赖

| 模块 | 依赖方 |
|------|--------|
| `useVoiceRecognition` hook | VoiceWorkerWindow |
| `mimoAsr.ts` 工具库 | useVoiceRecognition hook、SettingsPanel 测试功能 |
| `shortcut.ts` 工具库 | useKeyboardShortcuts hook、SettingsPanel 快捷键录制 |
| `voice.rs` Rust 命令 | useVoiceRecognition hook（Rust 代理模式） |
| `voice_shortcut.rs` Rust 命令 | lib.rs 初始化、AppLayout 全局快捷键配置 |
| `system_input.rs` Rust 命令 | VoiceWorkerWindow（转录结果输入） |
| `window.rs` Rust 命令 | VoiceWorkerWindow（悬浮窗管理）、lib.rs 启动初始化 |
| `VoiceStatusCapsule` 组件 | VoiceOverlayWindow（悬浮窗渲染）、VoiceButton（触发按钮） |
| `AppLayout` 组件 | 快捷键桥接、配置同步、状态监听、VoiceTrigger 渲染 |
| `SettingsPanel` VoiceRecognitionPage | ASR API 配置、快捷键录制、连接测试 |
