# Qoder CLI 集成说明

最后验证：2026-08-07，`@qodercn-ai/qoderclicn`（Qoder CN CLI）。Termflow 仅集成国内版，不检测或启动国际版 `qodercli`。

### 集成边界

| 能力 | Qoder CLI | Termflow 状态 | 说明 |
| --- | --- | --- | --- |
| PATH 检测与版本 | 原生支持 | 完整 | 命令为 `qoderclicn`，版本参数为 `--version` |
| 交互终端 | 原生支持 | 完整 | 使用 PTY 启动 |
| 初始提示词 | 原生支持 | 完整 | 使用 `--prompt-interactive`，提示词通过临时环境变量传入 |
| 无头文本调用 | 原生支持 | 完整 | Git AI 使用 `-p`，提示词通过纯文本 stdin 传入，避免 Windows `.cmd` 的 8191 字符限制；同时禁用工具、使用 `dont_ask` 与无会话持久化 |
| 会话恢复 | 原生支持 | 完整 | 优先 `--resume <session-id>`，无 ID 时使用 `--continue` |
| 权限模式 | 原生支持 | 完整 | UI 覆盖官方权限文档中的模式；1.1.7 顶层帮助暂未列出但实际接受 `plan` |
| 状态与权限等待 | 原生 Hooks | 部分 | 写入 Qoder `settings.json` 并保留用户配置；仍需真实模型生命周期验证 Stop-veto、compact 与 Notification 细节 |
| 完成、错误与通知 | 原生 Hooks | 部分 | 已复用 Termflow 的统一状态、Attention 和通知链路，但尚未执行消耗 Credits 的端到端验证 |
| Skills | 原生支持 | 部分 | 可管理项目 `.qoder/skills` 与用户 `~/.qoder/skills`；尚未覆盖内置 Skill 和 Qoder 原生 enable/disable override |
| 项目指令 | 原生支持 | 部分 | UI 编辑项目 `AGENTS.md`；`AGENTS.local.md` 和用户级入口暂未开放 |
| MCP | Qoder 原生支持 | 未集成管理 | Termflow 的 MCP 设置页当前仍是 Claude 专用，不声称已支持 |
| 用量/上下文遥测 | 无稳定本地接口 | 未支持 | 不展示猜测数据 |
| ACP | Qoder 原生支持 | 预留 | 当前仍使用 PTY + 原生 Hooks |

## 状态映射

| Qoder Hook | Termflow 状态 | 事件 |
| --- | --- | --- |
| `SessionStart` | `waiting` | `session_start` |
| `UserPromptSubmit` | `running` | `user_prompt_submit` |
| `PreToolUse` / `PostToolUse` | `running` | `pre_tool_use` / `post_tool_use` |
| `PostToolUseFailure` | `running` | `post_tool_use_failure` |
| `PermissionRequest` / `Elicitation` | `waiting` | `permission_request` / `waiting_input` |
| `PermissionDenied` | `running` | `permission_denied` |
| `ElicitationResult` | `running` | `working` |
| `Stop` | `completed` | `assistant_complete` |
| `StopFailure` | `error` | `process_error` |

`SessionStart` 只用于建立会话关联，不触发“等待权限”通知。Hook 载荷不会把原始提示词或工具输入转发给 Termflow。

用户 Hooks 与 Skills 使用 Qoder CN 的 `~/.qoder-cn`；项目级 Hooks 与 Skills 使用 `.qoder`。国际版的环境变量配置根不适用于此集成。

## 可扩展结构

Termflow 现在把稳定身份与展示能力集中到前端 `AGENT_DEFINITIONS`，把检测命令与版本参数集中到 Rust `AGENT_DEFINITIONS`。菜单、图标、颜色、缓存校验、默认智能体、通知诊断、Skills 和 Hooks 列表都从注册表派生；启动、无头调用、恢复和状态解析保留为 provider adapter。

增加下一个智能体时，应按以下顺序接入：

1. 注册稳定 ID、显示名、命令、图标和能力等级。
2. 分别实现 interactive、initial prompt、headless、resume、status、Skills 与 instructions adapter；不支持的能力明确标记。
3. 添加 provider 命令构造、Windows wrapper、Hook 映射和目录根测试。
4. 运行类型检查、前后端单元测试、构建和生命周期验证。

若智能体数量继续增长，下一步应以一个共享 manifest 生成 TypeScript 与 Rust 注册表，消除双端元数据的手工同步，同时继续保留 provider adapter 中的专属逻辑。

## 官方资料

- [Qoder 官网实际引用的 180×180 SVG 图标](https://img.alicdn.com/imgextra/i3/O1CN01KliT1u1jEq947NlKH_!!6000000004517-55-tps-180-180.svg)已原样保存为 `public/agents/qoder.svg`，未自行生成或重绘；上游内容 SHA-256（忽略仓库文件末尾换行）为 `2924A0FE240E0CA63895E345F65EFBB6780B5C8E8B97A3ECF98C610F6E01FC41`。
- [Qoder CN CLI 快速开始](https://docs.qoder.cn/cli/qoder-cli-cn-get-started-quickly)
- [使用 Qoder CN CLI](https://docs.qoder.cn/cli/using-the-cli)
- [权限](https://docs.qoder.cn/cli/permissions)
- [Hooks](https://docs.qoder.cn/cli/hook)
- [Skills](https://docs.qoder.cn/cli/skills)
- [MCP 服务](https://docs.qoder.cn/cli/using-the-cli)
