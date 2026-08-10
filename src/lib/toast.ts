import {
  createElement,
  useEffect,
  useState,
  type CSSProperties,
  type Key,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  App as AntdApp,
  notification as staticNotification,
  type NotificationArgsProps,
} from "antd/es/index.js";
import type {
  NotificationConfig,
  NotificationInstance,
} from "antd/es/notification/interface";
import i18n from "@/i18n";

export type ToastLevel = "success" | "info" | "warning" | "error";

export interface ToastOptions {
  content: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  key?: Key;
  duration?: number;
  onClose?: () => void;
  onClick?: () => void;
  icon?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export type ToastInput = ReactNode | ToastOptions;

export const TOAST_TEXT_LIMIT = 300;

export function truncateToastText(text: string): string {
  if (text.length <= TOAST_TEXT_LIMIT) return text;
  return `${text.slice(0, TOAST_TEXT_LIMIT - 1).trimEnd()}…`;
}

const DEFAULT_DURATION: Record<ToastLevel, number> = {
  success: 3,
  info: 5,
  warning: 8,
  error: 8,
};

export const TOAST_NOTIFICATION_CONFIG: NotificationConfig = {
  placement: "bottomRight",
  bottom: 20,
  maxCount: 3,
  stack: { threshold: 3 },
  pauseOnHover: true,
};

let notificationApi: NotificationInstance = staticNotification;

function ExpandableToastText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyText = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return createElement(
    "div",
    {
      onClick: () => setExpanded((value) => !value),
      role: "button",
      tabIndex: 0,
      title: i18n.t(expanded ? "common.collapse" : "common.expand"),
      style: {
        cursor: "pointer",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      },
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setExpanded((value) => !value);
        }
      },
    },
    createElement(
      "div",
      {
        style: expanded
          ? { maxHeight: "50vh", overflowY: "auto" }
          : undefined,
      },
      expanded ? text : truncateToastText(text),
    ),
    createElement(
      "div",
      {
        style: {
          display: "flex",
          gap: 12,
          marginTop: 8,
          fontSize: 12,
        },
      },
      createElement(
        "span",
        { style: { color: "var(--ant-color-primary)" } },
        i18n.t(expanded ? "common.collapse" : "common.expand"),
      ),
      createElement(
        "button",
        {
          type: "button",
          onClick: copyText,
          style: {
            appearance: "none",
            border: 0,
            padding: 0,
            background: "transparent",
            color: "var(--ant-color-primary)",
            cursor: "pointer",
            font: "inherit",
          },
        },
        i18n.t(copied ? "common.copied" : "common.copy"),
      ),
    ),
  );
}

export function guardToastText(content: ReactNode): ReactNode {
  if (typeof content !== "string" || content.length <= TOAST_TEXT_LIMIT) {
    return content;
  }
  return createElement(ExpandableToastText, { text: content });
}

function isToastOptions(input: ToastInput): input is ToastOptions {
  return Boolean(
    input
      && typeof input === "object"
      && !Array.isArray(input)
      && "content" in input,
  );
}

export function createToastArgs(
  level: ToastLevel,
  input: ToastInput,
): NotificationArgsProps {
  const options: ToastOptions = isToastOptions(input) ? input : { content: input };
  const hasTitle = options.title !== undefined;
  const duration = options.duration ?? DEFAULT_DURATION[level];

  return {
    message: guardToastText(hasTitle ? options.title : options.content),
    description: hasTitle
      ? guardToastText(options.description ?? options.content)
      : guardToastText(options.description),
    key: options.key,
    duration,
    onClose: options.onClose,
    onClick: options.onClick,
    icon: options.icon,
    className: options.className,
    style: options.style,
    placement: "bottomRight",
    pauseOnHover: duration > 0,
    showProgress: duration > 0,
    role: level === "error" ? "alert" : "status",
  };
}

function show(level: ToastLevel, input: ToastInput) {
  notificationApi[level](createToastArgs(level, input));
}

export interface ToastMessageApi {
  success: (input: ToastInput) => void;
  info: (input: ToastInput) => void;
  warning: (input: ToastInput) => void;
  error: (input: ToastInput) => void;
  open: (input: ToastInput) => void;
  destroy: (key?: Key) => void;
  useMessage: () => readonly [ToastMessageApi, ReactNode];
}

export const message: ToastMessageApi = {
  success: (input) => show("success", input),
  info: (input) => show("info", input),
  warning: (input) => show("warning", input),
  error: (input) => show("error", input),
  open: (input) => show("info", input),
  destroy: (key) => notificationApi.destroy(key),
  useMessage: () => [message, null] as const,
};

export function ToastHost() {
  const { notification } = AntdApp.useApp();

  useEffect(() => {
    notificationApi = notification;
    return () => {
      notificationApi = staticNotification;
    };
  }, [notification]);

  return null;
}
