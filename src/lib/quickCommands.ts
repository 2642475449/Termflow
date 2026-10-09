import type { AiAgentId, QuickCommandScope, TerminalQuickCommand } from "@/types";
import { isAiAgentId } from "@/lib/agents";

// ── 常量 ─────────────────────────────────────────────────────

export const MAX_QUICK_COMMANDS = 40;
export const MAX_QUICK_COMMAND_LABEL_LENGTH = 80;
export const MAX_QUICK_COMMAND_REPOSITORY_ID_LENGTH = 200;
export const MAX_QUICK_COMMAND_TEXT_LENGTH = 4000;

// ── 草稿创建 ─────────────────────────────────────────────────

/**
 * 创建一个新的快速命令草稿，带 UUID 标识
 */
export function createQuickCommandDraft(
  scope: QuickCommandScope = { type: "global" },
): TerminalQuickCommand {
  return {
    id: `quick-command-${crypto.randomUUID()}`,
    label: "",
    scope,
    action: "terminal-command",
    command: "",
    appendEnter: true,
  };
}

// ── 规范化 ───────────────────────────────────────────────────

/**
 * 规范化单个作用域
 * - 缺失或非法作用域回退为全局
 * - 空仓库 ID 回退为全局
 * - 仓库 ID 截断到最大长度
 */
function normalizeScope(input: unknown): QuickCommandScope {
  if (
    input &&
    typeof input === "object" &&
    "type" in input &&
    (input as Record<string, unknown>).type === "repository"
  ) {
    const raw = input as Record<string, unknown>;
    const repoId = typeof raw.repositoryId === "string" ? raw.repositoryId.trim() : "";
    if (repoId.length > 0) {
      return {
        type: "repository",
        repositoryId: repoId.slice(0, MAX_QUICK_COMMAND_REPOSITORY_ID_LENGTH),
      };
    }
  }
  return { type: "global" };
}

function normalizeAgentId(input: unknown): AiAgentId | undefined {
  return isAiAgentId(input) ? input : undefined;
}

/**
 * 生成唯一 ID，处理重复冲突
 */
function resolveUniqueId(
  rawId: unknown,
  index: number,
  seenIds: Set<string>,
): string {
  let id =
    typeof rawId === "string" && rawId.trim().length > 0
      ? rawId.trim().slice(0, MAX_QUICK_COMMAND_LABEL_LENGTH)
      : `quick-command-${index}`;

  if (seenIds.has(id)) {
    let suffix = 2;
    while (seenIds.has(`${id}-${suffix}`)) {
      suffix++;
    }
    id = `${id}-${suffix}`;
  }
  seenIds.add(id);
  return id;
}

/**
 * 规范化快速命令数组
 *
 * 处理任意输入数据：
 * - 非数组输入返回空数组
 * - 非对象项丢弃
 * - ID 去重（保留首条，后续追加后缀）
 * - 字段截断到最大长度
 * - 作用域回退为全局
 * - appendEnter 默认 true
 * - 超出 MAX_QUICK_COMMANDS 的项丢弃
 */
export function normalizeQuickCommands(input: unknown): TerminalQuickCommand[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const result: TerminalQuickCommand[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < input.length && result.length < MAX_QUICK_COMMANDS; i++) {
    const item = input[i];
    if (!item || typeof item !== "object") {
      continue;
    }

    const raw = item as Record<string, unknown>;

    // 解析并去重 ID
    const id = resolveUniqueId(raw.id, i, seenIds);

    // 解析标签
    const label =
      typeof raw.label === "string"
        ? raw.label.trim().slice(0, MAX_QUICK_COMMAND_LABEL_LENGTH)
        : "";

    // 解析命令
    const command =
      typeof raw.command === "string"
        ? raw.command.trimEnd().slice(0, MAX_QUICK_COMMAND_TEXT_LENGTH)
        : "";

    // 跳过既没有标签也没有命令的不完整项
    if (label.length === 0 && command.length === 0) {
      continue;
    }

    // 作用域
    const scope = normalizeScope(raw.scope);

    // appendEnter：只有显式 false 才关闭
    const action = raw.action === "agent-prompt" ? "agent-prompt" : "terminal-command";
    const appendEnter = raw.appendEnter !== false;
    const agentId = action === "agent-prompt" ? normalizeAgentId(raw.agentId) : undefined;

    result.push({
      id,
      label,
      scope,
      action,
      command,
      appendEnter,
      agentId,
    });
  }

  return result;
}

// ── 作用域匹配 ───────────────────────────────────────────────

/**
 * 检查命令是否在给定仓库上下文中可见
 * - 全局命令始终可见
 * - 仓库命令仅在 repositoryId 匹配时可见
 * - repositoryId 为 null 时只显示全局命令
 */
export function quickCommandMatchesRepository(
  command: TerminalQuickCommand,
  repositoryId: string | null,
): boolean {
  if (command.scope.type === "global") {
    return true;
  }
  return repositoryId !== null && command.scope.repositoryId === repositoryId;
}

// ── 完整性检查 ───────────────────────────────────────────────

/**
 * 检查命令是否可运行（标签和命令都非空）
 */
export function isQuickCommandComplete(command: TerminalQuickCommand): boolean {
  if (command.label.trim().length === 0 || command.command.trimEnd().length === 0) {
    return false;
  }
  if (command.action === "agent-prompt") {
    return isAiAgentId(command.agentId);
  }
  return true;
}

// ── 多行命令扁平化 ──────────────────────────────────────────

/**
 * 将多行命令扁平化为单行
 *
 * 按 \r\n、\r、\n 拆分，去除每行两端空白，删除空行，用 "; " 连接。
 * 这是安全约束：多个独立 shell 命令必须作为命令列表发送，
 * 避免前台程序把后续行读取为标准输入。
 */
export function flattenQuickCommand(command: string): string {
  return command
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("; ");
}

// ── 获取命令正文 ─────────────────────────────────────────────

/**
 * 获取命令的正文内容（用于搜索和显示）
 */
export function getQuickCommandBody(command: TerminalQuickCommand): string {
  return command.command;
}
