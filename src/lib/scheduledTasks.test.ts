import { expect, it } from "vitest";
import dayjs from "dayjs";
import {
  DEFAULT_SCHEDULED_TASK_TIMEOUT_MS,
  createScheduledTaskInput,
  getLatestRunByTask,
  isScheduledTaskRunActive,
  parseScheduledTaskLog,
  taskTimeToTimestamp,
  taskTimestampToTime,
} from "./scheduledTasks";
import type { ScheduledTaskRun } from "@/types";

it("extracts markdown from saved agent logs without metadata or duplicated CLI output", () => {
  const markdown = "**新增功能**\n\n| 功能 | 说明 |\n|---|---|\n| 定时任务 | 代码巡查 |\n\n```sh\ngit status\n```";
  const log = `status: succeeded\r\nexitCode: 0\r\n\r\n--- output ---\r\n${markdown}\n\n--- stderr ---\nOpenAI Codex\n${markdown}`;
  expect(parseScheduledTaskLog(log)).toEqual({
    output: markdown,
    diagnostics: `OpenAI Codex\n${markdown}`,
  });
});

it("does not display status metadata as task output when execution produced nothing", () => {
  expect(parseScheduledTaskLog("status: failed\nexitCode: 1\nerror: launch failed\n")).toEqual({ output: "", diagnostics: "" });
  expect(parseScheduledTaskLog("")).toEqual({ output: "", diagnostics: "" });
});

it("retains plain legacy output and stderr-only diagnostics", () => {
  expect(parseScheduledTaskLog("# Report\n\nDone").output).toBe("# Report\n\nDone");
  expect(parseScheduledTaskLog("status: failed\n\n--- output ---\n\n--- stderr ---\nAccess denied")).toEqual({ output: "", diagnostics: "Access denied" });
});

it("creates a safe default for a new scheduled task", () => {
  const task = createScheduledTaskInput("D:/projects/termflow");

  expect(task.projectPath).toBe("D:/projects/termflow");
  expect(task.agentId).toBe("codex");
  expect(task.schedule).toEqual({ kind: "daily", time: "09:00" });
  expect(task.timeoutMs).toBe(DEFAULT_SCHEDULED_TASK_TIMEOUT_MS);
  expect(task.notificationPolicy).toBe("failures");
});

it("treats only queued and running task runs as active", () => {
  expect(isScheduledTaskRunActive("queued")).toBe(true);
  expect(isScheduledTaskRunActive("running")).toBe(true);
  expect(isScheduledTaskRunActive("succeeded")).toBe(false);
  expect(isScheduledTaskRunActive("cancelled")).toBe(false);
});

it("keeps the newest run for each task", () => {
  const runs = [
    { taskId: "task-a", createdAtMs: 10 },
    { taskId: "task-a", createdAtMs: 20 },
    { taskId: "task-b", createdAtMs: 15 },
  ] as ScheduledTaskRun[];

  const latest = getLatestRunByTask(runs);
  expect(latest.get("task-a")?.createdAtMs).toBe(20);
  expect(latest.get("task-b")?.createdAtMs).toBe(15);
});

it("interprets a one-time task's wall time in its saved timezone", () => {
  const timestamp = taskTimeToTimestamp(dayjs("2026-09-13 09:00"), "America/New_York");

  expect(timestamp).toBe(Date.UTC(2026, 8, 13, 13, 0, 0));
  expect(taskTimestampToTime(timestamp!, "America/New_York").format("YYYY-MM-DD HH:mm")).toBe("2026-09-13 09:00");
});

it("rejects an invalid one-time task timezone", () => {
  expect(taskTimeToTimestamp(dayjs("2026-09-13 09:00"), "not/a-timezone")).toBeNull();
});
