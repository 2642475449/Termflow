# Claude Code 高级教程：在 Windows 上构建安全、可控、可持续的 AI 开发工作流

> 面向已经掌握 Claude Code 基础命令的开发者。本文以 **Windows 10/11 原生 PowerShell** 为主，同时说明何时应该切换到 WSL2。
>
> 文档核对日期：**2026-07-17**。核对时，Anthropic 官方变更日志顶部版本为 **2.1.209（2026-07-14）**。Claude Code 更新频繁，预览功能、套餐要求和快捷键可能继续变化；文末提供了官方链接。

## 目录

1. [先建立正确的心智模型](#1-先建立正确的心智模型)
2. [Windows 高级环境基线](#2-windows-高级环境基线)
3. [权限系统：从频繁确认到可审计自治](#3-权限系统从频繁确认到可审计自治)
4. [配置分层：个人偏好、团队约定与企业策略](#4-配置分层个人偏好团队约定与企业策略)
5. [用 CLAUDE.md 和 Rules 提供高质量引导](#5-用-claudemd-和-rules-提供高质量引导)
6. [Hooks：把建议升级成自动化与强制门禁](#6-hooks把建议升级成自动化与强制门禁)
7. [Skills、Subagents 与 MCP 应该如何分工](#7-skillssubagents-与-mcp-应该如何分工)
8. [2026 年值得掌握的新能力](#8-2026-年值得掌握的新能力)
9. [一套可直接采用的渐进式工作流](#9-一套可直接采用的渐进式工作流)
10. [非交互模式与 CI 自动化](#10-非交互模式与-ci-自动化)
11. [上下文、成本与长会话管理](#11-上下文成本与长会话管理)
12. [故障排查与安全检查清单](#12-故障排查与安全检查清单)

---

## 1. 先建立正确的心智模型

Claude Code 不是“能聊天的终端”，而是一个围绕 Claude 模型构建的 **Agent Harness（智能体执行框架）**：它负责收集项目上下文、给模型提供工具、执行工具调用、管理权限、压缩上下文并保存会话。

高级使用的关键，不是写出更华丽的提示词，而是设计好以下五层：

| 层 | 解决的问题 | 典型机制 |
|---|---|---|
| 意图层 | 这次到底要完成什么 | 提示词、Plan Mode、`/goal` |
| 上下文层 | Claude 应该知道什么 | `CLAUDE.md`、`.claude/rules/`、Skills |
| 能力层 | Claude 可以调用什么 | 内置工具、MCP、Subagents |
| 控制层 | 哪些动作允许、询问或拒绝 | Permission Mode、`allow/ask/deny` |
| 执行保障层 | 如何验证、拦截和自动收尾 | Hooks、测试、Git、隔离环境 |

这里有一个非常重要的区分：

- `CLAUDE.md` 是给模型看的指导信息，能显著影响行为，但不是安全边界。
- Permission 规则决定工具调用是否允许，是产品层的审批控制。
- `PreToolUse` Hook、托管策略、容器或虚拟机才适合承担强约束。

如果一句规则的含义是“最好这样做”，写进 `CLAUDE.md`；如果含义是“绝不允许发生”，使用 `permissions.deny`、阻断型 Hook 或外部隔离。

---

## 2. Windows 高级环境基线

### 2.1 先确认版本和健康状态

在 PowerShell 中运行：

```powershell
claude --version
claude doctor
claude update
```

官方当前推荐原生安装。首次安装可使用：

```powershell
irm https://claude.ai/install.ps1 | iex
```

原生安装不要求管理员权限，并会在后台自动更新。高级用户仍应在采用新预览功能前记录版本，因为团队成员之间的版本差异会直接影响权限、Hook 事件和配置字段是否可用。

### 2.2 原生 Windows、Git Bash 还是 WSL2

三种环境不是简单的偏好差异：

| 环境 | 优点 | 主要限制 | 推荐用途 |
|---|---|---|---|
| 原生 Windows + PowerShell | 与 Windows 工具链、注册表、Visual Studio、`.ps1` 脚本契合 | 原生 Windows 不支持 Bash 沙箱 | .NET、Windows 桌面、PowerShell 项目 |
| 原生 Windows + Git Bash | 兼容大量 POSIX 命令和项目脚本 | Windows 与 POSIX 路径、转义规则可能混用 | Node.js、跨平台 Web 项目 |
| WSL2 | Linux 行为一致，支持 Claude Code Bash 沙箱 | Windows/WSL 文件边界和工具链需要规划 | 需要强隔离、Linux 构建或容器工作流 |

如果已安装 Git for Windows，Claude Code 通常使用 Git Bash 提供 Bash 工具。无法自动定位时，在 `%USERPROFILE%\.claude\settings.json` 中设置：

```json
{
  "env": {
    "CLAUDE_CODE_GIT_BASH_PATH": "C:\\Program Files\\Git\\bin\\bash.exe"
  }
}
```

### 2.3 PowerShell 工具：2026 年的关键 Windows 新能力

Claude Code 现在提供原生 PowerShell 工具，但仍属于预览能力：

- 未安装 Git Bash 的 Windows 环境会自动启用。
- 已安装 Git Bash 时处于渐进式推送，可显式选择启用。
- 优先使用 `pwsh.exe`（PowerShell 7+），找不到时回退到 Windows PowerShell 5.1。
- PowerShell Profile 不会加载。
- 原生 Windows 下依然没有沙箱支持。

显式启用并把交互式 `!` 命令切换到 PowerShell：

```json
{
  "env": {
    "CLAUDE_CODE_USE_POWERSHELL_TOOL": "1"
  },
  "defaultShell": "powershell"
}
```

Claude Code 默认以进程级 `-ExecutionPolicy Bypass` 启动 PowerShell，不会修改机器策略；企业环境若要求遵循机器的有效执行策略，可以增加：

```json
{
  "env": {
    "CLAUDE_CODE_POWERSHELL_RESPECT_EXECUTION_POLICY": "1"
  }
}
```

### 2.4 什么时候必须选择 WSL2

权限提示和沙箱不是一回事。权限提示是 Claude Code 在执行前询问你；沙箱是操作系统在执行时限制进程真实能访问的文件和网络。

Claude Code 的 Bash 沙箱目前支持 macOS、Linux 和 WSL2，**不支持原生 Windows**。因此，当任务包含以下任一情况时，优先使用 WSL2、Dev Container 或虚拟机：

- 需要长时间无人值守运行。
- 会处理来源不可信的仓库、网页或 Issue 内容。
- 需要执行大量依赖安装或第三方脚本。
- 希望使用 `bypassPermissions`。
- 工作目录附近存在生产密钥、个人文件或公司敏感数据。

在原生 Windows 上，`bypassPermissions` 意味着命令直接以当前 Windows 用户权限执行，不能把它误认为“已经沙箱化”。

---

## 3. 权限系统：从频繁确认到可审计自治

### 3.1 六种权限模式怎么选

Claude Code 当前提供六种模式：

| 模式 | 无需询问即可执行 | 适合场景 | 建议 |
|---|---|---|---|
| `default` | 工作目录内读取；少量内置只读命令 | 陌生项目、敏感代码 | 安全起点 |
| `acceptEdits` | 读取、文件编辑、常见文件操作 | 日常开发且持续看 Diff | 最实用的默认值 |
| `plan` | 只读探索，不修改源码 | 需求澄清、架构分析、先审方案 | 复杂任务第一阶段 |
| `auto` | 由独立分类器后台检查后自动批准 | 长任务、减少确认疲劳 | 研究预览，有套餐与模型限制 |
| `dontAsk` | 只执行预先允许的工具，其他自动拒绝 | CI、锁定脚本 | 无人值守首选 |
| `bypassPermissions` | 跳过权限提示和安全检查 | 隔离容器或 VM | 不要在普通 Windows 主机使用 |

会话中用 `Shift+Tab` 在常用模式间切换。启动时显式选择：

```powershell
claude --permission-mode plan
claude --permission-mode acceptEdits
claude --permission-mode dontAsk
```

持久默认值写入 settings：

```json
{
  "permissions": {
    "defaultMode": "acceptEdits"
  }
}
```

建议的工作节奏是：

1. 用 `plan` 理解问题、让 Claude 列出假设、风险与验证方式。
2. 你确认方向后切换到 `acceptEdits`。
3. 只为稳定、可重复、低风险命令添加精确的 allow 规则。
4. 对部署、推送、删除和密钥访问设置 deny 或 ask。

### 3.2 `allow`、`ask`、`deny` 的优先级

规则格式是 `Tool` 或 `Tool(specifier)`：

```json
{
  "permissions": {
    "allow": [
      "PowerShell(pnpm.cmd run test *)",
      "PowerShell(pnpm.cmd run build *)",
      "PowerShell(git status *)"
    ],
    "ask": [
      "PowerShell(git commit *)"
    ],
    "deny": [
      "PowerShell(git push *)",
      "PowerShell(Remove-Item *)",
      "Read(./.env)",
      "Read(./secrets/**)"
    ]
  }
}
```

核心规则是：**deny → ask → allow**。任何作用域中的 deny 都不会被另一个作用域的 allow 覆盖；托管策略中的 deny 也不能被命令行参数绕开。

不要为了消除提示直接写：

```json
{
  "permissions": {
    "allow": ["PowerShell", "Bash"]
  }
}
```

这几乎等于允许任意代码执行。更好的策略是允许固定构建入口，例如 `pnpm.cmd run test *`，而不是允许解释器、包管理器或全部 Shell。

### 3.3 PowerShell 规则的匹配细节

PowerShell 权限规则大小写不敏感，并会规范化常见别名。例如允许 `Get-ChildItem` 的规则也能匹配 `gci`、`ls` 和 `dir`。Claude Code 会解析 PowerShell AST，将管道 `|`、分号 `;` 以及 PowerShell 7 的 `&&`、`||` 拆成子命令逐一检查。

这意味着：

```powershell
pnpm.cmd test; git push
```

不能因为第一段测试命令被允许，就把第二段推送一起带过审批。

仍要避免用脆弱的字符串规则模拟真正的网络或数据防泄漏策略。Shell 可以通过变量、重定向、编码、子进程和脚本间接完成动作；真正敏感的边界应交给 Hook、代理、防火墙、容器或托管策略。

### 3.4 文件、网络和 MCP 权限

常见规则示例：

```json
{
  "permissions": {
    "allow": [
      "WebFetch(domain:docs.example.com)",
      "mcp__github__get_pull_request"
    ],
    "deny": [
      "Read(./.env)",
      "Read(./private/**)",
      "WebFetch(domain:*)",
      "mcp__github__merge_pull_request"
    ]
  }
}
```

注意：禁止 `WebFetch` 不等于断网。只要 Shell 仍可执行，`curl`、`Invoke-WebRequest`、Python 或项目依赖都可能访问网络。网络强隔离要使用 WSL2 沙箱、容器、防火墙或组织代理。

### 3.5 工作目录与受保护路径

Claude 默认可以读取启动目录。临时增加目录：

```powershell
claude --add-dir D:\shared\contracts
```

会话中可用 `/add-dir`；持久授权则配置 `permissions.additionalDirectories`。增加目录会扩大文件访问面，但不会自动把该目录变成完整的配置根。

除 `bypassPermissions` 外，`.git`、`.vscode`、`.idea`、`.husky`、大部分 `.claude` 路径，以及 `.mcp.json`、`.claude.json`、Shell Profile 等都属于受保护位置。不要通过扩大 allow 规则来消除这些提示；提示本身是在提醒你动作会改变仓库控制面或 Claude 自身配置。

### 3.6 Auto Mode 不是“更好看的 bypass”

`auto` 会通过独立分类器检查工具动作是否超出用户意图、是否针对陌生基础设施，或是否受到不可信内容诱导。它默认会阻止生产部署、共享基础设施修改、强推、向 `main` 直接推送、不可逆删除和敏感数据外传等高风险行为。

它仍是研究预览，并且截至本文核对时：

- 仅面向 Max、Team、Enterprise 或 API；Pro 不可用。
- Team/Enterprise 需要管理员启用。
- 只支持指定的新模型组合。
- 只支持 Anthropic API，不支持 Bedrock、Vertex 或 Foundry。
- 分类器会增加少量延迟和 Token 消耗，也不保证绝对安全。

对敏感动作，仍应写硬规则：

```json
{
  "permissions": {
    "deny": [
      "PowerShell(git push --force *)",
      "PowerShell(git push * main*)"
    ]
  }
}
```

会话里说“不要推送”可以让 Auto Mode 把它视为边界，但对话压缩可能移除这句话。需要长期保证时，必须写入权限规则，而不是只依赖聊天记录。

---

## 4. 配置分层：个人偏好、团队约定与企业策略

### 4.1 Windows 上的配置位置

| 作用域 | Windows 路径 | 是否提交 Git | 用途 |
|---|---|---|---|
| 用户 | `%USERPROFILE%\.claude\settings.json` | 否 | 个人默认模式、终端偏好、个人插件 |
| 项目 | `<repo>\.claude\settings.json` | 是 | 团队共享权限、Hooks、插件设置 |
| 本地项目 | `<repo>\.claude\settings.local.json` | 否 | 机器差异、个人试验、临时授权 |
| 托管 | `C:\Program Files\ClaudeCode\managed-settings.json` | 由 IT 部署 | 组织强制策略 |

旧的 `C:\ProgramData\ClaudeCode\managed-settings.json` 已不再是受支持路径。企业也可以通过 `HKLM\SOFTWARE\Policies\ClaudeCode` 的 `Settings` 值部署 JSON；HKCU 策略只在没有管理员级来源时生效。

### 4.2 普通配置与权限规则的合并方式不同

普通设置优先级从高到低为：

1. Managed
2. 命令行参数
3. Local project
4. Shared project
5. User

但权限数组不是简单覆盖，而是跨作用域合并，再按 deny、ask、allow 判断。因此个人配置中的 allow 不能抵消项目或组织里的 deny。

### 4.3 推荐的项目配置骨架

将团队真正需要共享的最小集合提交到 `.claude/settings.json`：

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "defaultMode": "default",
    "allow": [
      "PowerShell(pnpm.cmd run test *)",
      "PowerShell(pnpm.cmd run lint *)",
      "PowerShell(pnpm.cmd run build *)",
      "PowerShell(git status *)",
      "PowerShell(git diff *)"
    ],
    "ask": [
      "PowerShell(git commit *)"
    ],
    "deny": [
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(./secrets/**)",
      "PowerShell(git push *)",
      "PowerShell(Remove-Item *)"
    ]
  }
}
```

实际项目如果主要使用 Git Bash，将 `PowerShell(...)` 换成对应的 `Bash(...)`。不要同时盲目复制两套宽泛规则；先运行 `/permissions` 查看 Claude 实际在调用哪个工具、规则来自哪个文件。

---

## 5. 用 CLAUDE.md 和 Rules 提供高质量引导

### 5.1 `CLAUDE.md` 应该写什么

把它当成“新成员开始改代码前必须知道的一页纸”，而不是项目百科全书。优先写：

- 构建、测试、Lint 的权威命令。
- 架构边界和目录职责。
- 不直观但必须遵守的约束。
- 修改后的验证要求。
- 团队特有的 Git 与审查习惯。
- Claude 曾重复犯过的项目特定错误。

示例：

```markdown
# Project instructions

## Commands

- Install: `pnpm install --frozen-lockfile`
- Unit tests: `pnpm test`
- Type check: `pnpm exec tsc --noEmit`
- Production build: `pnpm build`

## Architecture boundaries

- React UI lives in `src/`; native operations live in `src-tauri/`.
- Do not access filesystem APIs directly from React components.
- Reuse the command wrapper in `src/services/tauri.ts`.

## Working agreement

- For changes touching more than three files, present a plan first.
- Preserve unrelated user changes in a dirty working tree.
- Do not commit or push unless explicitly requested.
- Before reporting completion, run the smallest relevant test and type check.
```

“写 TypeScript 要规范”“注意安全”这类泛化内容价值很低。更有效的表述包含 **触发条件、具体动作、验证方式和例外**。

### 5.2 用 `.claude/rules/` 拆分条件化规则

当 `CLAUDE.md` 变长时，把领域规则放到 `.claude/rules/*.md`，并使用 `paths` Frontmatter 按文件范围加载：

```markdown
---
paths:
  - "src/api/**/*.ts"
  - "src/services/**/*.ts"
---

# API rules

- Validate all external input at the boundary.
- Never log access tokens or raw authorization headers.
- Add a failure-path test for each new network request.
```

这样可以减少无关上下文噪音。规则越多不代表效果越好；始终加载的内容越大，模型越容易忽略真正关键的约束。

### 5.3 与 `AGENTS.md` 共存

Claude Code 原生读取 `CLAUDE.md`，不会自动把 `AGENTS.md` 当作项目指令。已有统一代理规范时，在 `CLAUDE.md` 中导入：

```markdown
@AGENTS.md

## Claude Code specific

- Use Plan Mode before modifying `src/billing/`.
```

Windows 创建符号链接通常需要管理员权限或开发者模式，因此导入方式比链接更稳妥。

### 5.4 引导 Claude 提问，而不是猜测

复杂任务的开场提示可以固定成以下结构：

```text
先不要修改文件。请先：
1. 复述目标和不可改变的约束；
2. 检查相关代码、测试和项目指令；
3. 列出最多 3 个会实质改变方案的问题；
4. 给出实施计划、风险和验证命令；
5. 等我确认后再开始修改。
```

实现阶段则应给出可验证终点：

```text
按已确认方案实施。保持改动最小，不覆盖无关修改。
完成条件：目标测试通过、类型检查通过，并总结修改文件和剩余风险。
不要提交或推送。
```

这比一句“帮我重构一下”更容易获得稳定结果，因为它同时限定了探索、决策、执行和验收。

---

## 6. Hooks：把建议升级成自动化与强制门禁

### 6.1 什么时候用 Hook

Hook 适合确定性的生命周期动作：

- 工具调用前检查危险命令。
- 文件修改后格式化或运行局部检查。
- Claude 需要输入时发送桌面通知。
- 会话开始时注入动态环境信息。
- 结束前检查测试、工作区或验收条件。
- 记录配置加载和工具使用，便于审计。

常用事件包括 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PostToolUseFailure`、`SubagentStart`、`SubagentStop`、`PreCompact`、`PostCompact`、`Stop` 和 `SessionEnd`。

### 6.2 Windows PowerShell Hook 示例

下面的项目 Hook 在 Claude 写入文件后显示一条信息：

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "shell": "powershell",
            "command": "Write-Host 'Claude modified a file; remember to run focused checks.'"
          }
        ]
      }
    ]
  }
}
```

单个 Hook 上的 `"shell": "powershell"` 不依赖 PowerShell 工具是否启用。Claude 会直接启动 PowerShell 7，找不到时回退到 5.1。

真正的检查逻辑建议放在仓库脚本中，而不是把几十行 PowerShell 塞进 JSON。Hook 使用绝对路径或 `${CLAUDE_PROJECT_DIR}` 定位脚本，并对来自 stdin 的 JSON 输入做严格解析和校验。

### 6.3 阻断逻辑的三个易错点

1. 命令 Hook 通常用 **退出码 2** 表示阻断；退出码 1 对多数事件只是非阻断错误。
2. `PostToolUse` 发生在动作之后，只能反馈，不能撤销已经写入的文件或已发送的网络请求。
3. Hook 以当前系统用户的完整权限运行，不受 Claude Code 工具权限规则保护。安装来自陌生仓库的 Hook 前必须审查脚本。

查看和调试：

```text
/hooks
```

```powershell
claude --debug-file .claude-debug.log
```

如果安全边界必须跨团队强制执行，把 Hook 和 deny 规则放入 Managed Settings；项目中的 Hook 最终仍属于仓库提供的代码，需要工作区信任和代码审查。

---

## 7. Skills、Subagents 与 MCP 应该如何分工

这几个扩展点经常被混用。一个实用判断表是：

| 需求 | 应使用 | 原因 |
|---|---|---|
| 每次会话都必须知道的简短约定 | `CLAUDE.md` | 始终加载 |
| 只在特定文件上生效的规则 | `.claude/rules/` | 条件加载 |
| 可重复、按需触发的工作流程 | Skill | 用到时才加载，可带脚本和参考资料 |
| 会产生大量中间材料的独立任务 | Subagent | 独立上下文，只返回结果 |
| 访问 GitHub、数据库、浏览器或内部系统 | MCP | 提供外部连接和工具 |
| 在事件发生时强制执行动作 | Hook | 确定性生命周期自动化 |
| 把 Skills、Agents、Hooks、MCP 打包分发 | Plugin | 版本化和团队分发 |

### 7.1 创建一个项目 Skill

项目 Skill 位于 `.claude/skills/<name>/SKILL.md`。例如：

```markdown
---
description: Review the current Windows changes for path, quoting, encoding, and PowerShell compatibility risks.
---

# Windows compatibility review

1. Inspect the current diff.
2. Check path separators and paths containing spaces.
3. Check PowerShell 5.1 versus 7 syntax.
4. Check UTF-8 encoding and CRLF assumptions.
5. Report findings by severity with file and line references.
6. Do not modify files unless the user explicitly asks for fixes.
```

可直接输入 `/windows-compatibility-review`，也可以让 Claude 根据 description 自动判断何时加载。Skills 会热加载，通常不需要重启会话。

### 7.2 创建一个只读审查 Subagent

项目级 Agent 放在 `.claude/agents/`，例如 `.claude/agents/security-reviewer.md`：

```markdown
---
name: security-reviewer
description: Review code changes for concrete security vulnerabilities and secret exposure.
model: sonnet
tools: Read, Grep, Glob
---

Review only the changed code and directly reachable call sites.
Prioritize exploitable issues over style concerns.
Return findings with severity, evidence, and the smallest safe remediation.
If there are no findings, say so explicitly.
```

只读工具清单可以让审查者保持独立且不会修改代码。Subagent 有自己的上下文窗口，适合把搜索结果、日志和长文档隔离出去；它不会自动看到主会话的完整历史，因此委派描述必须包含目标和约束。

### 7.3 不要把并行当成免费加速

并行 Subagents、独立后台会话和 Agent Teams 会分别消耗 Token，并可能同时修改相同文件。并行前先按文件或职责切分：

- 调研与实现可以并行，因为调研者只读。
- 前端与后端可以并行，但要明确接口契约。
- 两个 Agent 同改同一文件通常弊大于利。
- 真正独立的修改应使用 Git Worktree 隔离。

---

## 8. 2026 年值得掌握的新能力

### 8.1 Agent View：管理多个后台会话

Agent View 是研究预览，使用：

```powershell
claude agents
```

它把所有后台 Claude Code 会话放在一个列表中，显示运行中、等待输入和已完成状态。适合你亲自分派多个互不依赖的任务。

```powershell
claude --bg "调查登录偶发超时，只报告原因，不改代码"
claude agents --json
```

在交互会话内可用 `/bg` 把当前会话转入后台。Agent View 和 Subagent 的差别是：

- Agent View：多个独立会话由你协调。
- Subagent：单个主会话内部委派，由 Claude 汇总结果。
- Agent Teams：多个 Agent 彼此通信和共享任务表，仍属实验能力，成本和协调复杂度更高。

### 8.2 `/goal`：让会话持续工作到验收条件满足

`/goal` 为当前会话设置一个可验证完成条件。每轮结束后，一个较小模型判断条件是否满足；不满足就自动开始下一轮。

```text
/goal 所有 auth 模块测试通过，类型检查无错误，且 git diff 中没有调试日志
```

查看状态：

```text
/goal
```

提前停止：

```text
/goal clear
```

非交互运行：

```powershell
claude -p "/goal 修复当前类型错误，直到 pnpm.cmd exec tsc --noEmit 通过"
```

有效的 Goal 应是可观察、可验证、范围明确的状态。不要写“把项目做好”或“尽可能优化性能”。更好的条件是“指定测试通过、构建成功、某类错误归零、每个验收项在最终报告中有证据”。

`/goal` 解决跨轮持续推进，Auto Mode 解决每轮中的工具审批；两者组合自治程度很高，也会放大错误方向的成本。先在 Plan Mode 审核方案，再设置 Goal。

### 8.3 `/cd`、命名会话与恢复

较新的 Claude Code 支持在会话中使用 `/cd` 改变主工作目录。它不同于 `/add-dir`：`/cd` 会迁移会话工作目录、加载新位置的 `CLAUDE.md`，并影响会话恢复归属。

长任务建议命名：

```text
/rename auth-refactor
```

恢复：

```powershell
claude --resume "auth-refactor"
```

分支或需求切换时，不要在同一上下文里无限追加任务。命名会话、按目标拆分，可以减少历史指令互相污染。

### 8.4 Auto Memory 与 `/memory`

Claude Code 除了读取你维护的 `CLAUDE.md`，还可以为每个仓库保存自动记忆，例如可靠的构建命令、调试经验和你反复纠正的偏好。使用：

```text
/memory
```

定期审查自动记忆，删除过期或误导内容。Auto Memory 和 `CLAUDE.md` 都属于上下文，不是权限控制；不要把密钥、Token 或安全白名单放进记忆。

### 8.5 屏幕阅读器与可访问性

2.1.208 加入了屏幕阅读器模式，可通过以下任一方式启用：

```powershell
claude --ax-screen-reader
$env:CLAUDE_AX_SCREEN_READER = "1"
```

或在 settings 中设置 `"axScreenReader": true`。团队编写自定义状态栏、Hook 通知和插件 UI 时，应避免只通过颜色传达状态。

---

## 9. 一套可直接采用的渐进式工作流

下面用“修复一个跨多文件的 Windows 路径 Bug”为例。

### 阶段 A：信任前检查

1. 在 Git 中查看仓库来源和当前状态。
2. 阅读根目录的 `CLAUDE.md`、`.claude/settings.json`、`.mcp.json` 和 Hooks。
3. 对陌生仓库不要直接接受宽泛 allow、额外目录、插件或 Hook。
4. 执行 `claude --permission-mode plan`。

### 阶段 B：让 Claude 调研并提问

```text
调查 Windows 下项目路径包含空格时启动失败的问题。
先保持 Plan Mode，不修改文件。
请定位启动命令的构造链路、现有测试和平台分支；提出会改变方案的关键问题；
最后给出最小修复方案、回归风险和准确的验证命令。
```

你要审查的不是文笔，而是：

- 是否找到了真正的命令边界。
- 是否考虑 PowerShell、Git Bash、CMD 的不同转义语义。
- 是否会碰到用户已有修改。
- 是否包含失败路径测试。
- 验证命令是否能证明验收条件。

### 阶段 C：切换到受控执行

确认后切到 `acceptEdits`，并明确边界：

```text
按方案实施，只修改启动命令构造和对应测试。
不要改公共格式化规则，不要提交或推送。
若发现必须扩大修改范围，先停下说明原因。
完成后运行目标测试和类型检查，并给出证据。
```

### 阶段 D：用独立审查隔离确认偏差

让只读 Subagent 复核 Windows 转义、安全和回归风险，或直接执行项目 Skill。审查者不负责继续实现，避免“自己证明自己正确”。

### 阶段 E：人工检查交付面

最终至少检查：

```powershell
git status --short
git diff --check
git diff
```

再确认：

- 没有 `.env`、凭据、日志或生成物混入 Diff。
- 测试确实运行过，而不是 Claude 仅声称“应该通过”。
- 没有未经授权的提交、推送或依赖升级。
- Claude 报告的剩余风险与你看到的 Diff 一致。

---

## 10. 非交互模式与 CI 自动化

### 10.1 结构化调用

`-p` 执行一次查询后退出：

```powershell
claude -p "总结当前未提交修改，并列出缺失的测试"
```

恢复最近会话并继续非交互执行：

```powershell
claude -c -p "运行相关测试并解释失败原因"
```

自动化脚本应优先使用结构化输出参数，并固定可接受的工具范围。不要用字符串解析人类可读的彩色终端输出构建关键流水线。

### 10.2 CI 为什么优先 `dontAsk`

CI 没有人处理弹窗。`default` 会卡在权限请求，`bypassPermissions` 又过于宽泛。`dontAsk` 会让未预先允许的动作直接失败，最适合白名单式自动化：

```powershell
claude -p `
  --permission-mode dontAsk `
  --allowedTools "Read,Grep,Glob,PowerShell(pnpm.cmd run test *)" `
  "分析测试失败并输出根因，不修改文件"
```

PowerShell 的反引号是续行符，反引号后不能有空格。CI 中建议最终改成参数数组或单行命令，减少 YAML、PowerShell 和 Claude 参数三层转义带来的问题。

### 10.3 自动修复要增加三道门

允许 CI 修改代码时，至少增加：

1. 在临时分支、Worktree、容器或一次性 Runner 中运行。
2. deny 推送、发布、部署、密钥读取与外部网络写操作。
3. 输出 Patch 交给人工或独立检查任务审阅，而不是直接合并。

一个 Agent 能“运行成功”并不代表它拥有修改生产状态的授权。

---

## 11. 上下文、成本与长会话管理

### 11.1 上下文不是越多越好

每个始终加载的 `CLAUDE.md`、MCP 工具描述、Agent 定义和规则都会占用上下文。噪音过多会导致：

- 真正关键的项目约束被稀释。
- Skill 自动触发变得不稳定。
- 模型重复探索已经知道的信息。
- 压缩更频繁，早期边界被摘要化。

使用 `/context` 观察上下文构成。优化顺序通常是：

1. 删除重复、泛化和过期指令。
2. 把长参考资料移入按需 Skill。
3. 把路径相关规则移入 `.claude/rules/`。
4. 把高噪音调研交给 Subagent。
5. 任务切换时开新会话，不把一个会话当永久工作台。

### 11.2 压缩前后的安全意识

Claude Code 会自动压缩长上下文，也可以手动使用 `/compact`。重要约束不要只在很早的一条聊天消息里出现：

- 稳定行为规则写入 `CLAUDE.md`。
- 强制限制写入权限或 Hook。
- 当前任务的验收条件可以在压缩前重新陈述。
- 压缩后让 Claude复述当前目标、未完成项和禁止动作。

### 11.3 模型分工

高成本模型适合架构权衡、复杂调试和最终审查；较快模型适合仓库搜索、固定格式转换和重复检查。Subagent 可在 Frontmatter 中设置 `haiku`、`sonnet`、`opus` 或 `inherit`。

不要仅按“越强越好”选模型。任务边界清晰、工具受限、验证充分，往往比单纯提高模型档位更能改善可靠性。

---

## 12. 故障排查与安全检查清单

### 12.1 配置为什么没有生效

按顺序检查：

1. `claude --version` 是否达到功能要求。
2. 配置是否放在 `settings.json`，而不是存储应用状态的 `.claude.json`。
3. JSON 是否有效，字段是否有 Schema 报错。
4. `/permissions` 是否显示规则及其来源。
5. `/hooks` 是否显示 Hook 及 Matcher。
6. `/context` 是否加载预期的 `CLAUDE.md`、Rules、Skills 和 Agents。
7. `/doctor` 是否报告 Shell、MCP、插件或更新问题。
8. 用 `claude --debug-file <path>` 获取可复现日志。

建议在 settings 顶部保留：

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json"
}
```

### 12.2 Windows 特有问题

#### Claude 找不到 Git Bash

设置 `CLAUDE_CODE_GIT_BASH_PATH`，确认目标是 `bash.exe`，并检查路径中的反斜杠已在 JSON 中双写。

#### PowerShell 5.1 与 7 行为不同

检查：

```powershell
$PSVersionTable.PSVersion
Get-Command pwsh -ErrorAction SilentlyContinue
```

团队脚本如果依赖 `&&`、`||` 或新版 cmdlet，应明确要求 PowerShell 7，不要让不同机器静默回退到 5.1。

#### Hook 能运行，Claude 的 PowerShell 工具却不可用

这是可能的：`shell: powershell` 的 Hook 直接启动 PowerShell，不依赖 `CLAUDE_CODE_USE_POWERSHELL_TOOL`。两者分别排查。

#### 中文输出乱码

优先统一终端、脚本和文件为 UTF-8。在旧版 Windows PowerShell 中，外部命令编码和 `Out-File` 默认行为可能与 PowerShell 7 不同；不要让自动修复批量重写整仓库编码。

### 12.3 每次扩大自治前的检查清单

- [ ] 当前仓库和其中的指令、Hooks、插件来源可信。
- [ ] 工作区没有 Claude 不应读取的密钥或个人文件。
- [ ] 任务有明确完成条件和停止条件。
- [ ] 修改在 Git、Worktree、容器或备份保护下可恢复。
- [ ] allow 规则只覆盖稳定、窄范围的命令。
- [ ] 删除、推送、发布、部署、付费资源和权限变更仍被询问或拒绝。
- [ ] 原生 Windows 环境没有被误认为存在沙箱。
- [ ] 长时间运行前已验证测试命令和 Hook 本身。
- [ ] 并行 Agent 不会同时修改相同文件。
- [ ] 最终结果会经过 Diff、测试和人工复核。

---

## 结语：高级用法的目标不是“零确认”

Claude Code 的高级能力会把开发者从逐条指导提升到设计目标、边界和验收。但成熟的自治并不是把所有权限关闭，而是让低风险、可恢复、可验证的动作顺畅执行，让高风险动作在正确的位置停下来。

一套稳健的 Windows 工作流通常长这样：

1. `CLAUDE.md` 提供简短、具体、长期有效的项目引导。
2. Plan Mode 负责复杂任务的探索和澄清。
3. `acceptEdits` 配合精确 allow/ask/deny 规则完成日常开发。
4. Hooks 自动验证并阻断明确禁止的行为。
5. Skills 固化流程，Subagents 隔离高噪音任务，MCP 只提供必要外部能力。
6. `/goal`、Agent View 和 Auto Mode 只在目标明确、边界可靠、环境可恢复时逐步引入。
7. 需要真正无人值守或使用 bypass 时，转入 WSL2、容器或 VM。

你真正要优化的不是“Claude 每分钟写多少代码”，而是从意图到验证的闭环有多可靠。

## 官方资料

- [Claude Code 变更日志](https://code.claude.com/docs/en/changelog)
- [Windows 与高级安装](https://code.claude.com/docs/en/setup)
- [CLI 命令参考](https://code.claude.com/docs/en/cli-reference)
- [权限模式](https://code.claude.com/docs/en/permission-modes)
- [权限规则](https://code.claude.com/docs/en/permissions)
- [Settings 与配置作用域](https://code.claude.com/docs/en/settings)
- [PowerShell 工具参考](https://code.claude.com/docs/en/tools-reference#powershell-tool)
- [Bash 沙箱](https://code.claude.com/docs/en/sandboxing)
- [CLAUDE.md、Rules 与 Auto Memory](https://code.claude.com/docs/en/memory)
- [Hooks 指南](https://code.claude.com/docs/en/hooks-guide)
- [Hooks 完整参考](https://code.claude.com/docs/en/hooks)
- [Skills](https://code.claude.com/docs/en/skills)
- [Subagents](https://code.claude.com/docs/en/sub-agents)
- [并行 Agent 方案比较](https://code.claude.com/docs/en/agents)
- [Agent View](https://code.claude.com/docs/en/agent-view)
- [`/goal`](https://code.claude.com/docs/en/goal)
- [Auto Mode 配置](https://code.claude.com/docs/en/auto-mode-config)
- [配置调试](https://code.claude.com/docs/en/debug-your-config)
