# 窗口管理模块

## 模块概述

窗口管理模块负责应用窗口的创建、销毁、切换和多窗口架构。它管理主窗口、项目窗口、语音悬浮窗等不同类型的窗口。

**相关代码位置**：
- `src-tauri/src/commands/window.rs` - Rust 端窗口管理
- `src/components/layout/AppLayout.tsx` - 前端窗口布局
- `src/store/index.ts` - 窗口状态管理

## 核心机制

### 1. 窗口类型

系统支持以下窗口类型：

| 窗口类型 | 标签 | 用途 |
|---------|------|------|
| 主窗口 | `main` | 应用启动时的默认窗口，Launcher 模式 |
| 项目窗口 | `project:{hash}` | 打开项目时创建的窗口 |
| 语音悬浮窗 | `voice-overlay` | 语音输入时显示的悬浮窗 |
| 语音工作窗 | `voice-worker` | 语音识别后台处理窗口 |

**代码位置**：`src-tauri/src/commands/window.rs:15-18`

```rust
const VOICE_OVERLAY_LABEL: &str = "voice-overlay";
const VOICE_WORKER_LABEL: &str = "voice-worker";
```

### 2. 窗口模式

窗口有两种模式：

- **Launcher 模式**：未打开项目的空窗口，显示主页
- **Project 模式**：已打开项目的窗口，显示项目内容

**代码位置**：`src-tauri/src/commands/window.rs:23-28`

```rust
pub enum WindowMode {
    Launcher,
    Project,
}
```

### 3. 窗口注册表

`WindowRegistry` 管理所有窗口的上下文信息：

- `contexts_by_label` - 窗口标签到上下文的映射
- `project_to_label` - 项目路径到窗口标签的映射

**代码位置**：`src-tauri/src/commands/window.rs:46-49`

```rust
pub struct WindowRegistry {
    contexts_by_label: Mutex<HashMap<String, WindowProjectContext>>,
    project_to_label: Mutex<HashMap<String, String>>,
}
```

### 4. 启动时自动恢复项目

**机制描述**：应用启动时，如果设置了 `startupRestoreLastProject`，会自动恢复上次关闭的项目。

**工作原理**：

1. 应用启动，创建主窗口（Launcher 模式）
2. 前端 `AppLayout` 挂载后触发 `useEffect`
3. 检查条件：
   - 窗口模式为 Launcher
   - 窗口标签为 main
   - 设置 `startupRestoreLastProject` 为 true
   - 存在上次项目 (`lastProject.path`)
4. 调用 `openProjectWindow` 打开项目

**代码位置**：`src/components/layout/AppLayout.tsx:310-331`

```typescript
useEffect(() => {
  const state = useAppStore.getState();
  if (
    state.windowMode === "launcher" &&
    state.windowLabel === "main" &&
    state.startupRestoreLastProject &&
    state.lastProject?.path &&
    !state.currentProject
  ) {
    const timer = setTimeout(() => {
      const currentState = useAppStore.getState();
      if (currentState.windowMode === "launcher" && !currentState.currentProject) {
        openProjectWindow(currentState.lastProject!.path, true).catch(console.error);
      }
    }, 100);
    return () => clearTimeout(timer);
  }
}, []);
```

**配置选项**：
- `startupRestoreLastProject` (boolean) - 是否在启动时恢复上次项目

### 5. 打开项目窗口

**机制描述**：打开项目时，根据情况复用现有窗口或创建新窗口。

**工作原理**：

1. 检查项目是否已有窗口
   - 如果有：显示并聚焦该窗口
   - 如果没有：继续下一步
2. 检查是否可以复用当前窗口
   - 如果当前是 Launcher 窗口且 `reuseCurrentIfLauncher` 为 true：复用当前窗口
   - 否则：创建新窗口
3. 更新窗口上下文并发送事件

**代码位置**：`src-tauri/src/commands/window.rs:239-289`

```rust
pub async fn open_project_window(
    path: String,
    reuse_current_if_launcher: bool,
    // ...
) -> Result<WindowProjectContext, String> {
    // 1. 检查项目是否已有窗口
    if let Some(existing_label) = registry.get_label_by_project(&project_path) {
        if let Some(existing_window) = app.get_webview_window(&existing_label) {
            let _ = existing_window.show();
            let _ = existing_window.set_focus();
            return Ok(registry.get_context(&existing_label));
        }
    }

    // 2. 复用当前窗口或创建新窗口
    if reuse_current_window {
        let context = registry.bind_project(window.label(), project_path, project_name);
        let _ = app.emit_to(window.label(), "window-context-updated", &context);
        return Ok(context);
    }

    // 3. 创建新窗口
    let context = registry.bind_project(&label, project_path, project_name);
    let project_window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .build()?;
    let _ = app.emit_to(project_window.label(), "window-context-updated", &context);
    Ok(context)
}
```

### 6. 再次点击图标的行为

**机制描述**：用户再次点击图标时，聚焦已存在的项目窗口，而不是创建新窗口。

**工作原理**：

1. 用户点击图标，启动新实例
2. 新实例创建新的主窗口（Launcher 模式）
3. 自动恢复逻辑触发，调用 `openProjectWindow`
4. `openProjectWindow` 检测到项目已有窗口
5. 显示并聚焦已存在的项目窗口
6. 关闭新启动的 Launcher 窗口

**代码位置**：`src-tauri/src/commands/window.rs:250-260`

```rust
if let Some(existing_label) = registry.get_label_by_project(&project_path) {
    if let Some(existing_window) = app.get_webview_window(&existing_label) {
        let _ = existing_window.show();
        let _ = existing_window.set_focus();
        if reuse_current_window && existing_label != window.label() {
            let _ = window.close();  // 关闭新启动的窗口
        }
        return Ok(registry.get_context(&existing_label));
    }
}
```

### 7. 窗口标题

**机制描述**：根据窗口模式和项目名称生成窗口标题。

**规则**：
- Launcher 模式：显示 "Termflow"
- Project 模式：显示 "{项目名称}"

**代码位置**：`src-tauri/src/commands/window.rs:492-499`

```rust
fn window_title(context: &WindowProjectContext) -> String {
    match context.project_name.as_deref() {
        Some(project_name) if context.mode == WindowMode::Project => {
            project_name.to_string()
        }
        _ => "Termflow".to_string(),
    }
}
```

## 数据流

```
┌─────────────────────────────────────────────────────────────┐
│                      前端 (AppLayout)                        │
├─────────────────────────────────────────────────────────────┤
│  useEffect → getWindowProjectContext() → initializeWindowContext()  │
│  useEffect → openProjectWindow() (启动恢复)                           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Tauri IPC 命令                            │
├─────────────────────────────────────────────────────────────┤
│  open_project_window                                         │
│  get_window_project_context                                  │
│  release_window_project_context                              │
│  focus_project_window                                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Rust 窗口管理                              │
├─────────────────────────────────────────────────────────────┤
│  WindowRegistry - 窗口上下文管理                              │
│  WindowProjectContext - 窗口项目信息                          │
│  WebviewWindowBuilder - 窗口创建                             │
└─────────────────────────────────────────────────────────────┘
```

## 依赖关系

- **项目管理模块** - 窗口管理依赖项目管理来获取项目信息
- **会话管理模块** - 窗口关闭时需要清理相关会话
- **设置模块** - 窗口行为依赖 `startupRestoreLastProject` 设置
- **语音模块** - 语音悬浮窗依赖窗口管理
