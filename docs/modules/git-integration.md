# Git 集成模块

## 模块概述

Git 集成模块负责在 Termflow 应用中提供完整的 Git 版本控制功能，包括仓库检测、状态监控、分支管理、差异对比、提交操作、远程同步以及图形化提交历史展示。该模块采用 Rust 后端（通过 `git2` 库和 `git` CLI）与 React 前端（通过 Tauri IPC）的分层架构。

**相关代码位置**：
- `src-tauri/src/commands/git/mod.rs` - Git 模块入口，导出所有子模块
- `src-tauri/src/commands/git/types.rs` - Git 数据类型定义
- `src-tauri/src/commands/git/utils.rs` - Git 工具函数
- `src-tauri/src/commands/git/error.rs` - Git 错误类型
- `src-tauri/src/commands/git/status.rs` - 仓库信息与状态监控
- `src-tauri/src/commands/git/diff.rs` - 差异对比
- `src-tauri/src/commands/git/commit.rs` - 提交操作
- `src-tauri/src/commands/git/remote.rs` - 远程推送/拉取
- `src-tauri/src/commands/git/graph.rs` - 图形化提交历史
- `src-tauri/src/commands/git/ai.rs` - AI 提交信息生成
- `src/hooks/useGitStatus.ts` - 前端 Git 状态管理 Hook
- `src/hooks/useGitCommit.ts` - 前端 Git 提交操作 Hook
- `src/components/layout/sidebar/SidebarGitPanel.tsx` - Git 侧边栏面板
- `src/components/layout/sidebar/GitFileList.tsx` - Git 文件列表组件
- `src/components/layout/sidebar/GitCommitComposer.tsx` - Git 提交表单组件
- `src/components/layout/sidebar/GitGraphSection.tsx` - Git 图表区域组件
- `src/components/layout/sidebar/GitGraphRenderer.tsx` - Git 图表渲染器
- `src/components/GitDiffTabView.tsx` - Git 差异对比标签页视图

## 核心机制

### 1. Git 仓库信息获取

**机制描述**：通过 `git2::Repository::open()` 尝试打开指定路径的 Git 仓库，返回仓库状态和分支信息。

**工作原理**：

1. 使用 `git2::Repository::open()` 打开仓库
2. 如果成功打开，返回 `isRepo: true` 并解析分支信息
3. 如果打开失败，返回 `isRepo: false`

**分支信息解析流程**：
1. 获取 HEAD 引用
2. 判断是否为 detached HEAD（通过 `head.is_branch()` 反向判断）
3. 查找本地分支的上游追踪分支
4. 使用 `repo.graph_ahead_behind()` 计算本地与远端的提交差异

**代码位置**：
- 后端：`src-tauri/src/commands/git/status.rs` 中的 `git_repo_info()` 和 `resolve_branch_info()`
- 前端 API：`src/lib/api/index.ts` 中的 `gitRepoInfo()` 和 `gitBranchInfo()`
- 前端 Hook：`src/hooks/useGitStatus.ts` 中的 `refresh()` 方法

### 2. Git 状态监控

**机制描述**：使用 `git2::StatusOptions` 获取所有文件状态，分为已暂存和未暂存两大类。

**工作原理**：

1. 配置状态查询参数（包含未跟踪文件、排除被忽略文件）
2. 通过 `repo.statuses()` 获取所有文件状态
3. 状态分为两大类：
   - **已暂存变更（Staged）**：`INDEX_NEW`、`INDEX_MODIFIED`、`INDEX_DELETED`、`INDEX_RENAMED`、`INDEX_TYPECHANGE`
   - **未暂存变更（Unstaged）**：`WT_MODIFIED`、`WT_DELETED`、`WT_RENAMED`、`WT_TYPECHANGE`、`WT_NEW`、`CONFLICTED`

**状态映射**：通过 `map_status_to_string()` 映射为：`modified`、`added`、`deleted`、`untracked`、`renamed`、`conflicted`。

**代码位置**：
- 后端：`src-tauri/src/commands/git/status.rs` 中的 `git_status()`
- 状态映射：`src-tauri/src/commands/git/utils.rs` 中的 `map_status_to_string()`
- 前端：`src/hooks/useGitStatus.ts` 中的 `refresh()` 方法

### 3. Git 分支管理

**机制描述**：分支管理主要体现在状态信息的展示和操作上下文中。

**工作原理**：

1. **分支信息获取**：通过 `resolve_branch_info()` 获取当前分支名称、ahead/behind 计数、detached HEAD 状态
2. **分支状态展示**：前端 `SidebarGitPanel` 组件显示当前分支名称，detached HEAD 时显示本地化提示文本
3. **同步状态判断**：通过 `ahead > 0 || behind > 0` 判断是否有需要同步的变更，控制同步按钮的可用状态

分支信息不涉及分支创建、切换等写操作，属于只读展示。

**代码位置**：
- 后端：`src-tauri/src/commands/git/status.rs` 中的 `resolve_branch_info()`
- 前端类型：`src/types/index.ts` 中的 `GitBranchInfo` 接口
- 前端展示：`src/components/layout/sidebar/SidebarGitPanel.tsx`

### 4. Git 差异对比

**机制描述**：差异对比提供两种模式：Patch 格式差异和内容对比差异。

**模式一：Patch 格式差异（`git_diff`）**

1. 优先生成未暂存差异（工作区 vs 索引）：使用 `repo.diff_index_to_workdir()`
2. 如果未暂存差异为空，生成已暂存差异（索引 vs HEAD）：使用 `repo.diff_tree_to_index()`
3. 通过 `diff.print(DiffFormat::Patch)` 输出 unified diff 文本
4. 检测二进制文件标志

**模式二：内容对比差异（`git_diff_content`）**

1. 已暂存文件：读取 HEAD 中的原始内容 vs 索引中的修改内容
2. 未暂存文件：优先读取索引内容作为原始版本，回退到 HEAD；修改版本从工作树文件读取
3. 通过 Monaco Editor 的 `DiffEditor` 组件进行并排对比展示

**内容读取辅助函数**：
- `read_head_content()` - 从 HEAD tree blob 读取
- `read_index_content()` - 从索引 blob 读取
- `read_worktree_content()` - 从文件系统读取

**代码位置**：
- 后端 Patch 差异：`src-tauri/src/commands/git/diff.rs` 中的 `git_diff()`
- 后端内容差异：`src-tauri/src/commands/git/diff.rs` 中的 `git_diff_content()`
- 前端差异视图：`src/components/GitDiffTabView.tsx`（使用 Monaco DiffEditor）
- 前端触发：`src/components/layout/sidebar/SidebarGitPanel.tsx` 中的 `handleViewDiff()`

### 5. Git 提交操作

**机制描述**：提交操作包含多个子功能：创建提交、修订提交、暂存/取消暂存、丢弃更改。

**创建提交（`git_commit`）**：

1. 调用 `stage_paths()` 暂存指定文件（通过 `git add --all -- <files>`）
2. 写入索引并生成树对象
3. 获取父提交（HEAD），如果是初始提交则无父提交
4. 使用 `repo.signature()` 获取签名，失败时回退到默认签名 `"Termflow <termflow@local>"`
5. 调用 `repo.commit()` 创建提交并更新 HEAD

**修订提交（`git_commit_amend`）**：
- 获取 HEAD 提交，暂存文件后使用 `head_commit.amend()` 修改最近一次提交

**暂存/取消暂存**：
- 暂存：通过 `git add --all -- <files>` 命令
- 取消暂存：有 HEAD 时使用 `repo.reset_default()`，无 HEAD 时从索引中移除条目

**丢弃更改（`git_discard_changes`）**：
- 仅未跟踪文件：直接删除工作树文件/目录
- 其他文件：使用 `repo.checkout_index()` 从索引恢复工作树内容

**自动暂存逻辑（前端 `prepareFiles`）**：
- 如果没有已暂存文件但有未暂存文件，自动暂存所有未暂存文件后再提交

**代码位置**：
- 后端提交：`src-tauri/src/commands/git/commit.rs` 中的 `git_commit()`、`git_commit_amend()`
- 后端暂存：`src-tauri/src/commands/git/commit.rs` 中的 `git_stage_files()`、`git_unstage_files()`
- 后端丢弃：`src-tauri/src/commands/git/commit.rs` 中的 `git_discard_changes()`
- 暂存工具：`src-tauri/src/commands/git/utils.rs` 中的 `stage_paths()`
- 前端 Hook：`src/hooks/useGitCommit.ts` 中的 `commit()`、`commitAmend()`、`commitAndPush()`、`commitAndSync()`
- 前端表单：`src/components/layout/sidebar/GitCommitComposer.tsx`

### 6. Git 推送/拉取

**机制描述**：推送和拉取通过 `git` CLI 命令实现（而非 `git2` 库）。

**工作原理**：

- **推送（`git_push`）**：执行 `git push`，合并 stdout 和 stderr 作为结果消息
- **拉取（`git_pull`）**：执行 `git pull`，合并 stdout 和 stderr 作为结果消息

两者都返回 `GitRemoteResult` 结构体，包含 `success` 布尔值和 `message` 字符串。即使命令失败也不抛出异常，而是返回 `success: false`。

**Windows 平台优化**：设置 `CREATE_NO_WINDOW` 标志（`0x08000000`）以防止控制台窗口闪烁。

**组合操作**：
- **提交并推送（commitAndPush）**：提交 -> 刷新状态 -> 推送 -> 刷新状态
- **提交并同步（commitAndSync）**：提交 -> 刷新状态 -> 拉取 -> 推送 -> 刷新状态
- **纯同步（sync）**：拉取 -> 推送 -> 刷新状态

**代码位置**：
- 后端：`src-tauri/src/commands/git/remote.rs` 中的 `git_push()` 和 `git_pull()`
- CLI 工具：`src-tauri/src/commands/git/utils.rs` 中的 `git_command()`
- 前端：`src/hooks/useGitCommit.ts` 中的 `push()`、`pull()`、`sync()`

### 7. Git 图形化提交历史

**机制描述**：图形化提交历史采用泳道模型（Swimlane Model），参考 VS Code SCM History 的实现。

**数据获取**：

1. `git_graph_history()`：使用 `repo.revwalk()` 遍历提交历史，按拓扑排序 + 时间排序，限制数量（默认 100，最大 500）
2. `git_graph_commit_detail()`：获取单个提交的详情（body、变更文件数、插入/删除行数），通过 `repo.diff_tree_to_tree()` 计算统计信息
3. `collect_commit_refs()`：收集所有引用（分支、标签、远程引用），按提交 OID 分组并排序

**图形渲染**：
- `GitGraphRenderer` 组件实现泳道布局算法（`computeGraphRows()`）
- 每行维护输入泳道和输出泳道状态，处理分支合并和分叉
- 颜色分配：HEAD 使用蓝色（`#59a4f9`），远程引用使用紫色（`#B180D7`），标签使用橙色（`#EA5C00`），分支从 5 色调色板循环分配
- 节点样式区分：HEAD 节点（双圆环）、合并节点（带内圈）、普通节点（单圆）
- 悬浮卡片：通过 Portal 渲染到 `document.body`，展示提交详情

**懒加载**：使用 `IntersectionObserver` 检测可见性，仅在图表区域可见时加载数据。悬浮详情带有缓存机制（`graphHoverDetailCacheRef`），避免重复请求。

**代码位置**：
- 后端历史：`src-tauri/src/commands/git/graph.rs` 中的 `git_graph_history()` 和 `git_graph_commit_detail()`
- 后端引用收集：`src-tauri/src/commands/git/utils.rs` 中的 `collect_commit_refs()`
- 前端区域：`src/components/layout/sidebar/GitGraphSection.tsx`
- 前端渲染器：`src/components/layout/sidebar/GitGraphRenderer.tsx`

### 8. AI 提交信息生成

**机制描述**：通过调用 Claude CLI 工具自动生成提交信息。

**工作原理**：

1. 收集上下文：当前分支名、`git status --short`、`git diff --cached --stat`、`git diff --stat`
2. 构建提示词：遵循 Conventional Commit 格式要求，包含 10 条生成规则
3. 调用 Claude CLI：使用 `claude -p --output-format text --max-turns 1`，通过 stdin 传入提示词
4. 超时控制：20 秒超时，轮询检查进程状态（120ms 间隔）
5. 输出清洗：`sanitize_generated_commit_message()` 移除引号、代码块标记、多余空行

**代码位置**：
- 后端：`src-tauri/src/commands/git/ai.rs` 中的 `git_generate_commit_message()`
- 前端：`src/components/layout/sidebar/SidebarGitPanel.tsx` 中的 `handleGenerateCommitMessage()`

### 9. 错误处理

**机制描述**：`GitError` 枚举统一处理三类错误来源。

**错误类型**：
- `Git2(git2::Error)` - git2 库错误
- `Io(std::io::Error)` - IO 错误
- `Custom(String)` - 自定义错误消息

实现 `From` trait 进行自动转换，最终通过 `impl From<GitError> for String` 转换为 Tauri 命令可返回的字符串类型。

**代码位置**：
- `src-tauri/src/commands/git/error.rs`

## 数据流

```
前端 React 组件
    |
    | (用户交互)
    v
Hooks (useGitStatus / useGitCommit)
    |
    | (调用 API)
    v
API 层 (src/lib/api/index.ts)
    |
    | (Tauri invoke IPC)
    v
Tauri 命令 (#[tauri::command])
    |
    | (git2 库 / git CLI)
    v
Git 仓库 (文件系统)
    |
    | (返回结果)
    v
前端状态更新 (useState / useAppStore)
    |
    | (重新渲染)
    v
UI 组件展示
```

**关键数据类型流转**：

1. **仓库检测流**：`git_repo_info` -> `GitRepoInfo` -> `useGitStatus.isRepo`
2. **状态监控流**：`git_status` + `git_branch_info` -> `GitFileStatus[]` + `GitBranchInfo` -> `stagedFiles` / `unstagedFiles` / `branchName`
3. **差异对比流**：`git_diff_content` -> `GitDiffContentResult` -> `openGitDiffTab()` -> `gitDiffDocuments` store -> `GitDiffTabView`
4. **提交流**：`GitCommitComposer` 输入 -> `useGitCommit.commit()` -> `git_commit` -> `refresh()` 刷新状态
5. **图形历史流**：`git_graph_history` -> `GitGraphCommit[]` -> `computeGraphRows()` -> SVG 泳道渲染

## 依赖关系

### 外部依赖

| 依赖 | 用途 |
|------|------|
| `git2` (Rust crate) | Git 仓库操作核心库（状态、差异、提交、引用遍历） |
| `git` CLI | 推送/拉取操作、AI 提交信息生成的上下文收集 |
| `@monaco-editor/react` | 差异对比视图渲染（DiffEditor 组件） |
| `@tauri-apps/api` (invoke) | 前后端 IPC 通信 |
| `antd` | UI 组件（Button、Dropdown、Modal、Tooltip 等） |
| `react-i18next` | 国际化文本 |
| Claude CLI | AI 提交信息生成 |

### 内部模块依赖

| 依赖模块 | 用途 |
|----------|------|
| `path_utils` | 路径标准化（`normalize_input_path`） |
| `pty` | 查找 Claude CLI 路径（`find_claude_exe`） |
| `store` (Zustand) | 全局状态管理（Git 变更计数、差异文档、侧边栏折叠状态） |
| `types` | TypeScript 类型定义 |
| `lib/api` | Tauri IPC 命令封装 |

### 命令注册

所有 Git 命令在 `src-tauri/src/lib.rs` 的 `invoke_handler` 中注册，共 15 个命令：
- `git_repo_info`、`git_status`、`git_branch_info`
- `git_graph_history`、`git_graph_commit_detail`
- `git_diff`、`git_diff_content`
- `git_commit`、`git_discard_changes`、`git_stage_files`、`git_unstage_files`、`git_commit_amend`
- `git_generate_commit_message`
- `git_push`、`git_pull`
