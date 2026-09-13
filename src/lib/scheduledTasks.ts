import dayjs, { type Dayjs } from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import type {
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskRun,
  ScheduledTaskRunStatus,
} from "@/types";

dayjs.extend(utc);
dayjs.extend(timezone);

export const SCHEDULED_TASKS_TAB_ID = "__scheduled_tasks__";
export const SCHEDULED_TASKS_CHANGED_EVENT = "termflow:scheduled-tasks-changed";
export const DEFAULT_SCHEDULED_TASK_TIMEOUT_MS = 30 * 60 * 1000;

export function getSystemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function taskTimestampToTime(timestamp: number, timezoneName: string): Dayjs {
  try {
    return dayjs(timestamp).tz(timezoneName);
  } catch {
    return dayjs(timestamp);
  }
}

export function taskTimeToTimestamp(value: Dayjs, timezoneName: string): number | null {
  try {
    const interpreted = dayjs.tz(value.format("YYYY-MM-DD HH:mm"), timezoneName);
    return interpreted.isValid() ? interpreted.valueOf() : null;
  } catch {
    return null;
  }
}

export function createScheduledTaskInput(projectPath: string): ScheduledTaskInput {
  return {
    projectPath,
    name: "",
    executionKind: "agent",
    agentId: "codex",
    prompt: "",
    command: null,
    shell: null,
    schedule: {
      kind: "daily",
      time: "09:00",
    },
    timezone: getSystemTimeZone(),
    enabled: true,
    timeoutMs: DEFAULT_SCHEDULED_TASK_TIMEOUT_MS,
    missedRunPolicy: "skip",
    notificationPolicy: "failures",
  };
}

export function getScheduledTaskInput(task: ScheduledTask): ScheduledTaskInput {
  return {
    projectPath: task.projectPath,
    name: task.name,
    executionKind: task.executionKind,
    agentId: task.agentId,
    prompt: task.prompt,
    command: task.command,
    shell: task.shell,
    schedule: task.schedule,
    timezone: task.timezone,
    enabled: task.enabled,
    timeoutMs: task.timeoutMs,
    missedRunPolicy: task.missedRunPolicy,
    notificationPolicy: task.notificationPolicy,
  };
}

export function isScheduledTaskFinished(task: ScheduledTask): boolean {
  return task.schedule.kind === "once" && !task.enabled && task.nextRunAtMs === null;
}

/** 分离持久化日志的包装信息、任务正文与 CLI 诊断，兼容已有运行记录。 */
export function parseScheduledTaskLog(log: string): { output: string; diagnostics: string } {
  const normalized = log.replace(/\r\n/g, "\n");
  const outputMarker = "\n--- output ---\n";
  const outputStart = normalized.indexOf(outputMarker);
  const body = /^status: [a-z_]+\n/.test(normalized)
    ? outputStart >= 0 ? normalized.slice(outputStart + outputMarker.length) : ""
    : normalized;
  const stderrMarker = "\n--- stderr ---\n";
  const stderrStart = body.indexOf(stderrMarker);
  return stderrStart < 0
    ? { output: body.trim(), diagnostics: "" }
    : {
        output: body.slice(0, stderrStart).trim(),
        diagnostics: body.slice(stderrStart + stderrMarker.length).trim(),
      };
}

export function isScheduledTaskRunActive(status: ScheduledTaskRunStatus): boolean {
  return status === "queued" || status === "running";
}

export function getLatestRunByTask(runs: ScheduledTaskRun[]): Map<string, ScheduledTaskRun> {
  const latest = new Map<string, ScheduledTaskRun>();
  for (const run of runs) {
    const previous = latest.get(run.taskId);
    if (!previous || run.createdAtMs > previous.createdAtMs) {
      latest.set(run.taskId, run);
    }
  }
  return latest;
}
