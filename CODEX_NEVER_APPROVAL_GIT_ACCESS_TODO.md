# Codex「永不询问审批」模式下的 Git/GitHub 访问改进待办

> 状态：待实施  
> 优先级：P1  
> 记录日期：2026-09-04  
> 涉及范围：新建会话、Codex CLI 启动参数、权限说明、Git/GitHub 工作流

## 问题摘要

在 Termflow 新建 Codex 会话时，如果用户选择以下组合：

- 审批模式：`永不询问审批`
- 沙箱模式：`工作区可写`
- `跳过审批和沙箱（YOLO）`：关闭

用户容易将其理解为“所有操作都不再询问并自动允许”。实际上，该组合表示：

1. Codex 继续在 `workspace-write` 沙箱中运行；
2. 超出沙箱边界的操作不再弹出审批请求，而是直接无法执行；
3. 命令默认不能访问网络；
4. 工作区中的 `.git` 目录仍然受只读保护。

因此，Codex 虽然可以读写普通项目文件，但可能无法完成依赖 Git 元数据写入或 GitHub 网络访问的操作。

## 用户影响

通常可以执行：

- 读取和修改工作区内的普通文件；
- `git status`、`git diff`、`git log` 等只读 Git 操作。

可能被阻止：

- `git add`、`git commit`、`git checkout`、`git switch`、`git merge` 等需要修改 `.git` 的操作；
- `git fetch`、`git pull`、`git push` 等需要访问远端且通常会更新 Git 元数据的操作；
- `gh pr create`、`gh issue view` 等需要访问 GitHub 的命令；
- 任何需要访问工作区外文件、凭据或其他受保护资源的命令。

在 `approvalMode = "never"` 时，Codex 无法通过审批流程临时离开沙箱，所以这些操作不会转为用户确认，而会直接失败或退化为无法继续。

## 当前实现

Termflow 当前在 `src/lib/agents.ts` 中分别映射审批模式与沙箱模式：

```ts
if (codexOptions?.yolo) {
  parts.push("--dangerously-bypass-approvals-and-sandbox");
} else {
  if (codexOptions?.approvalMode && codexOptions.approvalMode !== "untrusted") {
    parts.push(`--ask-for-approval ${codexOptions.approvalMode}`);
  }
  if (codexOptions?.sandboxMode && codexOptions.sandboxMode !== "workspace-write") {
    parts.push(`--sandbox ${codexOptions.sandboxMode}`);
  }
}
```

上述界面组合生成的命令近似为：

```powershell
codex --ask-for-approval never
```

Termflow 将 `workspace-write` 当作 CLI 默认值，因此没有显式传递 `--sandbox workspace-write`。

这里还有一个需要一并确认的配置优先级问题：如果用户的全局 Codex `config.toml` 已将 `sandbox_mode` 设置为其他值，Termflow 界面选择“工作区可写”但不显式传参，实际运行结果可能与界面显示不一致。

## 根因

### 1. 审批策略和沙箱能力是两个独立维度

`--ask-for-approval never` 只关闭审批请求，不会扩大文件或网络权限。它更接近“需要审批时自动拒绝”，而不是“需要审批时自动批准”。

### 2. `workspace-write` 默认关闭网络访问

Codex 启动的 `git`、`gh`、包管理器和其他子进程继承相同的沙箱边界。没有显式启用网络时，它们不能连接 GitHub。

### 3. `workspace-write` 仍保护 `.git`

普通项目文件可写不等于整个仓库目录都可写。Codex 的默认工作区沙箱会递归保护 `.git`，从而阻止 Git 索引、对象、引用等元数据的修改。

### 4. 当前界面缺少结果导向的说明

“永不询问审批”和“工作区可写”单独看都容易产生过度授权的错觉。界面没有直接说明该组合对网络、`.git` 和越界操作的具体影响。

## 官方行为依据

- [OpenAI Docs：Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security)
- [OpenAI Docs：Sandbox](https://learn.chatgpt.com/docs/sandboxing)

根据官方说明：

- 沙箱决定命令在技术上能访问哪些文件和网络资源；
- 审批策略决定何时暂停并请求越过这些边界；
- `workspace-write` 默认关闭网络访问；
- 默认可写根目录中的 `.git`、`.agents` 和 `.codex` 仍受只读保护；
- `--ask-for-approval never` 可与任意沙箱模式组合，但 Codex 只能在既定约束内尽力完成任务；
- 无审批、无沙箱的完整访问需要 `danger-full-access` 或 `--dangerously-bypass-approvals-and-sandbox`，并具有显著安全风险。

## 待办方案

### P1：修正文案与权限提示

- [ ] 将“永不询问审批”调整为更明确的文案，例如“永不询问（越界操作直接拒绝）”。
- [ ] 为审批模式增加简短说明，明确 `never` 不等于自动批准。
- [ ] 为“工作区可写”增加说明，明确网络默认关闭且 `.git` 等受保护目录仍可能只读。
- [ ] 当选择 `never + workspace-write` 时显示组合提示：Git 提交、同步和 GitHub CLI 操作可能无法执行。
- [ ] 所有新增用户可见文本同时加入 `zh-CN.json` 和 `en-US.json`，不继续在组件中硬编码。

### P1：保证界面选择与实际启动参数一致

- [ ] 确认 Codex CLI 参数与 `config.toml` 的优先级。
- [ ] 即使选择的是 Termflow 默认值，也显式传递 `--sandbox workspace-write` 和对应审批参数，避免用户全局配置覆盖界面选择。
- [ ] 为所有审批模式、沙箱模式和 YOLO 组合补充命令生成测试。
- [ ] 验证新建会话、恢复会话和快速命令使用相同的有效权限配置。

### P2：提供安全的 GitHub 网络访问选项

- [ ] 评估在新建会话中增加“允许沙箱内网络访问”开关。
- [ ] 开启时向 Codex 传递等价于以下配置的会话级参数：

  ```powershell
  codex --sandbox workspace-write `
    --ask-for-approval never `
    -c sandbox_workspace_write.network_access=true
  ```

- [ ] 在界面中说明：启用网络只能解决联网问题，不能解除 `.git` 只读保护。
- [ ] 评估是否支持网络域名限制，并优先仅允许 GitHub 所需域名，而不是默认开放任意网络目标。
- [ ] 检查 GitHub HTTPS、SSH、Git Credential Manager 和 `gh` 登录态在 Windows 沙箱中的兼容性。

### P2：为 Git 写操作提供明确策略

- [ ] 明确产品是否允许 Codex 在非 YOLO 模式下自行修改 `.git`。
- [ ] 如果仍需审批，推荐组合应保持为 `on-request + workspace-write`，由 Codex在执行 Git 写操作或联网操作时申请临时授权。
- [ ] 如果要支持真正的无人值守 Git 提交/推送，必须提供高风险确认，并明确其等价于扩大或取消沙箱边界。
- [ ] 不要把“允许 GitHub”与“允许任意工作区外访问”合并成含义模糊的单一开关。

## 推荐默认行为

Termflow 推荐默认保持：

```text
审批模式：按需审批
沙箱模式：工作区可写
YOLO：关闭
```

该组合允许 Codex 自动完成工作区内的常规编辑，并在 Git 写操作、GitHub 网络访问或其他越界操作前请求用户确认。

`never + workspace-write` 应被定位为“非交互、受限执行”，适合不需要联网或修改 Git 元数据的任务，而不应被描述为全自动 Git/GitHub 模式。

## 验收标准

- [ ] 用户在新建会话界面可以直接理解 `never` 是“拒绝审批”，而不是“自动批准”。
- [ ] `never + workspace-write` 组合明确提示网络和 Git 写操作限制。
- [ ] Termflow 界面显示的审批/沙箱选择与 Codex `/status` 展示的有效配置一致。
- [ ] 用户全局 `config.toml` 不会静默改变 Termflow 已显式选择的会话权限。
- [ ] `on-request + workspace-write` 下，普通文件编辑无需审批，Git/GitHub 越界操作可以正常发起审批。
- [ ] 如果增加网络开关，关闭时 GitHub 访问失败，开启时 GitHub 网络访问成功，且 `.git` 保护状态符合界面说明。
- [ ] YOLO 仍需显著风险提示，且开启后不会同时传递相互冲突的审批或沙箱参数。
- [ ] 新增逻辑具备 Vitest 覆盖，`pnpm test` 与 `pnpm build` 通过。

## 建议涉及文件

- `src/components/NewSessionDialog.tsx`
- `src/lib/agents.ts`
- `src/lib/agents.test.ts`
- `src/types/index.ts`
- `src/locales/zh-CN.json`
- `src/locales/en-US.json`
- 会话权限默认值及持久化相关 store slice（实施时进一步确认）

## GitHub 上传前检查

- [ ] 确认待办范围和优先级。
- [ ] 决定以仓库文档、GitHub Issue，还是两者同时维护。
- [ ] 如创建 GitHub Issue，在标题中保留“Codex never approval mode”关键词，便于英文检索。
- [ ] 上传前检查文档中的 CLI 参数是否与项目当前使用的 Codex CLI 版本一致。
- [ ] 提交时使用约定式提交，例如：

  ```text
  docs(codex): document Git access limitations in never approval mode
  ```

## 待确认问题

1. 产品目标是只修正文案，还是还要支持 `never + workspace-write` 下的 GitHub 网络访问？
2. 是否允许在非 YOLO 模式下修改 `.git`，还是所有 Git 写操作都必须保留审批？
3. GitHub 网络访问需要覆盖 HTTPS、SSH 和 `gh` CLI，还是只支持其中一种认证路径？
4. 后续是否需要将本文内容同步创建为 GitHub Issue，并在文档中回填 Issue 链接？
