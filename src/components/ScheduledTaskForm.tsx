import {
  Alert,
  Button,
  Collapse,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Spin,
} from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  createScheduledTask,
  inspectAgentClis,
  previewScheduledTaskRuns,
  updateScheduledTask,
} from "@/lib/api";
import {
  createScheduledTaskInput,
  getScheduledTaskInput,
  taskTimeToTimestamp,
  taskTimestampToTime,
} from "@/lib/scheduledTasks";
import { refreshScheduledTasks } from "@/store/slices/scheduledTasks";
import type {
  AgentCliInfo,
  ScheduledTask,
  ScheduledTaskExecutionKind,
  ScheduledTaskInput,
  ScheduledTaskNotificationPolicy,
  ScheduledTaskSchedule,
} from "@/types";

interface ProjectOption {
  path: string;
  name: string;
}

interface ScheduledTaskFormProps {
  task: ScheduledTask | null;
  projects: ProjectOption[];
  currentProjectPath: string | null;
  onSaved: () => void;
  onCancel: () => void;
}

interface TaskFormValues {
  projectPath: string;
  name: string;
  executionKind: ScheduledTaskExecutionKind;
  agentId: string | null;
  prompt: string | null;
  command: string | null;
  shell: "powershell" | "cmd" | null;
  scheduleKind: ScheduledTaskSchedule["kind"];
  runAt: Dayjs | null;
  intervalMinutes: number;
  anchorAtMs: number | null;
  time: string;
  weekday: number;
  timezone: string;
  timeoutMinutes: number;
  missedRunPolicy: ScheduledTaskInput["missedRunPolicy"];
  notificationPolicy: ScheduledTaskNotificationPolicy;
}

function getInitialValues(task: ScheduledTask | null, currentProjectPath: string | null): TaskFormValues {
  const input = task ? getScheduledTaskInput(task) : createScheduledTaskInput(currentProjectPath ?? "");
  const schedule = input.schedule;
  return {
    projectPath: input.projectPath,
    name: input.name,
    executionKind: input.executionKind,
    agentId: input.agentId,
    prompt: input.prompt,
    command: input.command,
    shell: input.shell,
    scheduleKind: schedule.kind,
    runAt: schedule.kind === "once"
      ? taskTimestampToTime(schedule.runAtMs, input.timezone)
      : dayjs().add(30, "minute"),
    intervalMinutes: schedule.kind === "interval" ? schedule.intervalMinutes : 60,
    anchorAtMs: schedule.kind === "interval" ? schedule.anchorAtMs : null,
    time: schedule.kind === "daily" || schedule.kind === "weekly" ? schedule.time : "09:00",
    weekday: schedule.kind === "weekly" ? schedule.weekday : 1,
    timezone: input.timezone,
    timeoutMinutes: Math.round(input.timeoutMs / 60_000),
    missedRunPolicy: input.missedRunPolicy,
    notificationPolicy: input.notificationPolicy,
  };
}

function getSchedule(values: TaskFormValues): ScheduledTaskSchedule | null {
  switch (values.scheduleKind) {
    case "once": {
      if (!values.runAt) return null;
      const runAtMs = taskTimeToTimestamp(values.runAt, values.timezone);
      return runAtMs === null ? null : { kind: "once", runAtMs };
    }
    case "interval":
      return {
        kind: "interval",
        intervalMinutes: values.intervalMinutes,
        anchorAtMs: values.anchorAtMs ?? Date.now() + values.intervalMinutes * 60_000,
      };
    case "daily":
      return { kind: "daily", time: values.time };
    case "weekly":
      return { kind: "weekly", weekday: values.weekday, time: values.time };
  }
}

function formatPreviewTime(timestamp: number, locale: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone || undefined,
    }).format(timestamp);
  } catch {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(timestamp);
  }
}

function isFormValidationError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "errorFields" in error;
}

export function ScheduledTaskForm({
  task,
  projects,
  currentProjectPath,
  onSaved,
  onCancel,
}: ScheduledTaskFormProps) {
  const { t, i18n } = useTranslation();
  const [form] = Form.useForm<TaskFormValues>();
  const [agents, setAgents] = useState<AgentCliInfo[] | null>(null);
  const [agentLoadError, setAgentLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [preview, setPreview] = useState<number[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [formRevision, setFormRevision] = useState(0);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const executionKind = Form.useWatch("executionKind", form) ?? "agent";
  const scheduleKind = Form.useWatch("scheduleKind", form) ?? "daily";

  const initialValues = useMemo(
    () => getInitialValues(task, currentProjectPath),
    [currentProjectPath, task],
  );

  useEffect(() => {
    form.setFieldsValue(initialValues);
    setFormRevision((revision) => revision + 1);
  }, [form, initialValues]);

  useEffect(() => {
    let disposed = false;
    setAgentLoadError(null);
    void inspectAgentClis()
      .then((result) => {
        if (!disposed) setAgents(result);
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setAgentLoadError(error instanceof Error ? error.message : String(error));
          setAgents([]);
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const values = form.getFieldsValue();
      const schedule = getSchedule(values);
      if (!schedule || !values.timezone.trim()) {
        setPreview([]);
        setPreviewError(null);
        return;
      }
      void previewScheduledTaskRuns(schedule, values.timezone, 3)
        .then((runs) => {
          setPreview(runs);
          setPreviewError(null);
        })
        .catch((error: unknown) => {
          setPreview([]);
          setPreviewError(error instanceof Error ? error.message : String(error));
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [form, formRevision]);

  const projectOptions = projects.map((project) => ({
    value: project.path,
    label: project.name,
  }));
  const agentOptions = (agents ?? []).map((agent) => ({
    value: agent.id,
    disabled: !agent.installed || agent.id !== "codex",
    label: agent.id === "codex"
      ? agent.name
      : `${agent.name} · ${t("scheduledTasks.agentNotSupported")}`,
  }));

  async function handleSubmit() {
    setSaveError(null);
    try {
      const values = await form.validateFields();
      const schedule = getSchedule(values);
      if (!schedule) {
        form.setFields([{ name: "runAt", errors: [t("scheduledTasks.runAtRequired")] }]);
        return;
      }
      const input: ScheduledTaskInput = {
        projectPath: values.projectPath,
        name: values.name,
        executionKind: values.executionKind,
        agentId: values.executionKind === "agent" ? (values.agentId as "codex" | null) : null,
        prompt: values.executionKind === "agent" ? values.prompt : null,
        command: values.executionKind === "command" ? values.command : null,
        shell: values.executionKind === "command" ? values.shell : null,
        schedule,
        timezone: values.timezone,
        enabled: task?.enabled ?? true,
        timeoutMs: values.timeoutMinutes * 60_000,
        missedRunPolicy: values.missedRunPolicy,
        notificationPolicy: values.notificationPolicy,
      };
      setSaving(true);
      if (task) {
        await updateScheduledTask(task.id, input);
      } else {
        await createScheduledTask(input);
      }
      await refreshScheduledTasks();
      onSaved();
    } catch (error: unknown) {
      if (isFormValidationError(error)) return;
      const message = error instanceof Error ? error.message : String(error);
      if (message) setSaveError(message);
    } finally {
      setSaving(false);
    }
  }

  function handleValuesChange(changed: Partial<TaskFormValues>, values: TaskFormValues) {
    if (changed.executionKind === "command" && !values.shell) {
      form.setFieldValue("shell", "powershell");
    }
    setFormRevision((revision) => revision + 1);
  }

  function handleCancel() {
    if (!form.isFieldsTouched()) {
      onCancel();
      return;
    }
    setDiscardConfirmOpen(true);
  }

  function handleDiscardConfirm() {
    setDiscardConfirmOpen(false);
    onCancel();
  }

  return (
    <section className="app-scheduled-form" aria-label={task ? t("scheduledTasks.editTask") : t("scheduledTasks.newTask")}>
      <div className="app-scheduled-form-header">
        <div>
          <h2>{task ? t("scheduledTasks.editTask") : t("scheduledTasks.newTask")}</h2>
          <p>{t("scheduledTasks.formDescription")}</p>
        </div>
      </div>
      {saveError && <Alert className="mb-4" type="error" showIcon message={saveError} />}
      {agentLoadError && <Alert className="mb-4" type="warning" showIcon message={agentLoadError} />}
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={initialValues}
        onValuesChange={handleValuesChange}
      >
        <div className="app-scheduled-form-grid">
          <Form.Item
            label={t("scheduledTasks.taskName")}
            name="name"
            rules={[{ required: true, whitespace: true, message: t("scheduledTasks.taskNameRequired") }]}
          >
            <Input maxLength={160} placeholder={t("scheduledTasks.taskNamePlaceholder")} autoFocus />
          </Form.Item>
          <Form.Item
            label={t("scheduledTasks.project")}
            name="projectPath"
            rules={[{ required: true, message: t("scheduledTasks.projectRequired") }]}
          >
            <Select options={projectOptions} placeholder={t("scheduledTasks.projectPlaceholder")} />
          </Form.Item>
        </div>

        <div className="app-scheduled-form-grid">
          <Form.Item label={t("scheduledTasks.taskType")} name="executionKind">
            <Select<ScheduledTaskExecutionKind>
              options={[
                { value: "agent", label: t("scheduledTasks.agentTask") },
                { value: "command", label: t("scheduledTasks.commandTask") },
              ]}
            />
          </Form.Item>
          {executionKind === "agent" ? (
            <Form.Item
              label={t("scheduledTasks.agent")}
              name="agentId"
              rules={[{ required: true, message: t("scheduledTasks.agentRequired") }]}
            >
              <Select
                loading={agents === null}
                notFoundContent={agents === null ? <Spin size="small" /> : t("scheduledTasks.noCompatibleAgents")}
                options={agentOptions}
                placeholder={t("scheduledTasks.agentPlaceholder")}
              />
            </Form.Item>
          ) : (
            <Form.Item label={t("scheduledTasks.shell")} name="shell" rules={[{ required: true }]}> 
              <Select options={[
                { value: "powershell", label: t("scheduledTasks.shellPowerShell") },
                { value: "cmd", label: t("scheduledTasks.shellCmd") },
              ]} />
            </Form.Item>
          )}
        </div>

        {executionKind === "agent" ? (
          <>
            <Alert className="mb-4" type="info" showIcon message={t("scheduledTasks.codexReadOnlyHint")} />
            <Form.Item
              label={t("scheduledTasks.prompt")}
              name="prompt"
              rules={[{ required: true, whitespace: true, message: t("scheduledTasks.promptRequired") }]}
            >
              <Input.TextArea rows={4} maxLength={64 * 1024} placeholder={t("scheduledTasks.promptPlaceholder")} />
            </Form.Item>
          </>
        ) : (
          <Form.Item
            label={t("scheduledTasks.command")}
            name="command"
            rules={[{ required: true, whitespace: true, message: t("scheduledTasks.commandRequired") }]}
          >
            <Input.TextArea rows={4} maxLength={64 * 1024} placeholder={t("scheduledTasks.commandPlaceholder")} />
          </Form.Item>
        )}

        <div className="app-scheduled-form-section-title">{t("scheduledTasks.schedule")}</div>
        <div className="app-scheduled-form-grid">
          <Form.Item label={t("scheduledTasks.scheduleType")} name="scheduleKind">
            <Select<ScheduledTaskSchedule["kind"]>
              options={[
                { value: "once", label: t("scheduledTasks.once") },
                { value: "interval", label: t("scheduledTasks.interval") },
                { value: "daily", label: t("scheduledTasks.daily") },
                { value: "weekly", label: t("scheduledTasks.weekly") },
              ]}
            />
          </Form.Item>
          <Form.Item
            label={t("scheduledTasks.timezone")}
            name="timezone"
            rules={[{ required: true, whitespace: true, message: t("scheduledTasks.timezoneRequired") }]}
          >
            <Input placeholder={t("scheduledTasks.timezonePlaceholder")} />
          </Form.Item>
        </div>
        {scheduleKind === "once" && (
          <Form.Item label={t("scheduledTasks.runAt")} name="runAt" rules={[{ required: true, message: t("scheduledTasks.runAtRequired") }]}>
            <DatePicker showTime className="w-full" format="YYYY-MM-DD HH:mm" />
          </Form.Item>
        )}
        {scheduleKind === "interval" && (
          <Form.Item label={t("scheduledTasks.intervalMinutes")} name="intervalMinutes" rules={[{ required: true, message: t("scheduledTasks.intervalRequired") }]}>
            <InputNumber min={1} max={7 * 24 * 60} className="w-full" addonAfter={t("scheduledTasks.minutes")} />
          </Form.Item>
        )}
        {(scheduleKind === "daily" || scheduleKind === "weekly") && (
          <div className="app-scheduled-form-grid">
            {scheduleKind === "weekly" && (
              <Form.Item label={t("scheduledTasks.weekday")} name="weekday">
                <Select options={[
                  { value: 1, label: t("scheduledTasks.weekdays.mon") },
                  { value: 2, label: t("scheduledTasks.weekdays.tue") },
                  { value: 3, label: t("scheduledTasks.weekdays.wed") },
                  { value: 4, label: t("scheduledTasks.weekdays.thu") },
                  { value: 5, label: t("scheduledTasks.weekdays.fri") },
                  { value: 6, label: t("scheduledTasks.weekdays.sat") },
                  { value: 7, label: t("scheduledTasks.weekdays.sun") },
                ]} />
              </Form.Item>
            )}
            <Form.Item label={t("scheduledTasks.time")} name="time" rules={[{ required: true, message: t("scheduledTasks.timeRequired") }]}>
              <Input type="time" />
            </Form.Item>
          </div>
        )}

        <div className="app-scheduled-preview" aria-live="polite">
          <span>{t("scheduledTasks.nextRuns")}</span>
          {previewError ? (
            <span className="app-scheduled-preview-error">{previewError}</span>
          ) : preview.length > 0 ? (
            <div className="app-scheduled-preview-values">
              {preview.map((timestamp) => (
                <span key={timestamp}>{formatPreviewTime(
                  timestamp,
                  i18n.language,
                  form.getFieldValue("timezone") || "",
                )}</span>
              ))}
            </div>
          ) : <span className="app-scheduled-muted">{t("scheduledTasks.noNextRuns")}</span>}
        </div>

        <Collapse
          className="app-scheduled-advanced"
          items={[{
            key: "advanced",
            label: t("scheduledTasks.advanced"),
            children: (
              <div className="app-scheduled-form-grid">
                <Form.Item label={t("scheduledTasks.timeout")} name="timeoutMinutes">
                  <InputNumber min={1} max={4 * 60} className="w-full" addonAfter={t("scheduledTasks.minutes")} />
                </Form.Item>
                <Form.Item label={t("scheduledTasks.missedRunPolicy")} name="missedRunPolicy">
                  <Select options={[
                    { value: "skip", label: t("scheduledTasks.missedSkip") },
                    { value: "runOnceWithinGrace", label: t("scheduledTasks.missedRunOnce") },
                  ]} />
                </Form.Item>
                <Form.Item label={t("scheduledTasks.notificationPolicy")} name="notificationPolicy">
                  <Select options={[
                    { value: "failures", label: t("scheduledTasks.notifyFailures") },
                    { value: "all", label: t("scheduledTasks.notifyAll") },
                    { value: "none", label: t("scheduledTasks.notifyNone") },
                  ]} />
                </Form.Item>
              </div>
            ),
          }]}
        />
        <div className="app-scheduled-form-actions">
          <Button onClick={handleCancel}>{t("common.cancel")}</Button>
          <Button type="primary" loading={saving} onClick={() => void handleSubmit()}>
            {task ? t("scheduledTasks.saveChanges") : t("scheduledTasks.createTask")}
          </Button>
        </div>
      </Form>
      <Modal
        open={discardConfirmOpen}
        title={t("scheduledTasks.discardDraftTitle")}
        okText={t("scheduledTasks.discardDraft")}
        okType="danger"
        cancelText={t("common.cancel")}
        onCancel={() => setDiscardConfirmOpen(false)}
        onOk={handleDiscardConfirm}
      >
        {t("scheduledTasks.discardDraftDescription")}
      </Modal>
    </section>
  );
}
