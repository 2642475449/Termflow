import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  SettingOutlined,
  CodeOutlined,
  FontSizeOutlined,
  InfoCircleOutlined,
  ThunderboltOutlined,
  ApiOutlined,
  CheckOutlined,
  SoundOutlined,
  NotificationOutlined,
  PlayCircleOutlined,
  AppstoreOutlined,
  ReloadOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  SearchOutlined,
  LeftOutlined,
  RightOutlined,
  DeleteOutlined,
  InboxOutlined,
  FileMarkdownOutlined,
  CloudServerOutlined,
  EditOutlined,
  NodeIndexOutlined,
  RobotOutlined,
  GlobalOutlined,
  GithubOutlined,
  SafetyCertificateOutlined,
  DatabaseOutlined,
} from "@ant-design/icons";
import { Segmented, Typography, Tag, Select, Spin, Empty, Button, message, Switch, Input, Drawer, Modal, Popconfirm, Tooltip, Popover } from "antd";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import {
  useAppStore,
  type ThemeMode,
  type ThemeCategory,
  type Language,
  type TerminalShell,
  DEFAULT_ASR_MODEL,
  DEFAULT_VOICE_SHORTCUT,
} from "@/store";
import { createSilentWavDataUrl, type MimoAuthMode } from "@/lib/mimoAsr";
import { captureShortcutFromEvent, formatShortcutDisplay, parseShortcut } from "@/lib/shortcut";
import { stripAnsiEscapeSequences } from "@/lib/textContent";
import { TERMINAL_SCROLLBACK_OPTIONS } from "@/lib/terminalSettings";
import {
  createSkill,
  createCommand,
  ensureSkillDirectory,
  ensureCommandStore,
  getSkillDetail,
  getCommandDetail,
  getAgentHookDetail,
  deleteCommand,
  deleteClaudeHook,
  listCommands,
  listSkills,
  listAgentHooks,
  repairAgentHooks,
  runCommandTest,
  setSkillEnabled,
  openInFileManager,
  updateCommand,
  listMcpServers,
  addMcpServer,
  updateMcpServer,
  deleteMcpServer,
  testMcpServer,
  setExplorerContextMenuEnabled,
} from "@/lib/api";
import type {
  SkillCatalog,
  SkillDetail,
  SkillAgent,
  SkillInfo,
  SkillScope,
  CommandCatalog,
  CommandCwdMode,
  CommandDetail,
  CommandDraft,
  CommandInfo,
  CommandScope,
  CommandShell,
  CommandTestResult,
  HookCatalog,
  HookDetail,
  HookAgent,
  HookInfo,
  HookScope,
  AiAgentId,
  McpServerType,
  McpServerCatalog,
  McpServerConfig,
  McpServerInfo,
} from "@/types";
import { SHORTCUTS } from "@/constants/shortcuts";
import ClaudeMdPage from "@/components/settings/ClaudeMdPage";
import { QuickCommandsPage } from "@/components/settings/QuickCommandsPage";
import { AgentIcon } from "@/components/AgentIcon";
import { AgentsPage } from "@/components/settings/AgentsPage";
import { ArchivedSessionsPage } from "@/components/settings/ArchivedSessionsPage";
import { DataPrivacyPage } from "@/components/settings/DataPrivacyPage";
import { SearchIndexPage } from "@/components/settings/SearchIndexPage";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";
import { NotificationsPage } from "@/components/settings/NotificationsPage";
import {
  AGENT_DEFINITIONS,
  AI_AGENT_ORDER,
  getAgentIdsWithCapability,
} from "@/lib/agents";
import packageJson from "../../package.json";

const { Text } = Typography;

// Fill in the website URL when it is ready.
const ABOUT_LINKS: Record<"website" | "github", string | null> = {
  website: null,
  github: "https://github.com/2642475449/Termflow",
};

type SettingsPage = "general" | "notifications" | "agents" | "terminal" | "voiceRecognition" | "shortcuts" | "skills" | "hooks" | "mcpServers" | "commands" | "quickCommands" | "claudeMd" | "searchIndex" | "dataPrivacy" | "archived" | "about";

interface SettingsMenuItem {
  key: SettingsPage;
  icon: React.ReactNode;
  labelKey: string;
}

interface SettingsMenuGroup {
  key: "basic" | "agentExtensions" | "data" | "about";
  labelKey: string;
  items: SettingsMenuItem[];
}

const menuGroups: SettingsMenuGroup[] = [
  {
    key: "basic",
    labelKey: "settings.menu.groups.basic",
    items: [
      { key: "general", icon: <SettingOutlined />, labelKey: "settings.menu.general" },
      { key: "notifications", icon: <NotificationOutlined />, labelKey: "settings.menu.notifications" },
      { key: "terminal", icon: <FontSizeOutlined />, labelKey: "settings.menu.terminal" },
      { key: "voiceRecognition", icon: <SoundOutlined />, labelKey: "settings.menu.voiceRecognition" },
      { key: "shortcuts", icon: <ThunderboltOutlined />, labelKey: "settings.menu.shortcuts" },
    ],
  },
  {
    key: "agentExtensions",
    labelKey: "settings.menu.groups.agentExtensions",
    items: [
      { key: "agents", icon: <RobotOutlined />, labelKey: "settings.menu.agents" },
      { key: "skills", icon: <AppstoreOutlined />, labelKey: "settings.menu.skills" },
      { key: "hooks", icon: <ApiOutlined />, labelKey: "settings.menu.hooks" },
      { key: "mcpServers", icon: <CloudServerOutlined />, labelKey: "settings.menu.mcpServers" },
      { key: "commands", icon: <CodeOutlined />, labelKey: "settings.menu.commands" },
      { key: "quickCommands", icon: <ThunderboltOutlined />, labelKey: "settings.menu.quickCommands" },
      { key: "claudeMd", icon: <FileMarkdownOutlined />, labelKey: "settings.menu.claudeMd" },
    ],
  },
  {
    key: "data",
    labelKey: "settings.menu.groups.data",
    items: [
      { key: "searchIndex", icon: <DatabaseOutlined />, labelKey: "settings.menu.searchIndex" },
      { key: "dataPrivacy", icon: <SafetyCertificateOutlined />, labelKey: "settings.menu.dataPrivacy" },
      { key: "archived", icon: <InboxOutlined />, labelKey: "settings.archived.title" },
    ],
  },
  {
    key: "about",
    labelKey: "settings.menu.groups.about",
    items: [
      { key: "about", icon: <InfoCircleOutlined />, labelKey: "settings.menu.about" },
    ],
  },
];

interface ThemeOption {
  key: ThemeMode;
  labelKey: string;
  descKey: string;
  accent: string;
  flow: AboutFlowHexPalette;
  category: "light" | "dark";
}

type AboutFlowHexPalette = {
  base: string;
  pale: string;
  vivid: string;
  cobalt: string;
  deep: string;
  highlight: string;
};

const themeOptions: ThemeOption[] = [
  {
    key: "dark-starry",
    labelKey: "settings.theme.dark-starry.label",
    descKey: "settings.theme.dark-starry.desc",
    accent: "#5c7ba3",
    flow: {
      base: "#101720",
      pale: "#5c7ba3",
      vivid: "#405b82",
      cobalt: "#263f5d",
      deep: "#090e14",
      highlight: "#8da2ba",
    },
    category: "dark",
  },
  {
    key: "dark-mocha",
    labelKey: "settings.theme.dark-mocha.label",
    descKey: "settings.theme.dark-mocha.desc",
    accent: "#f5bd69",
    flow: {
      base: "#24243a",
      pale: "#9a7448",
      vivid: "#66517d",
      cobalt: "#3f405f",
      deep: "#191929",
      highlight: "#b48a57",
    },
    category: "dark",
  },
  {
    key: "light-glass",
    labelKey: "settings.theme.light-glass.label",
    descKey: "settings.theme.light-glass.desc",
    accent: "#4f6cf7",
    flow: {
      base: "#fcfdff",
      pale: "#a3c2ff",
      vivid: "#6d7ff2",
      cobalt: "#2b52db",
      deep: "#14296f",
      highlight: "#e3edff",
    },
    category: "light",
  },
  {
    key: "light-warm",
    labelKey: "settings.theme.light-warm.label",
    descKey: "settings.theme.light-warm.desc",
    accent: "#c2713a",
    flow: {
      base: "#fffdf9",
      pale: "#efc7a4",
      vivid: "#c2713a",
      cobalt: "#99532d",
      deep: "#56301f",
      highlight: "#ffe5cc",
    },
    category: "light",
  },
];

/* ────────────── Theme Card (大预览) ────────────── */
function ThemeCard({ opt, isActive, onClick, tabIndex, onKeyDown }: {
  opt: ThemeOption;
  isActive: boolean;
  onClick: () => void;
  tabIndex: number;
  onKeyDown: React.KeyboardEventHandler<HTMLButtonElement>;
}) {
  const { t } = useTranslation();
  const isDark = opt.category === "dark";
  const preview = {
    app: opt.flow.base,
    chrome: isDark ? opt.flow.deep : `${opt.flow.pale}52`,
    sidebar: isDark ? `${opt.flow.deep}e8` : `${opt.flow.pale}36`,
    surface: isDark ? `${opt.flow.pale}16` : "#ffffffc7",
    terminal: isDark ? opt.flow.deep : `${opt.flow.highlight}cc`,
    primaryText: isDark ? "#f4f7fb" : "#25324a",
    secondaryText: isDark ? "#aebccd" : "#6d7890",
    border: isDark ? `${opt.flow.pale}42` : `${opt.flow.vivid}2b`,
  };

  return (
    <button
      type="button"
      role="radio"
      aria-checked={isActive}
      tabIndex={tabIndex}
      className="app-theme-card app-glass-card relative w-full cursor-pointer overflow-hidden rounded-2xl text-left"
      style={{
        border: isActive ? `1px solid ${opt.accent}` : "1px solid var(--cs-border-card)",
        boxShadow: isActive
          ? `0 0 0 3px ${opt.accent}22, 0 12px 30px ${opt.accent}18`
          : "0 2px 10px rgba(15, 23, 42, 0.06)",
      }}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <div className="relative h-44 overflow-hidden p-2.5" style={{ background: preview.app }}>
        <div className="relative h-full overflow-hidden rounded-[11px] border" style={{ background: preview.surface, borderColor: preview.border }}>
          <div className="flex h-7 items-center gap-1.5 border-b px-2.5" style={{ background: preview.chrome, borderColor: preview.border }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: opt.accent }} />
            <span className="h-1.5 w-1.5 rounded-full opacity-45" style={{ background: opt.accent }} />
            <span className="h-1.5 w-1.5 rounded-full opacity-25" style={{ background: opt.accent }} />
            <span className="ml-1.5 h-1.5 w-12 rounded-full opacity-50" style={{ background: preview.secondaryText }} />
          </div>
          <div className="flex h-[calc(100%-1.75rem)]">
            <div className="w-9 shrink-0 border-r px-2 py-2.5" style={{ background: preview.sidebar, borderColor: preview.border }}>
              <div className="h-1.5 w-4 rounded-full" style={{ background: opt.accent }} />
              <div className="mt-2.5 h-1.5 w-5 rounded-full opacity-35" style={{ background: preview.secondaryText }} />
              <div className="mt-2 h-1.5 w-3 rounded-full opacity-25" style={{ background: preview.secondaryText }} />
            </div>
            <div className="min-w-0 flex-1 p-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="h-2 w-16 rounded-full" style={{ background: preview.primaryText }} />
                  <div className="mt-1.5 h-1.5 w-24 rounded-full opacity-35" style={{ background: preview.secondaryText }} />
                </div>
                <div className="h-4 w-10 rounded-md" style={{ background: `${opt.accent}24` }} />
              </div>
              <div className="mt-3 rounded-md border p-2.5 font-mono text-[7px] leading-3" style={{ background: preview.terminal, borderColor: preview.border, color: preview.secondaryText }}>
                <div><span style={{ color: opt.accent }}>&gt;</span> termflow start</div>
                <div className="opacity-65">Ready in 320 ms</div>
                <div className="mt-1 h-1 w-12 rounded-full opacity-45" style={{ background: opt.accent }} />
              </div>
            </div>
          </div>
        </div>
        {isActive && (
          <div className="absolute right-4 top-4 flex h-6 w-6 items-center justify-center rounded-full shadow-sm" style={{ background: opt.accent }}>
            <CheckOutlined style={{ fontSize: 11, color: "#fff" }} />
          </div>
        )}
      </div>
      <div className="app-theme-card-footer relative px-4 pb-4 pt-3.5" style={{ background: "var(--cs-bg-card)" }}>
        <div className="flex items-center gap-2.5">
          <div className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: opt.accent }} />
          <span className="text-sm font-semibold" style={{ color: "var(--cs-text-primary)" }}>{t(opt.labelKey)}</span>
        </div>
        <div className="ml-5 mt-1 text-[11px] leading-4" style={{ color: "var(--cs-text-tertiary)" }}>{t(opt.descKey)}</div>
      </div>
    </button>
  );
}
function SettingRow({ label, desc, children }: {
  label: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-stretch gap-3 px-4 py-3 xl:flex-row xl:items-center xl:justify-between">
      <div className="min-w-0 flex-1 xl:mr-4">
        <div className="text-sm" style={{ color: "var(--cs-text-primary)" }}>
          {label}
        </div>
        {desc && (
          <div className="text-[11px] mt-0.5" style={{ color: "var(--cs-text-tertiary)" }}>
            {desc}
          </div>
        )}
      </div>
      <div className="min-w-0 xl:w-auto xl:max-w-[70%] xl:flex-shrink-0">
        {children}
      </div>
    </div>
  );
}

/* ────────────── Setting Section ────────────── */
function SettingSection({ title, children }: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-8">
      <div
        className="text-[11px] font-semibold uppercase tracking-widest mb-2 px-1"
        style={{ color: "var(--cs-text-tertiary)" }}
      >
        {title}
      </div>
      <div
        className="app-glass-card rounded-xl overflow-hidden"
        style={{
          background: "var(--cs-bg-card)",
          boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

/* ────────────── General Page ────────────── */
function GeneralPage() {
  const { t } = useTranslation();
  const lightTheme = useAppStore((s) => s.lightTheme);
  const darkTheme = useAppStore((s) => s.darkTheme);
  const themeCategory = useAppStore((s) => s.themeCategory);
  const systemPrefersDark = useAppStore((s) => s.systemPrefersDark);
  const language = useAppStore((s) => s.language);
  const startupRestoreLastProject = useAppStore((s) => s.startupRestoreLastProject);
  const projectOpenBehavior = useAppStore((s) => s.projectOpenBehavior);
  const explorerContextMenuEnabled = useAppStore((s) => s.explorerContextMenuEnabled);
  const terminalScrollback = useAppStore((s) => s.terminalScrollback);
  const setLightTheme = useAppStore((s) => s.setLightTheme);
  const setDarkTheme = useAppStore((s) => s.setDarkTheme);
  const setThemeCategory = useAppStore((s) => s.setThemeCategory);
  const setLanguage = useAppStore((s) => s.setLanguage);
  const setStartupRestoreLastProject = useAppStore((s) => s.setStartupRestoreLastProject);
  const setProjectOpenBehavior = useAppStore((s) => s.setProjectOpenBehavior);
  const setTerminalScrollback = useAppStore((s) => s.setTerminalScrollback);
  const setExplorerContextMenuEnabledInStore = useAppStore(
    (s) => s.setExplorerContextMenuEnabled
  );
  const [updatingExplorerContextMenu, setUpdatingExplorerContextMenu] = useState(false);

  const langOptions = [
    { label: t("settings.languageName.zh_CN"), value: "zh_CN" },
    { label: t("settings.languageName.zh_TW"), value: "zh_TW" },
    { label: t("settings.languageName.en"), value: "en" },
    { label: t("settings.languageName.ja"), value: "ja" },
  ];

  const resolvedCategory =
    themeCategory === "system"
      ? (systemPrefersDark ? "dark" : "light")
      : themeCategory;
  const currentTheme = resolvedCategory === "light" ? lightTheme : darkTheme;
  const visibleThemeOptions = themeOptions.filter((opt) => opt.category === resolvedCategory);
  const appearanceModeOptions = [
    { label: t("settings.general.appearance.light"), value: "light" },
    { label: t("settings.general.appearance.dark"), value: "dark" },
    { label: t("settings.general.appearance.system"), value: "system" },
  ];

  function handleSelectThemeCategory(category: ThemeCategory) {
    setThemeCategory(category);
  }

  function handleSelectTheme(opt: ThemeOption) {
    if (opt.category === "dark") {
      setDarkTheme(opt.key);
    } else {
      setLightTheme(opt.key);
    }
  }

  async function handleExplorerContextMenuChange(enabled: boolean) {
    if (updatingExplorerContextMenu) return;

    setUpdatingExplorerContextMenu(true);
    try {
      await setExplorerContextMenuEnabled(enabled);
      setExplorerContextMenuEnabledInStore(enabled);
    } catch (error) {
      console.error("Failed to update Explorer context menu integration:", error);
      message.error(t("settings.general.explorerContextMenuUpdateFailed"));
    } finally {
      setUpdatingExplorerContextMenu(false);
    }
  }

  function handleThemeCardKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) {
    let nextIndex: number | null = null;
    const lastIndex = visibleThemeOptions.length - 1;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = currentIndex === lastIndex ? 0 : currentIndex + 1;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = currentIndex === 0 ? lastIndex : currentIndex - 1;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = lastIndex;
    }

    if (nextIndex === null) return;

    event.preventDefault();
    handleSelectTheme(visibleThemeOptions[nextIndex]);
    const themeCards = event.currentTarget
      .closest('[role="radiogroup"]')
      ?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    themeCards?.[nextIndex]?.focus();
  }

  return (
    <>
      <SettingsPageHeader
        title={t("settings.menu.general")}
        description={t("settings.general.headerDesc")}
      />
      <SettingSection title={t("settings.general.appearance.title")}>
        <div className="p-5">
          <div className="flex flex-col gap-4 border-b pb-5 min-[760px]:flex-row min-[760px]:items-start min-[760px]:justify-between">
            <div className="min-w-0">
              <div className="text-sm font-semibold" style={{ color: "var(--cs-text-primary)" }}>
                {t("settings.general.appearance.mode.label")}
              </div>
              <div className="mt-1 text-xs leading-5" style={{ color: "var(--cs-text-tertiary)" }}>
                {t("settings.general.appearance.mode.desc")}
              </div>
            </div>
            <Segmented
              size="middle"
              value={themeCategory}
              options={appearanceModeOptions}
              onChange={(value) => handleSelectThemeCategory(value as ThemeCategory)}
            />
          </div>
          <div
            className="mt-5 grid grid-cols-1 gap-4 min-[760px]:grid-cols-2"
            role="radiogroup"
            aria-label={t("settings.general.appearance.title")}
          >
            {visibleThemeOptions.map((opt, index) => (
              <ThemeCard
                key={opt.key}
                opt={opt}
                isActive={currentTheme === opt.key}
                tabIndex={currentTheme === opt.key ? 0 : -1}
                onClick={() => handleSelectTheme(opt)}
                onKeyDown={(event) => handleThemeCardKeyDown(event, index)}
              />
            ))}
          </div>
        </div>
      </SettingSection>

      <SettingSection title={t("settings.general.languageSection")}>
        <SettingRow label={t("settings.general.uiLanguage")} desc={t("settings.general.uiLanguageDesc")}>
          <Segmented
            size="small"
            value={language}
            options={langOptions}
            onChange={(v) => setLanguage(v as Language)}
          />
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("settings.general.terminalSection")}>
        <SettingRow
          label={t("settings.general.terminalScrollback")}
          desc={t("settings.general.terminalScrollbackDesc")}
        >
          <Select
            className="w-[150px]"
            value={terminalScrollback}
            options={TERMINAL_SCROLLBACK_OPTIONS.map((rows) => ({
              value: rows,
              label: rows.toLocaleString(),
            }))}
            onChange={setTerminalScrollback}
          />
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("settings.general.startupSection")}>
        <SettingRow
          label={t("settings.general.restoreLastProject")}
          desc={t("settings.general.restoreLastProjectDesc")}
        >
          <Switch
            checked={startupRestoreLastProject}
            onChange={setStartupRestoreLastProject}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.general.projectOpenBehavior")}
          desc={t("settings.general.projectOpenBehaviorDesc")}
        >
          <Select
            value={projectOpenBehavior}
            style={{ width: 150 }}
            options={[
              { value: "ask", label: t("settings.general.projectOpenAsk") },
              { value: "current_window", label: t("settings.general.projectOpenCurrent") },
              { value: "new_window", label: t("settings.general.projectOpenNew") },
            ]}
            onChange={setProjectOpenBehavior}
          />
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("settings.general.windowsIntegrationSection")}>
        <SettingRow
          label={t("settings.general.explorerContextMenu")}
          desc={t("settings.general.explorerContextMenuDesc")}
        >
          <Switch
            checked={explorerContextMenuEnabled}
            loading={updatingExplorerContextMenu}
            onChange={handleExplorerContextMenuChange}
          />
        </SettingRow>
      </SettingSection>


    </>
  );
}

/* ────────────── Terminal Page ────────────── */
function TerminalPage() {
  const { t } = useTranslation();
  const editorFontSize = useAppStore((s) => s.editorFontSize);
  const setEditorFontSize = useAppStore((s) => s.setEditorFontSize);
  const terminalFontSize = useAppStore((s) => s.terminalFontSize);
  const setTerminalFontSize = useAppStore((s) => s.setTerminalFontSize);
  const cursorBlink = useAppStore((s) => s.terminalCursorBlink);
  const setCursorBlink = useAppStore((s) => s.setTerminalCursorBlink);
  const lineHeight = useAppStore((s) => s.terminalLineHeight);
  const setLineHeight = useAppStore((s) => s.setTerminalLineHeight);
  const terminalRenderer = useAppStore((s) => s.terminalRenderer);
  const setTerminalRenderer = useAppStore((s) => s.setTerminalRenderer);
  const defaultTerminalShell = useAppStore((s) => s.defaultTerminalShell);
  const setDefaultTerminalShell = useAppStore((s) => s.setDefaultTerminalShell);

  const fontSizeOptions = [
    { label: t("settings.fontSize.small"), value: 12 },
    { label: t("settings.fontSize.medium"), value: 14 },
    { label: t("settings.fontSize.large"), value: 16 },
    { label: t("settings.fontSize.xlarge"), value: 18 },
  ];

  const shellOptions = [
    { label: <ShellOptionLabel shell="powershell" text="PowerShell" />, value: "powershell" },
    { label: <ShellOptionLabel shell="cmd" text={t("settings.terminal.shell.cmd")} />, value: "cmd" },
  ];

  return (
    <>
      <SettingsPageHeader
        title={t("settings.menu.terminal")}
        description={t("settings.terminal.headerDesc")}
      />
      <SettingSection title={t("settings.terminal.shell")}>
        <SettingRow label={t("settings.terminal.defaultShell")} desc={t("settings.terminal.defaultShellDesc")}>
          <Segmented
            size="small"
            value={defaultTerminalShell}
            options={shellOptions}
            onChange={(v) => setDefaultTerminalShell(v as TerminalShell)}
          />
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("settings.terminal.font")}>
        <SettingRow label={t("settings.terminal.editorFontSize")} desc={t("settings.terminal.editorFontSizeDesc")}>
          <Segmented
            size="small"
            value={editorFontSize}
            options={fontSizeOptions}
            onChange={(v) => setEditorFontSize(v as number)}
          />
        </SettingRow>
        <SettingRow label={t("settings.terminal.fontSize")} desc={t("settings.terminal.fontSizeDesc")}>
          <Segmented
            size="small"
            value={terminalFontSize}
            options={fontSizeOptions}
            onChange={(v) => setTerminalFontSize(v as number)}
          />
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("settings.terminal.behavior")}>
        <SettingRow label={t("settings.terminal.cursorBlink")} desc={t("settings.terminal.cursorBlinkDesc")}>
          <Segmented
            size="small"
            value={cursorBlink ? "on" : "off"}
            options={[
              { label: t("common.on"), value: "on" },
              { label: t("common.off"), value: "off" },
            ]}
            onChange={(v) => setCursorBlink(v === "on")}
          />
        </SettingRow>
        <SettingRow label={t("settings.terminal.lineHeight")} desc={t("settings.terminal.lineHeightDesc")}>
          <Segmented
            size="small"
            value={lineHeight}
            options={[
              { label: "1.0", value: 1.0 },
              { label: "1.2", value: 1.2 },
              { label: "1.5", value: 1.5 },
              { label: "1.8", value: 1.8 },
            ]}
            onChange={(v) => setLineHeight(v as number)}
          />
        </SettingRow>
        <SettingRow label={t("settings.terminal.renderer")} desc={t("settings.terminal.rendererDesc")}>
          <Switch
            checked={terminalRenderer !== "standard"}
            onChange={(checked) => setTerminalRenderer(checked ? "webgl" : "standard")}
          />
        </SettingRow>
      </SettingSection>

    </>
  );
}

/* ────────────── Voice Recognition Page ────────────── */
function ShellOptionLabel({ shell, text }: { shell: TerminalShell; text: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <AgentIcon agentId={shell} size={14} />
      <span>{text}</span>
    </span>
  );
}

const ASR_MODELS = [
  { value: DEFAULT_ASR_MODEL, label: DEFAULT_ASR_MODEL },
  { value: "qwen3-asr-flash", label: "Qwen3-ASR-Flash (阿里百炼)" },
];

type AsrProvider = "mimo" | "dashscope";

const MIMO_ASR_MODELS = ASR_MODELS.filter((option) => option.value === DEFAULT_ASR_MODEL);

const DASHSCOPE_ASR_MODELS = [
  { value: "qwen3-asr-flash", label: "Qwen3-ASR-Flash (阿里百炼)" },
];

function VoiceRecognitionPage() {
  const { t } = useTranslation();
  const asrApiKey = useAppStore((s) => s.asrApiKey);
  const asrAuthMode = useAppStore((s) => s.asrAuthMode);
  const asrModel = useAppStore((s) => s.asrModel);
  const asrRegion = useAppStore((s) => s.asrRegion);
  const voiceShortcut = useAppStore((s) => s.voiceShortcut);
  const voiceTriggerVisible = useAppStore((s) => s.voiceTriggerVisible);
  const setAsrApiKey = useAppStore((s) => s.setAsrApiKey);
  const setAsrAuthMode = useAppStore((s) => s.setAsrAuthMode);
  const setAsrModel = useAppStore((s) => s.setAsrModel);
  const setAsrRegion = useAppStore((s) => s.setAsrRegion);
  const setVoiceShortcut = useAppStore((s) => s.setVoiceShortcut);
  const setVoiceTriggerVisible = useAppStore((s) => s.setVoiceTriggerVisible);

  const [showApiKey, setShowApiKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [isRecordingShortcut, setIsRecordingShortcut] = useState(false);
  const asrProvider: AsrProvider =
    asrModel.startsWith("fun-asr-flash") || asrModel.startsWith("qwen3-asr-flash")
      ? "dashscope"
      : "mimo";
  const isDashScopeProvider = asrProvider === "dashscope";
  const providerOptions = [
    { label: "MiMo", value: "mimo" },
    { label: "阿里百炼 DashScope", value: "dashscope" },
  ];
  const mimoAuthOptions = [
    { label: "Token Plan", value: "token-plan" },
    { label: "API", value: "api" },
  ];
  const currentModelOptions = isDashScopeProvider ? DASHSCOPE_ASR_MODELS : MIMO_ASR_MODELS;
  const apiKeyPlaceholder = isDashScopeProvider
    ? "请输入 DashScope API Key"
    : asrAuthMode === "token-plan"
      ? "请输入 Token Plan Key"
      : "请输入 MiMo API Key";
  const apiKeyDesc = isDashScopeProvider
    ? "使用阿里云百炼 DashScope API Key。"
    : asrAuthMode === "token-plan"
      ? "使用 MiniMax Token Plan 获取的 Key。"
      : "使用 MiMo API Key。";
  const shortcutPlaceholder = t("settings.voiceRecognition.shortcutPlaceholder", {
    defaultValue: "未设置快捷键",
  });
  const shortcutDisplay = useMemo(
    () => formatShortcutDisplay(voiceShortcut),
    [voiceShortcut]
  );
  const currentShortcutLabel = isRecordingShortcut
    ? t("settings.voiceRecognition.shortcutRecording", {
        defaultValue: "请按下快捷键...",
      })
    : shortcutDisplay || shortcutPlaceholder;
  const handleProviderChange = (provider: AsrProvider) => {
    if (provider === "dashscope") {
      setAsrModel("qwen3-asr-flash");
      return;
    }
    setAsrModel(DEFAULT_ASR_MODEL);
  };

  const handleTest = async () => {
    if (!asrApiKey.trim()) {
      message.warning(t("settings.voiceRecognition.apiKeyRequired", { defaultValue: "请先输入 API Key" }));
      return;
    }
    if (!asrModel.trim()) {
      message.warning(t("settings.voiceRecognition.modelRequired", { defaultValue: "请先输入模型名称" }));
      return;
    }

    setTesting(true);

    try {
      const probeDataUrl = await createSilentWavDataUrl();
      if (isDashScopeProvider) {
        // DashScope 模型：使用 fetch 直接调用
        const { buildDashScopeAsrRequest, getDashScopeEndpoint, extractDashScopeAsrText } = await import("@/lib/dashscopeAsr");
        const endpoint = getDashScopeEndpoint(asrRegion);
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${asrApiKey.trim()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(buildDashScopeAsrRequest(probeDataUrl, {
            model: asrModel.trim() as any,
            region: asrRegion,
          })),
        });

        if (!response.ok) {
          const errorBody = await response.json().catch(() => null);
          throw new Error(errorBody?.message || `HTTP ${response.status}`);
        }

        const result = await response.json();
        extractDashScopeAsrText(result); // 验证响应格式
      } else {
        // MiMo 模型：使用 Rust 代理
        const separatorIndex = probeDataUrl.indexOf(",");
        const audioBase64 = separatorIndex >= 0 ? probeDataUrl.slice(separatorIndex + 1) : "";

        await invoke<string>("transcribe_audio", {
          audioBase64,
          mimeType: "audio/wav",
          model: asrModel.trim(),
          apiKey: asrApiKey.trim(),
          authMode: asrAuthMode,
        });
      }

      const successMsg = t("settings.voiceRecognition.testSuccess", {
        defaultValue: "API Key、模型与 ASR 接口验证成功！",
      });
      message.success(successMsg);
    } catch (error) {
      const errorMsg = error instanceof Error && error.message
        ? error.message
        : t("settings.voiceRecognition.testError", { defaultValue: "ASR 请求失败，请检查网络、模型和 API Key 配置" });
      message.error(errorMsg);
    } finally {
      setTesting(false);
    }
  };

  useEffect(() => {
    if (!isRecordingShortcut) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setIsRecordingShortcut(false);
        message.info(
          t("settings.voiceRecognition.shortcutRecordCancelled", {
            defaultValue: "已取消快捷键录制",
          })
        );
        return;
      }

      const nextShortcut = captureShortcutFromEvent(event);
      if (!nextShortcut) {
        return;
      }

      const parsedShortcut = parseShortcut(nextShortcut);
      const hasModifier = Boolean(
        parsedShortcut &&
        (
          parsedShortcut.primaryKey ||
          parsedShortcut.altKey ||
          parsedShortcut.metaKey ||
          parsedShortcut.shiftKey
        )
      );

      if (!hasModifier) {
        message.warning(
          t("settings.voiceRecognition.shortcutModifierRequired", {
            defaultValue: "请至少包含一个修饰键，例如 Ctrl、Alt、Shift 或 Cmd",
          })
        );
        return;
      }

      setVoiceShortcut(nextShortcut);
      setIsRecordingShortcut(false);
      message.success(
        t("settings.voiceRecognition.shortcutSaved", {
          defaultValue: "语音快捷键已更新",
        })
      );
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isRecordingShortcut, setVoiceShortcut, t]);

  return (
    <>
      <SettingsPageHeader
        title={t("settings.menu.voiceRecognition")}
        description={t("settings.voiceRecognition.headerDesc")}
      />
      <SettingSection title={t("settings.voiceRecognition.apiConfig", { defaultValue: "API 配置" })}>
        <SettingRow
          label={t("settings.voiceRecognition.provider", { defaultValue: "服务商" })}
          desc={t("settings.voiceRecognition.providerDesc", {
            defaultValue: "选择语音识别服务后，只显示该服务需要的配置项。",
          })}
        >
          <Segmented
            size="small"
            value={asrProvider}
            options={providerOptions}
            onChange={(value) => handleProviderChange(value as AsrProvider)}
          />
        </SettingRow>
        {!isDashScopeProvider && (
          <SettingRow
            label={t("settings.voiceRecognition.authMode", { defaultValue: "认证方式" })}
            desc={t("settings.voiceRecognition.authModeDesc", {
              defaultValue: "MiMo 支持 Token Plan 和 API 两种 Key 来源。",
            })}
          >
            <Segmented
              size="small"
              value={asrAuthMode}
              options={mimoAuthOptions}
              onChange={(value) => {
                setAsrAuthMode(value as MimoAuthMode);
              }}
            />
          </SettingRow>
        )}
        <SettingRow
          label={t("settings.voiceRecognition.apiKey", { defaultValue: "API Key" })}
          desc={t("settings.voiceRecognition.apiKeyDesc", { defaultValue: "输入你的 API Key" })}
        >
          <div className="flex items-center gap-2">
            <Input.Password
              value={asrApiKey}
              onChange={(e) => {
                setAsrApiKey(e.target.value);
              }}
              placeholder={t("settings.voiceRecognition.apiKeyPlaceholder", { defaultValue: "请输入 API Key" })}
              aria-label={apiKeyPlaceholder}
              title={apiKeyDesc}
              style={{ width: 260 }}
              visibilityToggle={{ visible: showApiKey, onVisibleChange: setShowApiKey }}
            />
          </div>
        </SettingRow>
        <SettingRow
          label={t("settings.voiceRecognition.model", { defaultValue: "模型" })}
          desc={t("settings.voiceRecognition.modelDesc", {
            defaultValue: "选择语音识别模型",
          })}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={asrModel}
              onChange={(value) => {
                setAsrModel(value);
              }}
              options={currentModelOptions}
              style={{ width: 280 }}
              placeholder={t("settings.voiceRecognition.modelPlaceholder", {
                defaultValue: "请选择模型",
              })}
            />
          </div>
        </SettingRow>
        {isDashScopeProvider && (
        <SettingRow
          label={t("settings.voiceRecognition.region", { defaultValue: "区域" })}
          desc={t("settings.voiceRecognition.regionDesc", {
            defaultValue: "选择 DashScope 服务区域（不同区域使用不同的 API Key）",
          })}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={asrRegion}
              onChange={(value) => setAsrRegion(value)}
              options={[
                { value: "beijing", label: "华北2（北京）" },
                { value: "singapore", label: "新加坡" },
                { value: "us", label: "美国（弗吉尼亚）" },
              ]}
              style={{ width: 280 }}
              placeholder={t("settings.voiceRecognition.regionPlaceholder", {
                defaultValue: "请选择区域",
              })}
            />
          </div>
        </SettingRow>
        )}
      </SettingSection>

      <SettingSection title={t("settings.voiceRecognition.shortcutLabel", { defaultValue: "语音输入" })}>
        <SettingRow
          label={t("settings.voiceRecognition.shortcutLabel", { defaultValue: "语音输入快捷键" })}
          desc={t("settings.voiceRecognition.shortcutDesc", {
            defaultValue: "按住快捷键时开始录音，松开后结束并转录。",
          })}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Input
              readOnly
              value={currentShortcutLabel}
              placeholder={shortcutPlaceholder}
              onClick={() => setIsRecordingShortcut(true)}
              style={{ width: 220, cursor: "pointer" }}
            />
            <Button
              type={isRecordingShortcut ? "primary" : "default"}
              onClick={() => setIsRecordingShortcut((current) => !current)}
            >
              {isRecordingShortcut
                ? t("settings.voiceRecognition.shortcutRecording", {
                    defaultValue: "请按下快捷键...",
                  })
                : t("settings.voiceRecognition.shortcutRecord", {
                    defaultValue: "录制快捷键",
                  })}
            </Button>
            <Button
              size="small"
              onClick={() => {
                setVoiceShortcut(DEFAULT_VOICE_SHORTCUT);
                setIsRecordingShortcut(false);
              }}
            >
              {t("settings.voiceRecognition.shortcutReset", { defaultValue: "恢复默认" })}
            </Button>
            <Button
              size="small"
              icon={<DeleteOutlined />}
              disabled={!voiceShortcut.trim()}
              onClick={() => {
                setVoiceShortcut("");
                setIsRecordingShortcut(false);
              }}
            >
              {t("settings.voiceRecognition.shortcutClear", { defaultValue: "清除" })}
            </Button>
          </div>
        </SettingRow>
        <SettingRow
          label={t("settings.voiceRecognition.triggerButton", { defaultValue: "麦克风图标" })}
          desc={t("settings.voiceRecognition.triggerButtonDesc", {
            defaultValue: "控制右下角麦克风图标是否显示。",
          })}
        >
          <Switch checked={voiceTriggerVisible} onChange={setVoiceTriggerVisible} />
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("settings.voiceRecognition.test", { defaultValue: "测试" })}>
        <SettingRow
          label={t("settings.voiceRecognition.testConnection", { defaultValue: "测试连接" })}
          desc={t("settings.voiceRecognition.testConnectionDesc", {
            defaultValue: "验证 API Key、模型与识别接口是否可用",
          })}
        >
          <Button
            type="primary"
            loading={testing}
            onClick={handleTest}
            disabled={!asrApiKey.trim()}
          >
            {t("settings.voiceRecognition.testButton", { defaultValue: "测试" })}
          </Button>
        </SettingRow>
      </SettingSection>
    </>
  );
}

/* ────────────── Shortcuts Page ────────────── */
function ShortcutsPage() {
  const { t } = useTranslation();
  return (
    <>
      <SettingsPageHeader
        title={t("settings.menu.shortcuts")}
        description={t("settings.shortcuts.headerDesc")}
      />
      <SettingSection title={t("settings.menu.shortcuts")}>
        {SHORTCUTS.map((s, i) => (
          <div
            key={s.id}
            className="flex items-center justify-between px-4 py-2.5"
            style={{
              borderBottom: i < SHORTCUTS.length - 1
                ? "1px solid var(--cs-border-card)"
                : "none",
            }}
          >
            <span className="text-sm" style={{ color: "var(--cs-text-primary)" }}>
              {t(s.i18nKey)}
            </span>
            <div className="flex gap-1">
              {s.keys.split(" + ").map((k, j) => (
                <span key={j}>
                  <kbd
                    className="inline-block px-1.5 py-0.5 rounded text-[11px] font-mono"
                    style={{
                      background: "var(--cs-bg-hover)",
                      color: "var(--cs-text-secondary)",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
                      minWidth: 22,
                      textAlign: "center",
                    }}
                  >
                    {k}
                  </kbd>
                  {j < s.keys.split(" + ").length - 1 && (
                    <span className="text-[10px] mx-0.5" style={{ color: "var(--cs-text-tertiary)" }}>+</span>
                  )}
                </span>
              ))}
            </div>
          </div>
        ))}
        <div className="px-4 py-3">
          <Text className="text-[11px]" style={{ color: "var(--cs-text-tertiary)" }}>
            {t("settings.shortcuts.hint1")}
          </Text>
          <br />
          <Text className="text-[11px]" style={{ color: "var(--cs-text-tertiary)" }}>
            {t("settings.shortcuts.hint2")}
          </Text>
        </div>
      </SettingSection>
    </>
  );
}

/* ────────────── Skills Page ────────────── */
type SkillStatusFilter = "all" | "enabled" | "disabled";
type SkillAgentFilter = "all" | SkillAgent;
type ResourceScope = "workspace" | "user";
const SETTINGS_LIST_PAGE_SIZE = 5;
const SKILL_AGENTS: readonly SkillAgent[] = getAgentIdsWithCapability("skills");

function skillAgentLabel(agent: SkillAgent, t: (key: string) => string) {
  return t(`settings.skills.agents.${agent}`);
}

function skillSourceLabel(skill: SkillInfo, t: (key: string) => string) {
  return skill.scope === "workspace" && (skill.agent === "codex" || skill.agent === "antigravity")
    ? t("settings.skills.sharedAgentsSource")
    : skillAgentLabel(skill.agent, t);
}

function formatSkillUpdatedAt(updatedAt?: number) {
  if (!updatedAt) return null;
  try {
    return new Date(updatedAt).toLocaleString();
  } catch {
    return null;
  }
}

function resolveSkillFolderPath(skill: SkillInfo) {
  return skill.filePath.replace(/[\\/]SKILL\.md$/i, "");
}

function scopeLabel(scope: ResourceScope, t: (key: string, options?: Record<string, unknown>) => string) {
  return scope === "workspace" ? t("settings.scope.workspace") : t("settings.scope.user");
}

function buildPaginationItems(current: number, totalPages: number) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }
  if (current <= 4) {
    return [1, 2, 3, 4, 5, "ellipsis-right", totalPages];
  }
  if (current >= totalPages - 3) {
    return [1, "ellipsis-left", totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }
  return [1, "ellipsis-left", current - 1, current, current + 1, "ellipsis-right", totalPages];
}

function ScopeTabs({
  value,
  workspaceCount,
  userCount,
  projectAvailable,
  onChange,
}: {
  value: ResourceScope;
  workspaceCount: number;
  userCount: number;
  projectAvailable: boolean;
  onChange: (scope: ResourceScope) => void;
}) {
  const { t } = useTranslation();
  const options: Array<{ value: ResourceScope; label: string; count: number; disabled?: boolean }> = [
    { value: "workspace", label: t("settings.scope.workspaceShort"), count: workspaceCount, disabled: !projectAvailable },
    { value: "user", label: t("settings.scope.userShort"), count: userCount },
  ];

  return (
    <div
      className="mt-5 flex items-end gap-1 border-b"
      style={{ borderColor: "var(--cs-border-card)" }}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            disabled={option.disabled}
            onClick={() => !option.disabled && onChange(option.value)}
            className="relative px-4 py-3 text-sm font-medium transition-all"
            style={{
              color: option.disabled
                ? "var(--cs-text-tertiary)"
                : active
                  ? "var(--cs-text-primary)"
                  : "var(--cs-text-secondary)",
              opacity: option.disabled ? 0.45 : 1,
            }}
          >
            <span className="flex items-center gap-2">
              <span>{option.label}</span>
              <span
                className="px-2 py-0.5 rounded-full text-[11px]"
                style={{
                  background: active ? "color-mix(in srgb, var(--cs-primary) 14%, transparent)" : "var(--cs-bg-hover)",
                  color: active ? "var(--cs-primary)" : "var(--cs-text-tertiary)",
                }}
              >
                {option.count}
              </span>
            </span>
            <span
              className="absolute left-3 right-3 bottom-0 h-[2px] rounded-full transition-all"
              style={{
                background: active ? "var(--cs-primary)" : "transparent",
                boxShadow: active ? "0 0 12px color-mix(in srgb, var(--cs-primary) 35%, transparent)" : "none",
              }}
            />
          </button>
        );
      })}
    </div>
  );
}

function ListPagination({
  current,
  total,
  pageSize,
  onChange,
}: {
  current: number;
  total: number;
  pageSize: number;
  onChange: (page: number) => void;
}) {
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) return null;

  const items = buildPaginationItems(current, totalPages);

  return (
    <div
      className="px-5 py-4 flex items-center justify-end"
      style={{ borderTop: "1px solid var(--cs-border-card)" }}
    >
      <div
        className="inline-flex items-center gap-2 rounded-2xl px-3 py-2"
        style={{
          background: "color-mix(in srgb, var(--cs-bg-hover) 80%, transparent)",
          border: "1px solid color-mix(in srgb, var(--cs-border-card) 85%, transparent)",
        }}
      >
        <button
          type="button"
          onClick={() => onChange(current - 1)}
          disabled={current === 1}
          className="w-8 h-8 rounded-xl flex items-center justify-center transition-all"
          style={{
            color: current === 1 ? "var(--cs-text-tertiary)" : "var(--cs-text-secondary)",
            opacity: current === 1 ? 0.4 : 1,
          }}
        >
          <LeftOutlined />
        </button>
        {items.map((item, index) =>
          typeof item === "number" ? (
            <button
              key={`${item}-${index}`}
              type="button"
              onClick={() => onChange(item)}
              className="min-w-8 h-8 px-2 rounded-xl text-sm font-medium transition-all"
              style={{
                background: item === current ? "var(--cs-primary)" : "transparent",
                color: item === current ? "#fff" : "var(--cs-text-secondary)",
                boxShadow: item === current ? "0 10px 22px -14px color-mix(in srgb, var(--cs-primary) 80%, transparent)" : "none",
              }}
            >
              {item}
            </button>
          ) : (
            <span
              key={`${item}-${index}`}
              className="w-8 h-8 flex items-center justify-center text-sm"
              style={{ color: "var(--cs-text-tertiary)" }}
            >
              ...
            </span>
          )
        )}
        <button
          type="button"
          onClick={() => onChange(current + 1)}
          disabled={current === totalPages}
          className="w-8 h-8 rounded-xl flex items-center justify-center transition-all"
          style={{
            color: current === totalPages ? "var(--cs-text-tertiary)" : "var(--cs-text-secondary)",
            opacity: current === totalPages ? 0.4 : 1,
          }}
        >
          <RightOutlined />
        </button>
      </div>
    </div>
  );
}

function SkillRow({
  skill,
  toggling,
  onToggle,
  onOpen,
}: {
  skill: SkillInfo;
  toggling: boolean;
  onToggle: (checked: boolean) => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-start gap-4 px-4 py-3 transition-colors cursor-pointer"
      style={{ borderBottom: "1px solid var(--cs-border-card)" }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--cs-bg-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
      onClick={onOpen}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <AgentIcon agentId={skill.agent} size={16} />
          <span className="min-w-0 break-words text-sm font-medium" style={{ color: "var(--cs-text-primary)" }}>
            {skill.name}
          </span>
          <Tag className="!m-0">{t("settings.skills.nativeSource", { agent: skillSourceLabel(skill, t) })}</Tag>
          {skill.hasNameConflict && <Tag className="!m-0" color="warning">{t("settings.skills.nameConflict")}</Tag>}
        </div>
        <div className="text-[11px] mt-1 line-clamp-2" style={{ color: "var(--cs-text-tertiary)" }}>
          {skill.description || t("settings.shared.noDescription")}
        </div>
        <div className="text-[10px] mt-1 flex min-w-0 items-center gap-x-3 gap-y-1 flex-wrap" style={{ color: "var(--cs-text-tertiary)" }}>
          <span className="inline-flex min-w-0 items-center gap-1 flex-wrap">
            {t("settings.skills.availableTo")}
            {skill.effectiveAgents.map((agent) => (
              <Tooltip key={agent} title={skillAgentLabel(agent, t)}>
                <span><AgentIcon agentId={agent} size={13} /></span>
              </Tooltip>
            ))}
          </span>
          <span className="break-words">{skill.folderName}</span>
          <span className="min-w-0 break-all">{skill.sourceDir}</span>
          <span className="break-words">{t("settings.shared.updatedAt", { value: formatSkillUpdatedAt(skill.updatedAt) ?? t("common.unknown") })}</span>
        </div>
      </div>
      <div className="mt-1 flex shrink-0 items-center gap-2">
        <span
          className="text-xs"
          style={{ color: skill.enabled ? "var(--cs-success)" : "var(--cs-text-tertiary)" }}
        >
          {skill.enabled ? t("common.enabled") : t("common.disabled")}
        </span>
        <Switch
          checked={skill.enabled}
          loading={toggling}
          onClick={(checked, event) => {
            event?.stopPropagation();
            onToggle(checked);
          }}
        />
      </div>
    </div>
  );
}

function SkillAgentFilterButtons({
  value,
  total,
  counts,
  onChange,
}: {
  value: SkillAgentFilter;
  total: number;
  counts: Record<SkillAgent, number>;
  onChange: (agent: SkillAgentFilter) => void;
}) {
  const { t } = useTranslation();
  const options: Array<{ value: SkillAgentFilter; label: React.ReactNode }> = [
    { value: "all", label: `${t("settings.skills.allAgents")} (${total})` },
    ...SKILL_AGENTS.map((agent) => ({
      value: agent,
      label: <><AgentIcon agentId={agent} size={14} />{skillAgentLabel(agent, t)} ({counts[agent]})</>,
    })),
  ];

  return (
    <div
      className="flex flex-wrap gap-1 rounded-lg p-1"
      role="radiogroup"
      aria-label={t("settings.skills.filterByAgent")}
      style={{ background: "var(--cs-bg-hover)" }}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-md px-3 py-1 text-left text-sm transition-colors"
            style={{
              background: active ? "var(--cs-bg-card)" : "transparent",
              color: active ? "var(--cs-text-primary)" : "var(--cs-text-secondary)",
              boxShadow: active ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function SkillDetailPanel({
  open,
  detail,
  loading,
  onClose,
  onOpenFolder,
}: {
  open: boolean;
  detail: SkillDetail | null;
  loading: boolean;
  onClose: () => void;
  onOpenFolder: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Drawer
      title={detail?.skill.name ?? t("settings.skills.detailTitle")}
      placement="right"
      width={560}
      open={open}
      onClose={onClose}
      destroyOnClose={false}
    >
      {loading ? (
        <div className="flex justify-center py-10">
          <Spin />
        </div>
      ) : detail ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            <Tag icon={<span className="inline-flex mr-1"><AgentIcon agentId={detail.skill.agent} size={13} /></span>}>
              {t("settings.skills.nativeSource", { agent: skillSourceLabel(detail.skill, t) })}
            </Tag>
            <Tag color={detail.skill.enabled ? "green" : "default"}>
              {detail.skill.enabled ? t("common.enabled") : t("common.disabled")}
            </Tag>
            {detail.skill.hasNameConflict && <Tag color="warning">{t("settings.skills.nameConflict")}</Tag>}
          </div>
          <div className="space-y-1">
            <div className="text-xs" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.skills.availableTo")}</div>
            <div className="flex items-center gap-2 flex-wrap">
              {detail.skill.effectiveAgents.map((agent) => (
                <Tag key={agent} icon={<span className="inline-flex mr-1"><AgentIcon agentId={agent} size={13} /></span>}>
                  {skillAgentLabel(agent, t)}
                </Tag>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-xs" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.shared.directory")}</div>
            <div className="text-xs break-all" style={{ color: "var(--cs-text-secondary)" }}>
              {resolveSkillFolderPath(detail.skill)}
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-xs" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.shared.file")}</div>
            <div className="text-xs break-all" style={{ color: "var(--cs-text-secondary)" }}>
              {detail.skill.filePath}
            </div>
          </div>
          <div className="flex gap-2">
            <Button icon={<FolderOpenOutlined />} onClick={onOpenFolder}>
              {t("settings.skills.openSkillDirectory")}
            </Button>
          </div>
          <div
            className="rounded-xl p-4"
            style={{
              background: "var(--cs-bg-hover)",
              border: "1px solid var(--cs-border-card)",
            }}
          >
            <pre
              className="text-xs leading-relaxed whitespace-pre-wrap font-mono"
              style={{ color: "var(--cs-text-secondary)" }}
            >
              {detail.content}
            </pre>
          </div>
        </div>
      ) : (
        <Empty description={t("settings.skills.selectSkill")} />
      )}
    </Drawer>
  );
}

function SkillsPage() {
  const { t } = useTranslation();
  const currentProject = useAppStore((s) => s.currentProject);
  const projectPath = currentProject?.path ?? null;
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [activeAgent, setActiveAgent] = useState<SkillAgentFilter>("all");
  const [activeScope, setActiveScope] = useState<SkillScope>(projectPath ? "workspace" : "user");
  const [statusFilter, setStatusFilter] = useState<SkillStatusFilter>("all");
  const [selectedSkill, setSelectedSkill] = useState<SkillInfo | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createScope, setCreateScope] = useState<SkillScope>("workspace");
  const [createAgent, setCreateAgent] = useState<SkillAgent>("claude");
  const [creating, setCreating] = useState(false);
  const [page, setPage] = useState(1);

  const loadCatalog = useCallback(async (silent = false) => {
    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    try {
      const next = await listSkills(projectPath);
      setCatalog(next);
    } catch (error) {
      console.error("Failed to load skills:", error);
      message.error(t("settings.skills.loadFailed"));
    } finally {
      if (silent) {
        setRefreshing(false);
      } else {
        setLoading(false);
      }
    }
  }, [projectPath]);

  useEffect(() => {
    if (!projectPath) {
      setActiveScope("user");
      setCreateScope("user");
    }
  }, [projectPath]);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    setPage(1);
  }, [search, activeAgent, activeScope, statusFilter, catalog?.skills]);

  const searchStatusFilteredSkills = useMemo(() => {
    const allSkills = catalog?.skills ?? [];
    const keyword = search.trim().toLowerCase();
    return allSkills.filter((skill) => {
      if (statusFilter === "enabled" && !skill.enabled) return false;
      if (statusFilter === "disabled" && skill.enabled) return false;
      if (!keyword) return true;
      return [
        skill.name,
        skill.description,
        skill.folderName,
        skill.filePath,
      ]
        .join(" ")
        .toLowerCase()
        .includes(keyword);
    });
  }, [catalog?.skills, search, statusFilter]);

  const agentCounts = Object.fromEntries(
    SKILL_AGENTS.map((agent) => [agent, searchStatusFilteredSkills.filter((skill) => skill.effectiveAgents.includes(agent)).length])
  ) as Record<SkillAgent, number>;
  const baseFilteredSkills = activeAgent === "all"
    ? searchStatusFilteredSkills
    : searchStatusFilteredSkills.filter((skill) => skill.effectiveAgents.includes(activeAgent));
  const workspaceCount = baseFilteredSkills.filter((skill) => skill.scope === "workspace").length;
  const userCount = baseFilteredSkills.filter((skill) => skill.scope === "user").length;
  const filteredSkills = baseFilteredSkills.filter((skill) => skill.scope === activeScope);

  const pagedSkills = filteredSkills.slice(
    (page - 1) * SETTINGS_LIST_PAGE_SIZE,
    page * SETTINGS_LIST_PAGE_SIZE
  );

  async function handleOpenDetail(skill: SkillInfo) {
    setSelectedSkill(skill);
    setDetail(null);
    setDetailLoading(true);
    try {
      const next = await getSkillDetail(skill.agent, skill.scope, skill.folderName, skill.enabled, projectPath);
      setDetail(next);
    } catch (error) {
      console.error("Failed to load skill details:", error);
      message.error(t("settings.skills.loadDetailFailed"));
    } finally {
      setDetailLoading(false);
    }
  }

  async function handleToggle(skill: SkillInfo, checked: boolean) {
    setTogglingId(skill.id);
    try {
      const updated = await setSkillEnabled(
        skill.agent,
        skill.scope,
        skill.folderName,
        skill.enabled,
        checked,
        projectPath
      );
      const mergedUpdated = { ...updated, hasNameConflict: skill.hasNameConflict };
      setCatalog((prev) =>
        prev
          ? {
              ...prev,
              skills: prev.skills.map((item) => (item.id === skill.id ? mergedUpdated : item)),
            }
          : prev
      );
      if (selectedSkill?.id === skill.id) {
        setSelectedSkill(mergedUpdated);
        setDetail((prev) => (prev ? { ...prev, skill: mergedUpdated } : prev));
      }
      message.success(
        checked
          ? t("settings.skills.enableSuccess", { name: updated.name })
          : t("settings.skills.disableSuccess", { name: updated.name })
      );
    } catch (error) {
      console.error("Failed to toggle skill status:", error);
      message.error(t("settings.skills.toggleFailed"));
    } finally {
      setTogglingId(null);
    }
  }

  async function handleOpenDirectory(agent: SkillAgent, scope: SkillScope, enabled: boolean) {
    try {
      const dir = await ensureSkillDirectory(agent, scope, enabled, projectPath);
      await openInFileManager(dir);
    } catch (error) {
      console.error("Failed to open skill directory:", error);
      message.error(t("settings.skills.openDirectoryFailed"));
    }
  }

  async function handleCreateSkill() {
    if (!createName.trim()) {
      message.warning(t("settings.skills.enterSkillName"));
      return;
    }
    setCreating(true);
    try {
      const created = await createSkill(
        createAgent,
        createScope,
        createName.trim(),
        createDescription.trim() || undefined,
        projectPath
      );
      setCreateOpen(false);
      setCreateName("");
      setCreateDescription("");
      message.success(t("settings.skills.createSuccess", { name: created.name }));
      await loadCatalog(true);
      await handleOpenDetail(created);
    } catch (error) {
      console.error("Failed to create skill:", error);
      message.error(t("settings.skills.createFailed"));
    } finally {
      setCreating(false);
    }
  }

  function renderSkillSection() {
    const currentScope = activeScope;
    const currentRoot = activeAgent === "all"
      ? null
      : catalog?.roots.find((root) => root.agent === activeAgent && root.scope === currentScope);
    const directoryText = currentRoot?.enabledDir;
    const items = pagedSkills;
    const totalItems = filteredSkills.length;
    const emptyDescription = currentScope === "workspace" && !projectPath
      ? t("settings.skills.openProjectFirst")
      : t("settings.skills.emptyFiltered");

    return (
      <SettingSection title={`${t("settings.menu.skills")} (${totalItems})`}>
        <div className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="text-sm font-medium" style={{ color: "var(--cs-text-primary)" }}>
              {activeAgent === "all"
                ? t("settings.skills.listDesc")
                : t("settings.skills.agentScopeDesc", { agent: skillAgentLabel(activeAgent, t) })}
            </div>
            <div className="text-[11px] mt-1 break-all" style={{ color: "var(--cs-text-tertiary)" }}>
              {activeAgent === "all"
                ? t("settings.skills.selectAgentForDirectory")
                : directoryText || (currentScope === "workspace" ? t("settings.skills.workspaceDirUnavailable") : t("settings.skills.userDirUnavailable"))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="small" disabled={activeAgent === "all"} icon={<FolderOpenOutlined />} onClick={() => activeAgent !== "all" && handleOpenDirectory(activeAgent, currentScope, true)}>
              {t("settings.skills.openEnabledDir")}
            </Button>
            <Button size="small" disabled={activeAgent === "all"} onClick={() => activeAgent !== "all" && handleOpenDirectory(activeAgent, currentScope, false)}>
              {t("settings.skills.openDisabledDir")}
            </Button>
          </div>
        </div>
        {items.length === 0 ? (
          <Empty
            description={emptyDescription}
            style={{ padding: "28px 0" }}
          />
        ) : (
          <>
            {items.map((skill) => (
              <SkillRow
                key={skill.id}
                skill={skill}
                toggling={togglingId === skill.id}
                onOpen={() => handleOpenDetail(skill)}
                onToggle={(checked) => handleToggle(skill, checked)}
              />
            ))}
            <ListPagination
              current={page}
              onChange={setPage}
              pageSize={SETTINGS_LIST_PAGE_SIZE}
              total={totalItems}
            />
          </>
        )}
      </SettingSection>
    );
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Spin />
      </div>
    );
  }

  return (
    <>
      <SettingsPageHeader
        title={t("settings.menu.skills")}
        description={t("settings.skills.headerDesc")}
        actions={
          <>
            <Button
              icon={<PlusOutlined />}
              type="primary"
              onClick={() => {
                setCreateScope(activeScope);
                if (activeAgent !== "all") setCreateAgent(activeAgent);
                setCreateOpen(true);
              }}
            >
              {t("settings.skills.newSkill")}
            </Button>
            <Button
              icon={<ReloadOutlined spin={refreshing} />}
              onClick={() => loadCatalog(true)}
            >
              {t("common.refresh")}
            </Button>
          </>
        }
      >
        <div className="mb-3">
          <div className="text-xs mb-2" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.skills.filterByAgent")}</div>
          <SkillAgentFilterButtons
            value={activeAgent}
            total={searchStatusFilteredSkills.length}
            counts={agentCounts}
            onChange={setActiveAgent}
          />
        </div>
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_auto]">
          <Input
            allowClear
            prefix={<SearchOutlined style={{ color: "var(--cs-text-tertiary)" }} />}
            placeholder={t("settings.skills.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Segmented
            value={statusFilter}
            onChange={(value) => setStatusFilter(value as SkillStatusFilter)}
            options={[
              { label: t("settings.shared.allStatus"), value: "all" },
              { label: t("common.enabled"), value: "enabled" },
              { label: t("common.disabled"), value: "disabled" },
            ]}
          />
        </div>
        <ScopeTabs
          value={activeScope}
          workspaceCount={workspaceCount}
          userCount={userCount}
          projectAvailable={!!projectPath}
          onChange={setActiveScope}
        />
      </SettingsPageHeader>

      {renderSkillSection()}

      <SkillDetailPanel
        open={!!selectedSkill}
        detail={detail}
        loading={detailLoading}
        onClose={() => {
          setSelectedSkill(null);
          setDetail(null);
        }}
        onOpenFolder={() => {
          if (selectedSkill) {
            openInFileManager(resolveSkillFolderPath(selectedSkill)).catch(() => {
              message.error(t("settings.skills.openDirectoryFailed"));
            });
          }
        }}
      />

      <Modal
        title={t("settings.skills.newSkill")}
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={handleCreateSkill}
        confirmLoading={creating}
        okText={t("common.create")}
      >
        <div className="space-y-4">
          <div>
            <div className="text-xs mb-1" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.skills.targetAgent")}</div>
            <Select
              className="w-full"
              value={createAgent}
              onChange={(value) => setCreateAgent(value)}
              options={SKILL_AGENTS.map((agent) => ({ value: agent, label: skillAgentLabel(agent, t) }))}
            />
            <div className="text-[11px] mt-1" style={{ color: "var(--cs-text-tertiary)" }}>
              {createScope === "workspace" && (createAgent === "codex" || createAgent === "antigravity")
                ? t("settings.skills.sharedAgentsWorkspaceHint")
                : createAgent === "claude" || createAgent === "codex"
                  ? t("settings.skills.opencodeCompatibilityHint")
                  : t("settings.skills.nativeOnlyHint", { agent: skillAgentLabel(createAgent, t) })}
            </div>
          </div>
          <div>
            <div className="text-xs mb-1" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.skills.skillScope")}</div>
            <Segmented
              block
              value={createScope}
              onChange={(value) => setCreateScope(value as SkillScope)}
              options={[
                { label: t("settings.scope.workspace"), value: "workspace", disabled: !projectPath },
                { label: t("settings.scope.user"), value: "user" },
              ]}
            />
          </div>
          <div>
            <div className="text-xs mb-1" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.skills.skillName")}</div>
            <Input
              placeholder={t("settings.skills.skillNamePlaceholder")}
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
            />
          </div>
          <div>
            <div className="text-xs mb-1" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.shared.description")}</div>
            <Input.TextArea
              rows={4}
              placeholder={t("settings.skills.skillDescriptionPlaceholder")}
              value={createDescription}
              onChange={(e) => setCreateDescription(e.target.value)}
            />
          </div>
        </div>
      </Modal>
    </>
  );
}

const commandShellOptions: Array<{ label: string; value: CommandShell }> = [
  { label: "default", value: "default" },
  { label: "PowerShell", value: "powershell" },
  { label: "CMD", value: "cmd" },
  { label: "Bash", value: "bash" },
];

const commandCwdOptions: Array<{ label: string; value: CommandCwdMode }> = [
  { label: "project", value: "project" },
  { label: "current", value: "current" },
  { label: "custom", value: "custom" },
];

function formatCommandUpdatedAt(updatedAt?: number) {
  if (!updatedAt) return null;
  try {
    return new Date(updatedAt).toLocaleString();
  } catch {
    return null;
  }
}

function formatCommandShellLabel(shell: CommandShell, t: (key: string) => string) {
  switch (shell) {
    case "powershell":
      return "PowerShell";
    case "cmd":
      return "CMD";
    case "bash":
      return "Bash";
    case "default":
    default:
      return t("settings.commands.shell.default");
  }
}

function formatCommandCwdLabel(mode: CommandCwdMode, t: (key: string) => string) {
  switch (mode) {
    case "project":
      return t("settings.commands.cwd.project");
    case "current":
      return t("settings.commands.cwd.current");
    case "custom":
      return t("settings.commands.cwd.custom");
    default:
      return mode;
  }
}

function buildCommandEmptyDraft(scope: CommandScope): CommandDraft {
  return {
    name: "",
    description: "",
    template: "",
    shell: "default",
    cwdMode: scope === "workspace" ? "project" : "current",
    cwdPath: "",
    tags: [],
    requiresConfirm: true,
    runInNewSession: false,
  };
}

function splitCommandTags(input: string) {
  return input
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildCommandEmptyState(params: {
  scope: CommandScope;
  projectPath: string | null;
  search: string;
  t: (key: string) => string;
}) {
  const { scope, projectPath, search, t } = params;
  if (scope === "workspace" && !projectPath) {
    return {
      description: t("settings.commands.openProjectFirst"),
      detail: t("settings.commands.projectCommandsDetail"),
    };
  }

  if (search.trim()) {
    return {
      description: t("settings.commands.emptyFiltered"),
      detail: t("settings.commands.emptyFilteredDetail"),
    };
  }

  return {
    description: t("settings.commands.emptyInitial"),
    detail: t("settings.commands.emptyInitialDetail"),
  };
}

function CommandRow({
  command,
  deleting,
  onDelete,
  onOpen,
}: {
  command: CommandInfo;
  deleting: boolean;
  onDelete: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-center gap-4 px-4 py-3 transition-colors cursor-pointer"
      style={{ borderBottom: "1px solid var(--cs-border-card)" }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--cs-bg-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
      onClick={onOpen}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <CodeOutlined style={{ color: "var(--cs-primary)", fontSize: 14 }} />
          <span className="text-sm font-medium" style={{ color: "var(--cs-text-primary)" }}>
            {command.name}
          </span>
          <Tag className="!m-0" color={command.scope === "workspace" ? "blue" : "gold"}>
            {scopeLabel(command.scope, t)}
          </Tag>
          <Tag className="!m-0" color={command.format === "claude_native" ? "cyan" : "purple"}>
            {command.format === "claude_native" ? t("settings.commands.claudeNative") : t("settings.commands.extended")}
          </Tag>
          {command.supportsTestRun && (
            <Tag className="!m-0" color="purple">
              {formatCommandShellLabel(command.shell, t)}
            </Tag>
          )}
        </div>
        <div className="text-[11px] mt-1 line-clamp-2" style={{ color: "var(--cs-text-tertiary)" }}>
          {command.description || command.commandPreview || t("settings.shared.noDescription")}
        </div>
        <div className="text-[10px] mt-1 flex items-center gap-3 flex-wrap" style={{ color: "var(--cs-text-tertiary)" }}>
          {command.supportsTestRun && <span>{formatCommandCwdLabel(command.cwdMode, t)}</span>}
          {command.allowedTools.slice(0, 2).map((tool) => (
            <span key={tool}>@{tool}</span>
          ))}
          {command.tags.slice(0, 3).map((tag) => (
            <span key={tag}>#{tag}</span>
          ))}
          <span>{t("settings.shared.updatedAt", { value: formatCommandUpdatedAt(command.updatedAt) ?? t("common.unknown") })}</span>
        </div>
      </div>
      <Button
        danger
        size="small"
        icon={<DeleteOutlined />}
        loading={deleting}
        onClick={(event) => {
          event.stopPropagation();
          void onDelete();
        }}
      >
        {t("common.delete")}
      </Button>
    </div>
  );
}

function CommandDetailPanel({
  open,
  detail,
  loading,
  testing,
  testResult,
  onClose,
  onOpenConfig,
  onRunTest,
  onEdit,
  onDelete,
}: {
  open: boolean;
  detail: CommandDetail | null;
  loading: boolean;
  testing: boolean;
  testResult: CommandTestResult | null;
  onClose: () => void;
  onOpenConfig: () => void;
  onRunTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Drawer
      title={detail?.command.name ?? t("settings.commands.detailTitle")}
      placement="right"
      width={620}
      open={open}
      onClose={onClose}
      destroyOnClose={false}
    >
      {loading ? (
        <div className="flex justify-center py-10">
          <Spin />
        </div>
      ) : detail ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            <Tag color={detail.command.scope === "workspace" ? "blue" : "gold"}>
              {scopeLabel(detail.command.scope, t)}
            </Tag>
            <Tag color={detail.command.format === "claude_native" ? "cyan" : "purple"}>
              {detail.command.format === "claude_native" ? t("settings.commands.claudeNative") : t("settings.commands.extended")}
            </Tag>
            {detail.command.supportsTestRun && (
              <>
                <Tag color="purple">{formatCommandShellLabel(detail.command.shell, t)}</Tag>
                <Tag color="geekblue">{formatCommandCwdLabel(detail.command.cwdMode, t)}</Tag>
              </>
            )}
          </div>
          <div className="space-y-1">
            <div className="text-xs" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.shared.description")}</div>
            <div className="text-xs leading-6" style={{ color: "var(--cs-text-secondary)" }}>
              {detail.command.description || t("settings.shared.noDescription")}
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-xs" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.commands.commandFile")}</div>
            <div className="text-xs break-all" style={{ color: "var(--cs-text-secondary)" }}>
              {detail.command.filePath}
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-xs" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.shared.directory")}</div>
            <div className="text-xs break-all" style={{ color: "var(--cs-text-secondary)" }}>
              {detail.command.sourceDir}
            </div>
          </div>
          {detail.command.allowedTools.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.commands.allowedTools")}</div>
              <div className="flex gap-2 flex-wrap">
                {detail.command.allowedTools.map((tool) => (
                  <Tag key={tool} className="!m-0">@{tool}</Tag>
                ))}
              </div>
            </div>
          )}
          {detail.command.supportsTestRun && detail.command.cwdMode === "custom" && detail.command.cwdPath && (
            <div className="space-y-1">
              <div className="text-xs" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.commands.customWorkingDirectory")}</div>
              <div className="text-xs break-all" style={{ color: "var(--cs-text-secondary)" }}>
                {detail.command.cwdPath}
              </div>
            </div>
          )}
          <div className="space-y-1">
            <div className="text-xs" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.commands.commandContent")}</div>
            <div
              className="rounded-xl p-3 text-xs break-all font-mono whitespace-pre-wrap"
              style={{
                background: "var(--cs-bg-hover)",
                color: "var(--cs-text-secondary)",
                border: "1px solid var(--cs-border-card)",
              }}
            >
              {detail.command.template}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button icon={<FolderOpenOutlined />} onClick={onOpenConfig}>
              {t("settings.commands.openCommandFile")}
            </Button>
            {detail.command.supportsTestRun && (
              <Button icon={<PlayCircleOutlined />} type="primary" loading={testing} onClick={onRunTest}>
                {t("settings.commands.testRun")}
              </Button>
            )}
            <Button onClick={onEdit}>{t("settings.commands.editCommand")}</Button>
            <Button danger icon={<DeleteOutlined />} onClick={onDelete}>
              {t("settings.commands.deleteCommand")}
            </Button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div
              className="rounded-xl p-3"
              style={{
                background: "var(--cs-bg-hover)",
                border: "1px solid var(--cs-border-card)",
              }}
            >
              <div className="text-xs mb-1" style={{ color: "var(--cs-text-tertiary)" }}>
                {detail.command.supportsTestRun ? t("settings.commands.runStrategy") : t("settings.commands.commandInfo")}
              </div>
              <div className="text-xs leading-6" style={{ color: "var(--cs-text-secondary)" }}>
                {detail.command.supportsTestRun ? (
                  <>
                    <div>{t("settings.commands.confirmBeforeRun")}: {detail.command.requiresConfirm ? t("settings.shared.yes") : t("settings.shared.no")}</div>
                    <div>{t("settings.commands.runInNewSession")}: {detail.command.runInNewSession ? t("settings.shared.yes") : t("settings.shared.no")}</div>
                  </>
                ) : (
                  <div>{t("settings.commands.noLocalTestRun")}</div>
                )}
                <div>{t("settings.commands.updatedTime")}: {formatCommandUpdatedAt(detail.command.updatedAt) ?? t("common.unknown")}</div>
              </div>
            </div>
            <div
              className="rounded-xl p-3"
              style={{
                background: "var(--cs-bg-hover)",
                border: "1px solid var(--cs-border-card)",
              }}
            >
              <div className="text-xs mb-1" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.commands.tags")}</div>
              <div className="flex gap-2 flex-wrap">
                {detail.command.tags.length > 0 ? (
                  detail.command.tags.map((tag) => (
                    <Tag key={tag} className="!m-0">#{tag}</Tag>
                  ))
                ) : (
                  <span className="text-xs" style={{ color: "var(--cs-text-secondary)" }}>{t("settings.commands.noTags")}</span>
                )}
              </div>
            </div>
          </div>
          {testResult && (
            <div
              className="rounded-xl p-4"
              style={{
                background: "var(--cs-bg-hover)",
                border: "1px solid var(--cs-border-card)",
              }}
            >
              <div className="flex items-center gap-2 flex-wrap mb-3">
                <Tag color={testResult.success ? "green" : "red"}>
                  {testResult.success ? t("settings.commands.runSuccess") : t("settings.commands.runFailed")}
                </Tag>
                <Tag color="blue">
                  {t("settings.commands.exitCode")} {testResult.exitCode ?? t("common.unknown")}
                </Tag>
                <Tag color="purple">
                  {formatCommandShellLabel(testResult.shell, t)}
                </Tag>
                <Tag color="geekblue">
                  {testResult.durationMs} ms
                </Tag>
              </div>
              <div className="space-y-3 text-xs">
                <div>
                  <div className="mb-1" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.commands.resolvedCommand")}</div>
                  <pre className="whitespace-pre-wrap font-mono" style={{ color: "var(--cs-text-secondary)" }}>
                    {testResult.resolvedCommand}
                  </pre>
                </div>
                <div>
                  <div className="mb-1" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.commands.workingDirectory")}</div>
                  <pre className="whitespace-pre-wrap font-mono" style={{ color: "var(--cs-text-secondary)" }}>
                    {testResult.workingDirectory}
                  </pre>
                </div>
                <div>
                  <div className="mb-1" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.commands.stdout")}</div>
                  <pre className="whitespace-pre-wrap font-mono" style={{ color: "var(--cs-text-secondary)" }}>
                    {testResult.stdout || t("settings.commands.emptyOutput")}
                  </pre>
                </div>
                <div>
                  <div className="mb-1" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.commands.stderr")}</div>
                  <pre className="whitespace-pre-wrap font-mono" style={{ color: "var(--cs-text-secondary)" }}>
                    {testResult.stderr || t("settings.commands.emptyOutput")}
                  </pre>
                </div>
              </div>
            </div>
          )}
          <div
            className="rounded-xl p-4"
            style={{
              background: "var(--cs-bg-hover)",
              border: "1px solid var(--cs-border-card)",
            }}
          >
            <pre
              className="text-xs leading-relaxed whitespace-pre-wrap font-mono"
              style={{ color: "var(--cs-text-secondary)" }}
            >
              {detail.content}
            </pre>
          </div>
        </div>
      ) : (
        <Empty description={t("settings.commands.selectCommand")} />
      )}
    </Drawer>
  );
}

function CommandsPage() {
  const { t } = useTranslation();
  const currentProject = useAppStore((s) => s.currentProject);
  const projectPath = currentProject?.path ?? null;
  const [catalog, setCatalog] = useState<CommandCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [activeScope, setActiveScope] = useState<CommandScope>(projectPath ? "workspace" : "user");
  const [selectedCommand, setSelectedCommand] = useState<CommandInfo | null>(null);
  const [detail, setDetail] = useState<CommandDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<CommandTestResult | null>(null);
  const [page, setPage] = useState(1);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingCommand, setEditingCommand] = useState<CommandInfo | null>(null);
  const [draftScope, setDraftScope] = useState<CommandScope>(projectPath ? "workspace" : "user");
  const [draft, setDraft] = useState<CommandDraft>(() => buildCommandEmptyDraft(projectPath ? "workspace" : "user"));
  const [tagsInput, setTagsInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CommandInfo | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadCatalog = useCallback(async (silent = false) => {
    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    try {
      const next = await listCommands(projectPath);
      setCatalog(next);
    } catch (error) {
      console.error("Failed to load commands:", error);
      message.error(t("settings.commands.loadFailed"));
    } finally {
      if (silent) {
        setRefreshing(false);
      } else {
        setLoading(false);
      }
    }
  }, [projectPath]);

  useEffect(() => {
    if (!projectPath) {
      setActiveScope("user");
      setDraftScope("user");
      setDraft((prev) => ({
        ...prev,
        cwdMode: prev.cwdMode === "project" ? "current" : prev.cwdMode,
      }));
    }
  }, [projectPath]);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    setPage(1);
  }, [search, activeScope, catalog?.commands]);

  const baseFilteredCommands = useMemo(() => {
    const allCommands = catalog?.commands ?? [];
    const keyword = search.trim().toLowerCase();
    return allCommands.filter((command) => {
      if (!keyword) return true;
      return [
        command.name,
        command.description,
        command.template,
        command.commandPreview,
        command.filePath,
        command.sourceDir,
        ...command.tags,
      ]
        .join(" ")
        .toLowerCase()
        .includes(keyword);
    });
  }, [catalog?.commands, search]);

  const workspaceCount = baseFilteredCommands.filter((command) => command.scope === "workspace").length;
  const userCount = baseFilteredCommands.filter((command) => command.scope === "user").length;
  const filteredCommands = baseFilteredCommands.filter((command) => command.scope === activeScope);
  const pagedCommands = filteredCommands.slice(
    (page - 1) * SETTINGS_LIST_PAGE_SIZE,
    page * SETTINGS_LIST_PAGE_SIZE
  );

  async function handleOpenDetail(command: CommandInfo) {
    setSelectedCommand(command);
    setDetail(null);
    setTestResult(null);
    setDetailLoading(true);
    try {
      const next = await getCommandDetail(command.scope, command.id, projectPath);
      setDetail(next);
    } catch (error) {
      console.error("Failed to load command details:", error);
      message.error(t("settings.commands.loadDetailFailed"));
    } finally {
      setDetailLoading(false);
    }
  }

  async function handleOpenConfig(scope: CommandScope) {
    try {
      const configPath = await ensureCommandStore(scope, projectPath);
      await openInFileManager(configPath);
    } catch (error) {
      console.error("Failed to open command config:", error);
      message.error(t("settings.commands.openDirectoryFailed"));
    }
  }

  function openCreateModal(scope: CommandScope) {
    const nextScope = scope === "workspace" && !projectPath ? "user" : scope;
    setEditingCommand(null);
    setDraftScope(nextScope);
    setDraft(buildCommandEmptyDraft(nextScope));
    setTagsInput("");
    setEditorOpen(true);
  }

  function openEditModal(command: CommandInfo) {
    setEditingCommand(command);
    setDraftScope(command.scope);
    setDraft({
      name: command.name,
      description: command.description,
      template: command.template,
      shell: command.shell,
      cwdMode: command.cwdMode,
      cwdPath: command.cwdPath ?? "",
      tags: command.tags,
      requiresConfirm: command.requiresConfirm,
      runInNewSession: command.runInNewSession,
    });
    setTagsInput(command.tags.join(", "));
    setEditorOpen(true);
  }

  function closeEditor() {
    setEditorOpen(false);
    setEditingCommand(null);
  }

  async function handleSaveCommand() {
    const payload: CommandDraft = {
      ...draft,
      description: draft.description?.trim() ?? "",
      template: draft.template?.trim() ?? "",
      cwdMode: draft.cwdMode ?? (draftScope === "workspace" ? "project" : "current"),
      cwdPath: draft.cwdMode === "custom" ? draft.cwdPath?.trim() ?? "" : "",
      tags: splitCommandTags(tagsInput),
    };

    if (!payload.name?.trim()) {
      message.warning(t("settings.commands.enterCommandName"));
      return;
    }
    if (!payload.template?.trim()) {
      message.warning(t("settings.commands.enterCommandTemplate"));
      return;
    }
    if (payload.cwdMode === "custom" && !payload.cwdPath?.trim()) {
      message.warning(t("settings.commands.enterCustomWorkingDirectory"));
      return;
    }

    setSaving(true);
    try {
      const saved = editingCommand
        ? await updateCommand(editingCommand.scope, editingCommand.id, payload, projectPath)
        : await createCommand(draftScope, payload, projectPath);
      closeEditor();
      message.success(
        editingCommand
          ? t("settings.commands.updateSuccess", { name: saved.name })
          : t("settings.commands.createSuccess", { name: saved.name })
      );
      setActiveScope(saved.scope);
      await loadCatalog(true);
      await handleOpenDetail(saved);
    } catch (error) {
      console.error("Failed to save command:", error);
      message.error(t("settings.commands.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) {
      return;
    }
    const target = deleteTarget;
    setDeletingId(target.id);
    try {
      await deleteCommand(target.scope, target.id, projectPath);
      setCatalog((prev) =>
        prev
          ? {
              ...prev,
              commands: prev.commands.filter((item) => item.id !== target.id),
            }
          : prev
      );
      if (selectedCommand?.id === target.id) {
        setSelectedCommand(null);
        setDetail(null);
        setTestResult(null);
      }
      message.success(t("settings.commands.deleteSuccess", { name: target.name }));
      setDeleteTarget(null);
    } catch (error) {
      console.error("Failed to delete command:", error);
      message.error(t("settings.commands.deleteFailed"));
    } finally {
      setDeletingId(null);
    }
  }

  async function handleRunTest(command: CommandInfo) {
    setTestingId(command.id);
    setTestResult(null);
    try {
      const result = await runCommandTest(command.scope, command.id, projectPath);
      setTestResult({
        ...result,
        stdout: stripAnsiEscapeSequences(result.stdout),
        stderr: stripAnsiEscapeSequences(result.stderr),
      });
      if (result.success) {
        message.success(t("settings.commands.testRunSuccess", { name: command.name }));
      } else {
        message.warning(t("settings.commands.testRunNonZeroExit", { name: command.name }));
      }
    } catch (error) {
      console.error("Failed to test run command:", error);
      message.error(typeof error === "string" ? error : t("settings.commands.testRunFailed"));
    } finally {
      setTestingId(null);
    }
  }

  function renderCommandSection() {
    const currentScope = activeScope;
    const directoryPath = currentScope === "workspace" ? catalog?.workspaceDir : catalog?.userDir;
    const totalItems = filteredCommands.length;
    const items = pagedCommands;
    const emptyState = buildCommandEmptyState({
      scope: currentScope,
      projectPath,
      search,
      t,
    });

    return (
      <SettingSection title={`${currentScope === "workspace" ? t("settings.commands.workspaceCommands") : t("settings.commands.userCommands")} (${totalItems})`}>
        <div className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="text-sm font-medium" style={{ color: "var(--cs-text-primary)" }}>
              {currentScope === "workspace" ? t("settings.commands.workspaceCommandsDesc") : t("settings.commands.userCommandsDesc")}
            </div>
            <div className="text-[11px] mt-1 break-all" style={{ color: "var(--cs-text-tertiary)" }}>
              {directoryPath || (currentScope === "workspace" ? t("settings.commands.workspaceDirUnavailable") : t("settings.commands.userDirUnavailable"))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="small"
              icon={<FolderOpenOutlined />}
              onClick={() => handleOpenConfig(currentScope)}
              disabled={currentScope === "workspace" && !projectPath}
            >
              {t("settings.commands.openCommandDirectory")}
            </Button>
            <Button
              size="small"
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => openCreateModal(currentScope)}
              disabled={currentScope === "workspace" && !projectPath}
            >
              {t("settings.commands.newCommand")}
            </Button>
          </div>
        </div>
        {items.length === 0 ? (
          <Empty
            description={emptyState.description}
            style={{ padding: "28px 0" }}
          >
            <div className="text-xs mb-4" style={{ color: "var(--cs-text-tertiary)" }}>
              {emptyState.detail}
            </div>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => openCreateModal(currentScope)}
              disabled={currentScope === "workspace" && !projectPath}
            >
              {t("settings.commands.newCommand")}
            </Button>
          </Empty>
        ) : (
          <>
            {items.map((command) => (
              <CommandRow
                key={command.id}
                command={command}
                deleting={deletingId === command.id}
                onOpen={() => handleOpenDetail(command)}
                onDelete={async () => {
                  setDeleteTarget(command);
                }}
              />
            ))}
            <ListPagination
              current={page}
              onChange={setPage}
              pageSize={SETTINGS_LIST_PAGE_SIZE}
              total={totalItems}
            />
          </>
        )}
      </SettingSection>
    );
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Spin />
      </div>
    );
  }

  return (
    <>
      <SettingsPageHeader
        title={t("settings.menu.commands")}
        description={t("settings.commands.headerDesc")}
        actions={
          <>
            <Button
              icon={<PlusOutlined />}
              type="primary"
              onClick={() => openCreateModal(activeScope)}
              disabled={activeScope === "workspace" && !projectPath}
            >
              {t("settings.commands.newCommand")}
            </Button>
            <Button
              icon={<ReloadOutlined spin={refreshing} />}
              onClick={() => loadCatalog(true)}
            >
              {t("common.refresh")}
            </Button>
          </>
        }
      >
        <div>
          <Input
            allowClear
            prefix={<SearchOutlined style={{ color: "var(--cs-text-tertiary)" }} />}
            placeholder={t("settings.commands.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <ScopeTabs
          value={activeScope}
          workspaceCount={workspaceCount}
          userCount={userCount}
          projectAvailable={!!projectPath}
          onChange={(scope) => setActiveScope(scope as CommandScope)}
        />
      </SettingsPageHeader>

      {renderCommandSection()}

      <CommandDetailPanel
        open={!!selectedCommand}
        detail={detail}
        loading={detailLoading}
        testing={testingId === selectedCommand?.id}
        testResult={testResult}
        onClose={() => {
          setSelectedCommand(null);
          setDetail(null);
          setTestResult(null);
        }}
        onOpenConfig={() => {
          if (selectedCommand) {
            openInFileManager(selectedCommand.filePath).catch(() => {
              message.error(t("settings.commands.openCommandFileFailed"));
            });
          }
        }}
        onRunTest={() => {
          if (selectedCommand) {
            handleRunTest(selectedCommand);
          }
        }}
        onEdit={() => {
          if (detail?.command) {
            openEditModal(detail.command);
          }
        }}
        onDelete={() => {
          if (detail?.command) {
            setDeleteTarget(detail.command);
          }
        }}
      />

      <Modal
        title={editingCommand ? t("settings.commands.editCommand") : t("settings.commands.newCommand")}
        open={editorOpen}
        onCancel={closeEditor}
        onOk={handleSaveCommand}
        confirmLoading={saving}
        okText={editingCommand ? t("settings.shared.save") : t("common.create")}
        destroyOnClose={false}
      >
        <div className="space-y-4">
          <div>
            <div className="text-xs mb-1" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.commands.commandSource")}</div>
            <Segmented
              block
              value={draftScope}
              onChange={(value) => {
                const scope = value as CommandScope;
                setDraftScope(scope);
                setDraft((prev) => ({
                  ...prev,
                  cwdMode: scope === "workspace" ? (prev.cwdMode === "current" ? "project" : prev.cwdMode) : prev.cwdMode,
                }));
              }}
              disabled={!!editingCommand}
              options={[
                { label: t("settings.scope.workspace"), value: "workspace", disabled: !projectPath },
                { label: t("settings.scope.user"), value: "user" },
              ]}
            />
          </div>
          <div>
            <div className="text-xs mb-1" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.commands.commandName")}</div>
            <Input
              placeholder={t("settings.commands.commandNamePlaceholder")}
              value={draft.name}
              onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
            />
          </div>
          <div>
            <div className="text-xs mb-1" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.shared.description")}</div>
            <Input.TextArea
              rows={3}
              placeholder={t("settings.commands.commandDescriptionPlaceholder")}
              value={draft.description}
              onChange={(e) => setDraft((prev) => ({ ...prev, description: e.target.value }))}
            />
          </div>
          <div>
            <div className="text-xs mb-1" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.commands.commandContent")}</div>
            <Input.TextArea
              rows={5}
              placeholder={t("settings.commands.commandContentPlaceholder")}
              value={draft.template}
              onChange={(e) => setDraft((prev) => ({ ...prev, template: e.target.value }))}
            />
            <div className="text-[11px] mt-1" style={{ color: "var(--cs-text-tertiary)" }}>
              {t("settings.commands.commandContentHint")}
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <div className="text-xs mb-1" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.commands.executionShell")}</div>
              <Select
                value={draft.shell}
                options={commandShellOptions.map((option) => ({ ...option, label: formatCommandShellLabel(option.value, t) }))}
                onChange={(value) => setDraft((prev) => ({ ...prev, shell: value }))}
                className="w-full"
              />
            </div>
            <div>
              <div className="text-xs mb-1" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.commands.tags")}</div>
              <Input
                placeholder={t("settings.commands.tagsPlaceholder")}
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
              />
            </div>
          </div>
          <div>
            <div className="text-xs mb-1" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.commands.workingDirectory")}</div>
            <Segmented
              block
              value={draft.cwdMode}
              onChange={(value) => setDraft((prev) => ({ ...prev, cwdMode: value as CommandCwdMode }))}
              options={commandCwdOptions.map((option) => ({
                ...option,
                label: formatCommandCwdLabel(option.value, t),
                disabled: option.value === "project" && !projectPath,
              }))}
            />
          </div>
          {draft.cwdMode === "custom" && (
            <div>
              <div className="text-xs mb-1" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.commands.customWorkingDirectory")}</div>
              <Input
                placeholder={t("settings.commands.customWorkingDirectoryPlaceholder")}
                value={draft.cwdPath}
                onChange={(e) => setDraft((prev) => ({ ...prev, cwdPath: e.target.value }))}
              />
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div
              className="rounded-xl px-3 py-2"
              style={{ background: "var(--cs-bg-hover)", border: "1px solid var(--cs-border-card)" }}
            >
              <div className="text-xs mb-2" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.commands.confirmBeforeRun")}</div>
              <Switch
                checked={draft.requiresConfirm}
                onChange={(checked) => setDraft((prev) => ({ ...prev, requiresConfirm: checked }))}
              />
            </div>
            <div
              className="rounded-xl px-3 py-2"
              style={{ background: "var(--cs-bg-hover)", border: "1px solid var(--cs-border-card)" }}
            >
              <div className="text-xs mb-2" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.commands.runInNewSession")}</div>
              <Switch
                checked={draft.runInNewSession}
                onChange={(checked) => setDraft((prev) => ({ ...prev, runInNewSession: checked }))}
              />
            </div>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!deleteTarget}
        title={t("settings.commands.confirmDeleteTitle")}
        onCancel={() => setDeleteTarget(null)}
        onOk={handleConfirmDelete}
        confirmLoading={!!deleteTarget && deletingId === deleteTarget.id}
        okText={t("settings.commands.confirmDelete")}
        okButtonProps={{ danger: true }}
        cancelText={t("common.cancel")}
        centered
      >
        <div className="text-sm leading-6" style={{ color: "var(--cs-text-secondary)" }}>
          {t("settings.commands.confirmDeleteDesc")}
        </div>
      </Modal>
    </>
  );
}

function formatHookUpdatedAt(updatedAt?: number) {
  if (!updatedAt) return null;
  try {
    return new Date(updatedAt).toLocaleString();
  } catch {
    return null;
  }
}

function formatHookEventLabel(event: string) {
  switch (event.toLowerCase()) {
    case "stop":
      return "Stop";
    case "permissionrequest":
      return "PermissionRequest";
    case "pretooluse":
      return "PreToolUse";
    default:
      return event;
  }
}

function formatHookMatcher(matcher: string, t: (key: string) => string) {
  return matcher.trim() || t("settings.hooks.matchAll");
}

function isDefaultHook(hook: HookInfo) {
  return hook.command.includes("termflow-hook.cjs")
    || hook.command.includes("termflow-agent-hook.cjs")
    || hook.command.includes("termflow-status.js");
}

function buildHookEmptyState(params: {
  agent: HookAgent;
  scope: HookScope;
  projectPath: string | null;
  search: string;
  eventFilter: string;
  t: (key: string, options?: Record<string, string>) => string;
}) {
  const { agent, scope, projectPath, search, eventFilter, t } = params;
  if (scope === "workspace" && !projectPath) {
    return {
      description: t("settings.hooks.openProjectFirst"),
      detail: t("settings.hooks.projectHooksDetail", { agent: hookAgentLabel(agent, t) }),
    };
  }

  const hasAdvancedFilter =
    search.trim().length > 0 || eventFilter !== "all";

  if (hasAdvancedFilter) {
    return {
      description: t("settings.hooks.emptyFiltered"),
      detail: t("settings.hooks.emptyFilteredDetail"),
    };
  }

  return {
    description: t("settings.hooks.emptyInitial"),
    detail: t("settings.hooks.emptyInitialDetail"),
  };
}

function HookRow({
  hook,
  deleting,
  canDelete,
  onDelete,
  onOpen,
}: {
  hook: HookInfo;
  deleting: boolean;
  canDelete: boolean;
  onDelete: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-center gap-4 px-4 py-3 transition-colors cursor-pointer"
      style={{ borderBottom: "1px solid var(--cs-border-card)" }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--cs-bg-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
      onClick={onOpen}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <ApiOutlined style={{ color: "var(--cs-primary)", fontSize: 14 }} />
          <span className="text-sm font-medium" style={{ color: "var(--cs-text-primary)" }}>
            {hook.name}
          </span>
          <Tag className="!m-0" color={hook.agent === "opencode" ? "green" : "geekblue"}>
            {hookAgentLabel(hook.agent, t)}
          </Tag>
          <Tag className="!m-0" color="purple">
            {formatHookEventLabel(hook.event)}
          </Tag>
          {isDefaultHook(hook) && (
            <Tag className="!m-0" color="cyan">
              {t("settings.hooks.default")}
            </Tag>
          )}
        </div>
        <div className="text-[11px] mt-1 line-clamp-2" style={{ color: "var(--cs-text-tertiary)" }}>
          {hook.commandPreview}
        </div>
        <div className="text-[10px] mt-1 flex items-center gap-3 flex-wrap" style={{ color: "var(--cs-text-tertiary)" }}>
          <span>{formatHookMatcher(hook.matcher, t)}</span>
          <span>{hook.configPath}</span>
          <span>{t("settings.shared.updatedAt", { value: formatHookUpdatedAt(hook.updatedAt) ?? t("common.unknown") })}</span>
        </div>
      </div>
      {canDelete && (
        <Button
          danger
          size="small"
          icon={<DeleteOutlined />}
          loading={deleting}
          onClick={(event) => {
            event.stopPropagation();
            void onDelete();
          }}
        >
          {t("common.delete")}
        </Button>
      )}
    </div>
  );
}

function HookDetailPanel({
  open,
  detail,
  loading,
  onClose,
  onOpenConfig,
  onDelete,
  deleting,
  canDelete,
}: {
  open: boolean;
  detail: HookDetail | null;
  loading: boolean;
  onClose: () => void;
  onOpenConfig: () => void;
  onDelete: () => void;
  deleting: boolean;
  canDelete: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Drawer
      title={detail?.hook.name ?? t("settings.hooks.detailTitle")}
      placement="right"
      width={560}
      open={open}
      onClose={onClose}
      destroyOnClose={false}
    >
      {loading ? (
        <div className="flex justify-center py-10">
          <Spin />
        </div>
      ) : detail ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2 flex-wrap">
            <Tag color={detail.hook.agent === "opencode" ? "green" : "geekblue"}>
              {hookAgentLabel(detail.hook.agent, t)}
            </Tag>
            <Tag color="purple">{formatHookEventLabel(detail.hook.event)}</Tag>
            {isDefaultHook(detail.hook) && <Tag color="cyan">{t("settings.hooks.defaultHook")}</Tag>}
          </div>
          {isDefaultHook(detail.hook) && (
            <div
              className="rounded-xl px-3 py-2 text-xs"
              style={{
                background: "color-mix(in srgb, var(--cs-primary) 8%, transparent)",
                border: "1px solid color-mix(in srgb, var(--cs-primary) 20%, transparent)",
                color: "var(--cs-text-secondary)",
              }}
            >
              {t("settings.hooks.defaultHookNotice")}
            </div>
          )}
          <div className="space-y-1">
            <div className="text-xs" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.hooks.matcher")}</div>
            <div className="text-xs break-all" style={{ color: "var(--cs-text-secondary)" }}>
              {formatHookMatcher(detail.hook.matcher, t)}
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-xs" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.hooks.configFile")}</div>
            <div className="text-xs break-all" style={{ color: "var(--cs-text-secondary)" }}>
              {detail.hook.configPath}
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-xs" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.hooks.command")}</div>
            <div
              className="rounded-xl p-3 text-xs break-all font-mono"
              style={{
                background: "var(--cs-bg-hover)",
                color: "var(--cs-text-secondary)",
                border: "1px solid var(--cs-border-card)",
              }}
            >
              {detail.hook.command}
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-xs" style={{ color: "var(--cs-text-tertiary)" }}>{t("settings.hooks.timeout")}</div>
            <div className="text-xs" style={{ color: "var(--cs-text-secondary)" }}>
              {detail.hook.timeout ? `${detail.hook.timeout} ms` : t("settings.hooks.notSet")}
            </div>
          </div>
          <div className="flex gap-2">
            <Button icon={<FolderOpenOutlined />} onClick={onOpenConfig}>
              {t("settings.hooks.openConfigFile")}
            </Button>
            {canDelete && (
              <Button danger icon={<DeleteOutlined />} onClick={onDelete} loading={deleting}>
                {t("settings.hooks.deleteHook")}
              </Button>
            )}
          </div>
          <div
            className="rounded-xl p-4"
            style={{
              background: "var(--cs-bg-hover)",
              border: "1px solid var(--cs-border-card)",
            }}
          >
            <pre
              className="text-xs leading-relaxed whitespace-pre-wrap font-mono"
              style={{ color: "var(--cs-text-secondary)" }}
            >
              {detail.rawConfig}
            </pre>
          </div>
        </div>
      ) : (
        <Empty description={t("settings.hooks.selectHook")} />
      )}
    </Drawer>
  );
}

const HOOK_AGENTS: readonly HookAgent[] = getAgentIdsWithCapability("statusEvents");

function hookAgentLabel(agent: HookAgent, t: (key: string) => string) {
  return t(`settings.hooks.agents.${agent}`);
}

function hookAgentCapabilityKey(agent: HookAgent) {
  return `settings.hooks.agentCapability.${agent}`;
}

function HooksPage() {
  const { t } = useTranslation();
  const currentProject = useAppStore((s) => s.currentProject);
  const projectPath = currentProject?.path ?? null;
  const [activeAgent, setActiveAgent] = useState<HookAgent>("claude");
  const [catalog, setCatalog] = useState<HookCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [search, setSearch] = useState("");
  const [activeScope, setActiveScope] = useState<HookScope>(projectPath ? "workspace" : "user");
  const [eventFilter, setEventFilter] = useState<string>("all");
  const [selectedHook, setSelectedHook] = useState<HookInfo | null>(null);
  const [detail, setDetail] = useState<HookDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HookInfo | null>(null);
  const [page, setPage] = useState(1);

  const loadCatalog = useCallback(async (silent = false) => {
    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    try {
      const next = await listAgentHooks(activeAgent, projectPath);
      setCatalog(next);
    } catch (error) {
      console.error("Failed to load hooks:", error);
      message.error(t("settings.hooks.loadFailed"));
    } finally {
      if (silent) {
        setRefreshing(false);
      } else {
        setLoading(false);
      }
    }
  }, [activeAgent, projectPath]);

  useEffect(() => {
    if (!projectPath) {
      setActiveScope("user");
    }
  }, [projectPath]);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    setPage(1);
  }, [search, activeAgent, activeScope, eventFilter, catalog?.hooks]);

  const eventOptions = useMemo(() => {
    const uniqueEvents = Array.from(
      new Set((catalog?.hooks ?? []).map((hook) => hook.event))
    ).sort((a, b) => a.localeCompare(b));

    return [
      { label: t("settings.hooks.allEvents"), value: "all" },
      ...uniqueEvents.map((event) => ({
        label: formatHookEventLabel(event),
        value: event,
      })),
    ];
  }, [catalog?.hooks]);

  const baseFilteredHooks = useMemo(() => {
    const allHooks = catalog?.hooks ?? [];
    const keyword = search.trim().toLowerCase();
    return allHooks.filter((hook) => {
      if (eventFilter !== "all" && hook.event !== eventFilter) return false;
      if (!keyword) return true;
      return [
        hook.name,
        hook.agent,
        hook.event,
        hook.matcher,
        hook.command,
        hook.commandPreview,
        hook.configPath,
      ]
        .join(" ")
        .toLowerCase()
        .includes(keyword);
    });
  }, [catalog?.hooks, eventFilter, search]);

  const workspaceCount = baseFilteredHooks.filter((hook) => hook.scope === "workspace").length;
  const userCount = baseFilteredHooks.filter((hook) => hook.scope === "user").length;
  const filteredHooks = baseFilteredHooks.filter((hook) => hook.scope === activeScope);
  const pagedHooks = filteredHooks.slice(
    (page - 1) * SETTINGS_LIST_PAGE_SIZE,
    page * SETTINGS_LIST_PAGE_SIZE
  );

  async function handleOpenDetail(hook: HookInfo) {
    setSelectedHook(hook);
    setDetail(null);
    setDetailLoading(true);
    try {
      const next = await getAgentHookDetail(hook.agent, hook.scope, hook.id, projectPath);
      setDetail(next);
    } catch (error) {
      console.error("Failed to load hook details:", error);
      message.error(t("settings.hooks.loadDetailFailed"));
    } finally {
      setDetailLoading(false);
    }
  }

  function handleRequestDelete(hook: HookInfo) {
    setDeleteTarget(hook);
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) {
      return;
    }

    const hook = deleteTarget;
    if (hook.agent !== "claude") {
      setDeleteTarget(null);
      return;
    }
    setDeletingId(hook.id);
    try {
      await deleteClaudeHook(hook.scope, hook.id, projectPath);
      setCatalog((prev) =>
        prev
          ? {
              ...prev,
              hooks: prev.hooks.filter((item) => item.id !== hook.id),
            }
          : prev
      );
      if (selectedHook?.id === hook.id) {
        setSelectedHook(null);
        setDetail(null);
      }
      setDeleteTarget(null);
      message.success(t("settings.hooks.deleteSuccess", { name: hook.name }));
    } catch (error) {
      console.error("Failed to delete hook:", error);
      message.error(t("settings.hooks.deleteFailed"));
    } finally {
      setDeletingId(null);
    }
  }

  async function handleRepair(scope: HookScope) {
    setRepairing(true);
    try {
      const next = await repairAgentHooks(activeAgent, scope, projectPath);
      setCatalog(next);
      message.success(
        scope === "workspace"
          ? t("settings.hooks.repairWorkspaceSuccess", { agent: hookAgentLabel(activeAgent, t) })
          : t("settings.hooks.repairUserSuccess", { agent: hookAgentLabel(activeAgent, t) })
      );
    } catch (error) {
      console.error("Failed to repair hooks:", error);
      message.error(t("settings.hooks.repairFailed"));
    } finally {
      setRepairing(false);
    }
  }

  function renderHookSection() {
    const currentScope = activeScope;
    const configPath = currentScope === "workspace" ? catalog?.workspaceConfigPath : catalog?.userConfigPath;
    const workspaceRepairDisabled = currentScope === "workspace" && (!projectPath || activeAgent !== "claude");
    const totalItems = filteredHooks.length;
    const items = pagedHooks;
    const emptyState = buildHookEmptyState({
      agent: activeAgent,
      scope: currentScope,
      projectPath,
      search,
      eventFilter,
      t,
    });

    return (
      <SettingSection title={`${t("settings.menu.hooks")} (${totalItems})`}>
        <div className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="text-sm font-medium" style={{ color: "var(--cs-text-primary)" }}>
              {t("settings.hooks.listDesc", { agent: hookAgentLabel(activeAgent, t) })}
            </div>
            <div className="text-[11px] mt-1 break-all" style={{ color: "var(--cs-text-tertiary)" }}>
              {configPath || (currentScope === "workspace" ? t("settings.hooks.workspaceConfigUnavailable") : t("settings.hooks.userConfigUnavailable"))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="small"
              icon={<FolderOpenOutlined />}
              onClick={() => configPath && openInFileManager(configPath)}
              disabled={!configPath}
            >
              {t("settings.hooks.openConfigFile")}
            </Button>
            <Button
              size="small"
              type="primary"
              onClick={() => handleRepair(currentScope)}
              loading={repairing}
              disabled={workspaceRepairDisabled}
            >
              {t("settings.hooks.repairDefaultHook")}
            </Button>
          </div>
        </div>
        {items.length === 0 ? (
          <Empty
            description={emptyState.description}
            style={{ padding: "28px 0" }}
          >
            <div
              className="text-xs mb-4"
              style={{ color: "var(--cs-text-tertiary)" }}
            >
              {emptyState.detail}
            </div>
            <Button
              type="primary"
              onClick={() => handleRepair(currentScope)}
              loading={repairing}
              disabled={workspaceRepairDisabled}
            >
              {t("settings.hooks.repairDefaultHook")}
            </Button>
          </Empty>
        ) : (
          <>
            {items.map((hook) => (
              <HookRow
                key={hook.id}
                hook={hook}
                deleting={deletingId === hook.id}
                canDelete={hook.agent === "claude"}
                onOpen={() => handleOpenDetail(hook)}
                onDelete={() => handleRequestDelete(hook)}
              />
            ))}
            <ListPagination
              current={page}
              onChange={setPage}
              pageSize={SETTINGS_LIST_PAGE_SIZE}
              total={totalItems}
            />
          </>
        )}
      </SettingSection>
    );
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Spin />
      </div>
    );
  }

  return (
    <>
      <SettingsPageHeader
        title={t("settings.menu.hooks")}
        description={t("settings.hooks.headerDesc")}
        actions={
          <>
            <Button
              type="primary"
              onClick={() => handleRepair(activeScope)}
              loading={repairing}
              disabled={activeScope === "workspace" && (!projectPath || activeAgent !== "claude")}
            >
              {t("settings.hooks.repairDefaultHook")}
            </Button>
            <Button
              icon={<ReloadOutlined spin={refreshing} />}
              onClick={() => loadCatalog(true)}
            >
              {t("common.refresh")}
            </Button>
          </>
        }
      >
        <div
          className="mb-3 rounded-xl px-3 py-2 text-xs"
          style={{
            background: "color-mix(in srgb, var(--cs-primary) 7%, transparent)",
            border: "1px solid color-mix(in srgb, var(--cs-primary) 16%, transparent)",
            color: "var(--cs-text-secondary)",
          }}
        >
          {t(hookAgentCapabilityKey(activeAgent))}
        </div>
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_auto]">
          <Input
            allowClear
            prefix={<SearchOutlined style={{ color: "var(--cs-text-tertiary)" }} />}
            placeholder={t("settings.hooks.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="flex items-center gap-3 flex-wrap xl:justify-end">
            <Segmented
              size="middle"
              value={activeAgent}
              options={HOOK_AGENTS.map((agent) => ({
                value: agent,
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <AgentIcon agentId={agent} size={14} />
                    {hookAgentLabel(agent, t)}
                  </span>
                ),
              }))}
              onChange={(value) => setActiveAgent(value as HookAgent)}
            />
            <Select
              size="middle"
              value={eventFilter}
              onChange={setEventFilter}
              options={eventOptions}
              style={{ minWidth: 160 }}
            />
          </div>
        </div>
        <ScopeTabs
          value={activeScope}
          workspaceCount={workspaceCount}
          userCount={userCount}
          projectAvailable={!!projectPath}
          onChange={setActiveScope}
        />
      </SettingsPageHeader>

      {renderHookSection()}

      <HookDetailPanel
        open={!!selectedHook}
        detail={detail}
        loading={detailLoading}
        onClose={() => {
          setSelectedHook(null);
          setDetail(null);
        }}
        onDelete={() => {
          if (selectedHook) {
            handleRequestDelete(selectedHook);
          }
        }}
        deleting={deletingId === selectedHook?.id}
        canDelete={selectedHook?.agent === "claude"}
        onOpenConfig={() => {
          if (selectedHook) {
            openInFileManager(selectedHook.configPath).catch(() => {
              message.error(t("settings.hooks.openConfigFailed"));
            });
          }
        }}
      />

      <Modal
        open={!!deleteTarget}
        title={deleteTarget && isDefaultHook(deleteTarget) ? t("settings.hooks.confirmDeleteDefaultTitle") : t("settings.hooks.confirmDeleteTitle")}
        onCancel={() => setDeleteTarget(null)}
        onOk={handleConfirmDelete}
        confirmLoading={!!deleteTarget && deletingId === deleteTarget.id}
        okText={t("settings.hooks.confirmDelete")}
        okButtonProps={{ danger: true }}
        cancelText={t("common.cancel")}
        centered
      >
        <div className="text-sm leading-6" style={{ color: "var(--cs-text-secondary)" }}>
          {deleteTarget
            ? isDefaultHook(deleteTarget)
              ? t("settings.hooks.confirmDeleteDefaultDesc")
              : t("settings.hooks.confirmDeleteDesc")
            : ""}
        </div>
      </Modal>
    </>
  );
}

/* ────────────── MCP Servers Page ────────────── */

interface McpServerFormData {
  name: string;
  serverType: McpServerType;
  command: string;
  args: string;
  env: Array<{ key: string; value: string }>;
  url: string;
  headers: Array<{ key: string; value: string }>;
  cwd: string;
}

const emptyMcpForm: McpServerFormData = {
  name: "",
  serverType: "stdio",
  command: "",
  args: "",
  env: [],
  url: "",
  headers: [],
  cwd: "",
};

function McpServerTypePicker({
  value,
  options,
  onChange,
}: {
  value: McpServerType;
  options: Array<{ value: McpServerType; label: string }>;
  onChange: (value: McpServerType) => void;
}) {
  return (
    <div
      className="flex flex-wrap gap-1 rounded-lg p-1"
      role="radiogroup"
      aria-label="MCP server type"
      style={{ background: "var(--cs-bg-hover)" }}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className="min-h-8 max-w-full rounded-md px-3 py-1 text-left text-sm leading-5 transition-colors"
            style={{
              background: active ? "var(--cs-bg-card)" : "transparent",
              color: active ? "var(--cs-text-primary)" : "var(--cs-text-secondary)",
              boxShadow: active ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function McpServersPage() {
  const { t } = useTranslation();
  const currentProject = useAppStore((s) => s.currentProject);
  const projectPath = currentProject?.path ?? null;
  const mcpAgents = getAgentIdsWithCapability("mcpManagement");
  const [activeAgent, setActiveAgent] = useState<AiAgentId>("claude");
  const usesThreeMcpScopes = activeAgent === "claude" || activeAgent === "qoder";
  const [catalog, setCatalog] = useState<McpServerCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [activeScope, setActiveScope] = useState<McpServerInfo["scope"]>(
    projectPath ? "workspace" : "user"
  );
  const [showForm, setShowForm] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServerInfo | null>(null);
  const [formData, setFormData] = useState<McpServerFormData>({ ...emptyMcpForm });
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<McpServerInfo | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [testingName, setTestingName] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ name: string; success: boolean; message: string } | null>(null);

  const loadCatalog = useCallback(
    async (silent = false) => {
      if (silent) setRefreshing(true);
      else setLoading(true);
      try {
        const next = await listMcpServers(activeAgent, projectPath);
        setCatalog(next);
      } catch (error) {
        console.error("Failed to load MCP servers:", error);
        message.error({
          content: t("settings.mcpServers.loadFailed"),
          duration: 8,
          key: "mcp-server-catalog-load-failed",
        });
      } finally {
        if (silent) setRefreshing(false);
        else setLoading(false);
      }
    },
    [activeAgent, projectPath, t]
  );

  useEffect(() => {
    if (!projectPath) {
      setActiveScope("user");
    } else if (usesThreeMcpScopes) {
      setActiveScope("local");
    } else {
      setActiveScope("workspace");
    }
  }, [projectPath, usesThreeMcpScopes]);

  useEffect(() => {
    closeForm();
    setSearch("");
  }, [activeAgent]);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  const filteredServers = useMemo(() => {
    const all = catalog?.servers ?? [];
    const keyword = search.trim().toLowerCase();
    return all.filter((s) => {
      if (s.scope !== activeScope) return false;
      if (!keyword) return true;
      return [s.name, s.command ?? "", s.url ?? "", ...(s.args ?? [])]
        .join(" ")
        .toLowerCase()
        .includes(keyword);
    });
  }, [catalog?.servers, activeScope, search]);

  const localCount = (catalog?.servers ?? []).filter((s) => s.scope === "local").length;
  const projectCount = (catalog?.servers ?? []).filter((s) => s.scope === "project").length;
  const workspaceCount = (catalog?.servers ?? []).filter((s) => s.scope === "workspace").length;
  const userCount = (catalog?.servers ?? []).filter((s) => s.scope === "user").length;

  function openAddForm() {
    setEditingServer(null);
    setFormData({ ...emptyMcpForm });
    setShowForm(true);
  }

  function openEditForm(server: McpServerInfo) {
    setEditingServer(server);
    setFormData({
      name: server.name,
      serverType: server.serverType,
      command: server.command ?? "",
      args: (server.args ?? []).join("\n"),
      env: Object.entries(server.env ?? {}).map(([key, value]) => ({ key, value })),
      url: server.url ?? "",
      headers: Object.entries(server.headers ?? {}).map(([key, value]) => ({ key, value })),
      cwd: server.cwd ?? "",
    });
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingServer(null);
    setFormData({ ...emptyMcpForm });
  }

  async function handleSave() {
    const name = formData.name.trim();
    if (!name) {
      message.error(t("settings.mcpServers.nameRequired"));
      return;
    }
    if (formData.serverType === "stdio" && !formData.command.trim()) {
      message.error(t("settings.mcpServers.commandRequired"));
      return;
    }
    if (formData.serverType !== "stdio" && !formData.url.trim()) {
      message.error(t("settings.mcpServers.urlRequired"));
      return;
    }

    const envObj: Record<string, string> = {};
    for (const { key, value } of formData.env) {
      const k = key.trim();
      if (k) envObj[k] = value;
    }
    const headersObj: Record<string, string> = {};
    for (const { key, value } of formData.headers) {
      const k = key.trim();
      if (k) headersObj[k] = value;
    }

    const config: McpServerConfig = {
      ...(formData.serverType !== "stdio"
        ? { type: formData.serverType, url: formData.url.trim() }
        : {
            command: formData.command.trim(),
            args: formData.args
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
          }),
      ...(Object.keys(envObj).length > 0 ? { env: envObj } : {}),
      ...(Object.keys(headersObj).length > 0 ? { headers: headersObj } : {}),
      ...(formData.cwd.trim() ? { cwd: formData.cwd.trim() } : {}),
    };

    setSaving(true);
    try {
      if (editingServer) {
        const updated = await updateMcpServer(activeAgent, activeScope, name, config, projectPath);
        setCatalog((prev) =>
          prev
            ? {
                ...prev,
                servers: prev.servers.map((s) =>
                  s.name === editingServer.name && s.scope === activeScope ? updated : s
                ),
              }
            : prev
        );
        message.success(t("settings.mcpServers.updateSuccess", { name }));
      } else {
        const added = await addMcpServer(activeAgent, activeScope, name, config, projectPath);
        setCatalog((prev) =>
          prev ? { ...prev, servers: [...prev.servers, added] } : prev
        );
        message.success(t("settings.mcpServers.addSuccess", { name }));
      }
      closeForm();
    } catch (error) {
      console.error("Failed to save MCP server:", error);
      message.error(
        editingServer
          ? t("settings.mcpServers.updateFailed")
          : t("settings.mcpServers.addFailed")
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteMcpServer(activeAgent, deleteTarget.scope, deleteTarget.name, projectPath);
      setCatalog((prev) =>
        prev
          ? {
              ...prev,
              servers: prev.servers.filter(
                (s) => !(s.name === deleteTarget.name && s.scope === deleteTarget.scope)
              ),
            }
          : prev
      );
      message.success(t("settings.mcpServers.deleteSuccess", { name: deleteTarget.name }));
      setDeleteTarget(null);
    } catch (error) {
      console.error("Failed to delete MCP server:", error);
      message.error(t("settings.mcpServers.deleteFailed"));
    } finally {
      setDeleting(false);
    }
  }

  async function handleTest(server: McpServerInfo) {
    setTestingName(server.name);
    setTestResult(null);
    try {
      const result = await testMcpServer(activeAgent, server.scope, server.name, projectPath);
      setTestResult({
        name: server.name,
        success: result.success,
        message: stripAnsiEscapeSequences(result.message),
      });
    } catch (error) {
      console.error("Failed to test MCP server:", error);
      setTestResult({
        name: server.name,
        success: false,
        message: stripAnsiEscapeSequences(String(error)),
      });
    } finally {
      setTestingName(null);
    }
  }

  function addEnvRow() {
    setFormData((prev) => ({
      ...prev,
      env: [...prev.env, { key: "", value: "" }],
    }));
  }

  function updateEnvRow(index: number, field: "key" | "value", val: string) {
    setFormData((prev) => ({
      ...prev,
      env: prev.env.map((item, i) => (i === index ? { ...item, [field]: val } : item)),
    }));
  }

  function removeEnvRow(index: number) {
    setFormData((prev) => ({
      ...prev,
      env: prev.env.filter((_, i) => i !== index),
    }));
  }

  function addHeaderRow() {
    setFormData((prev) => ({ ...prev, headers: [...prev.headers, { key: "", value: "" }] }));
  }

  function updateHeaderRow(index: number, field: "key" | "value", val: string) {
    setFormData((prev) => ({
      ...prev,
      headers: prev.headers.map((item, i) => (i === index ? { ...item, [field]: val } : item)),
    }));
  }

  function removeHeaderRow(index: number) {
    setFormData((prev) => ({ ...prev, headers: prev.headers.filter((_, i) => i !== index) }));
  }

  const configPath =
    catalog?.scopeConfigPaths?.[activeScope] ??
    (activeScope === "workspace"
      ? catalog?.workspaceConfigPath
      : activeScope === "user"
        ? catalog?.userConfigPath
        : undefined);
  const serverTypeOptions: Array<{ value: McpServerType; label: string }> = [
    { value: "stdio", label: t("settings.mcpServers.serverTypeStdio") },
    { value: "http", label: t("settings.mcpServers.serverTypeHttp") },
    ...(activeAgent === "codex" || activeAgent === "opencode" || activeAgent === "antigravity"
      ? []
      : [
          { value: "sse" as const, label: t("settings.mcpServers.serverTypeSSE") },
          ...(activeAgent === "qoder"
            ? [{ value: "ws" as const, label: t("settings.mcpServers.serverTypeWs") }]
            : []),
        ]),
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spin />
      </div>
    );
  }

  return (
    <>
      <SettingsPageHeader
        title={t("settings.mcpServers.title")}
        description={t("settings.mcpServers.headerDesc", { agent: AGENT_DEFINITIONS[activeAgent].displayName })}
        actions={
          <>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => loadCatalog(true)}
              loading={refreshing}
            />
            <Button
              size="small"
              type="primary"
              icon={<PlusOutlined />}
              onClick={openAddForm}
            >
              {t("settings.mcpServers.addServer")}
            </Button>
          </>
        }
      >
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex flex-wrap items-center gap-3">
            <Select
              value={activeAgent}
              onChange={(agent) => setActiveAgent(agent as AiAgentId)}
              options={mcpAgents.map((agent) => ({
                value: agent,
                label: (
                  <span className="flex items-center gap-2">
                    <AgentIcon agentId={agent} size={16} />
                    {AGENT_DEFINITIONS[agent].displayName}
                  </span>
                ),
              }))}
              className="min-w-40"
              size="small"
            />
            <Segmented
              value={activeScope}
              onChange={(val) => setActiveScope(val as McpServerInfo["scope"])}
              options={
                usesThreeMcpScopes
                  ? [
                      {
                        value: "local",
                        label: `${t("settings.mcpServers.localServers")} (${localCount})`,
                        disabled: !projectPath,
                      },
                      {
                        value: "project",
                        label: `${t("settings.mcpServers.projectServers")} (${projectCount})`,
                        disabled: !projectPath,
                      },
                      {
                        value: "user",
                        label: `${t("settings.mcpServers.userServers")} (${userCount})`,
                      },
                    ]
                  : [
                      {
                        value: "workspace",
                        label: `${t("settings.mcpServers.workspaceServers")} (${workspaceCount})`,
                        disabled: !projectPath,
                      },
                      {
                        value: "user",
                        label: `${t("settings.mcpServers.userServers")} (${userCount})`,
                      },
                    ]
              }
            />
          </div>
          <div className="flex w-full min-w-0 items-center gap-2 lg:w-auto lg:max-w-[50%]">
            <span className="min-w-0 flex-1 text-[11px] break-all" style={{ color: "var(--cs-text-tertiary)" }}>
              {configPath || ((activeScope === "workspace" || activeScope === "local" || activeScope === "project")
                ? t("settings.mcpServers.workspaceConfigUnavailable")
                : "")}
            </span>
            {configPath && (
              <Button
                type="link"
                size="small"
                icon={<FolderOpenOutlined />}
                onClick={() => openInFileManager(configPath)}
              />
            )}
          </div>
        </div>
        <Input
          prefix={<SearchOutlined style={{ color: "var(--cs-text-tertiary)" }} />}
          placeholder={t("settings.mcpServers.searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
          size="small"
        />
      </SettingsPageHeader>

      {/* Server list */}
      {filteredServers.length === 0 ? (
        <div className="px-4 py-8">
          <Empty
            description={
              search
                ? t("settings.mcpServers.emptyFiltered")
                : t("settings.mcpServers.emptyInitial")
            }
          >
            <div className="text-xs mt-1" style={{ color: "var(--cs-text-tertiary)" }}>
              {search
                ? t("settings.mcpServers.emptyFilteredDetail")
                : t("settings.mcpServers.emptyInitialDetail")}
            </div>
          </Empty>
        </div>
      ) : (
        <div className="px-4 space-y-2 pb-4">
          {filteredServers.map((server) => {
            const isRemote = server.serverType !== "stdio";
            const preview = isRemote
              ? server.url
              : [server.command, ...(server.args ?? [])].filter(Boolean).join(" ");
            const isTesting = testingName === server.name;
            const hasTestResult = testResult?.name === server.name;

            return (
              <div
                key={`${server.scope}:${server.name}`}
                className="rounded-lg px-4 py-3 transition-colors"
                style={{
                  background: "var(--cs-bg-card)",
                  border: "1px solid var(--cs-border-card)",
                }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="min-w-0 text-sm font-medium truncate"
                        style={{ color: "var(--cs-text-primary)" }}
                      >
                        {server.name}
                      </span>
                      <Tag
                        color={isRemote ? "cyan" : "blue"}
                        className="!m-0 shrink-0 !text-[10px]"
                      >
                        {server.serverType === "stdio" ? "Stdio" : server.serverType.toUpperCase()}
                      </Tag>
                    </div>
                    {preview && (
                      <div
                        className="text-xs mt-1 truncate font-mono"
                        style={{ color: "var(--cs-text-tertiary)" }}
                      >
                        {preview}
                      </div>
                    )}
                    {Object.keys(server.env ?? {}).length > 0 && (
                      <div className="text-[10px] mt-1" style={{ color: "var(--cs-text-tertiary)" }}>
                        env: {Object.keys(server.env).join(", ")}
                      </div>
                    )}
                    {/* Test result */}
                    {hasTestResult && (
                      <div
                        className="text-xs mt-1.5 flex items-start gap-1.5 break-words"
                        style={{ color: testResult!.success ? "var(--cs-success)" : "var(--cs-error)" }}
                      >
                        {testResult!.success ? <CheckOutlined /> : <DeleteOutlined />}
                        {testResult!.message}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Tooltip title={t("settings.mcpServers.testServer")}>
                      <Button
                        type="text"
                        size="small"
                        icon={<NodeIndexOutlined />}
                        loading={isTesting}
                        onClick={() => handleTest(server)}
                      />
                    </Tooltip>
                    <Tooltip title={t("settings.mcpServers.editServer")}>
                      <Button
                        type="text"
                        size="small"
                        icon={<EditOutlined />}
                        onClick={() => openEditForm(server)}
                      />
                    </Tooltip>
                    <Tooltip title={t("settings.mcpServers.deleteServer")}>
                      <Popconfirm
                        title={t("settings.mcpServers.confirmDeleteTitle")}
                        description={t("settings.mcpServers.confirmDeleteDesc", { agent: AGENT_DEFINITIONS[activeAgent].displayName })}
                        onConfirm={() => setDeleteTarget(server)}
                        okText={t("settings.mcpServers.confirmDelete")}
                        cancelText={t("settings.mcpServers.cancel")}
                        okButtonProps={{ danger: true }}
                      >
                        <Button
                          type="text"
                          size="small"
                          danger
                          icon={<DeleteOutlined />}
                        />
                      </Popconfirm>
                    </Tooltip>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add/Edit Form Modal */}
      <Modal
        open={showForm}
        title={
          editingServer
            ? t("settings.mcpServers.editServer")
            : t("settings.mcpServers.addServer")
        }
        onCancel={closeForm}
        onOk={handleSave}
        confirmLoading={saving}
        okText={t("settings.mcpServers.save")}
        cancelText={t("settings.mcpServers.cancel")}
        centered
        width={520}
      >
        <div className="space-y-4 py-2">
          {/* Name */}
          <div>
            <label className="text-sm mb-1.5 block" style={{ color: "var(--cs-text-primary)" }}>
              {t("settings.mcpServers.serverName")}
            </label>
            <Input
              value={formData.name}
              onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
              placeholder={t("settings.mcpServers.serverNamePlaceholder")}
              disabled={!!editingServer}
            />
          </div>

          {/* Type */}
          <div>
            <label className="text-sm mb-1.5 block" style={{ color: "var(--cs-text-primary)" }}>
              {t("settings.mcpServers.serverType")}
            </label>
            <McpServerTypePicker
              value={formData.serverType}
              onChange={(serverType) => setFormData((prev) => ({ ...prev, serverType }))}
              options={serverTypeOptions}
            />
          </div>

          {/* Stdio fields */}
          {formData.serverType === "stdio" && (
            <>
              <div>
                <label className="text-sm mb-1.5 block" style={{ color: "var(--cs-text-primary)" }}>
                  {t("settings.mcpServers.command")}
                </label>
                <Input
                  value={formData.command}
                  onChange={(e) => setFormData((prev) => ({ ...prev, command: e.target.value }))}
                  placeholder={t("settings.mcpServers.commandPlaceholder")}
                />
              </div>
              <div>
                <label className="text-sm mb-1.5 block" style={{ color: "var(--cs-text-primary)" }}>
                  {t("settings.mcpServers.args")}
                </label>
                <Input.TextArea
                  value={formData.args}
                  onChange={(e) => setFormData((prev) => ({ ...prev, args: e.target.value }))}
                  placeholder={t("settings.mcpServers.argsPlaceholder")}
                  autoSize={{ minRows: 2, maxRows: 6 }}
                />
              </div>
              <div>
                <label className="text-sm mb-1.5 block" style={{ color: "var(--cs-text-primary)" }}>
                  {t("settings.mcpServers.cwd")}
                </label>
                <Input
                  value={formData.cwd}
                  onChange={(e) => setFormData((prev) => ({ ...prev, cwd: e.target.value }))}
                  placeholder={t("settings.mcpServers.cwdPlaceholder")}
                />
              </div>
            </>
          )}

          {/* Remote transport fields */}
          {formData.serverType !== "stdio" && (
            <div>
              <label className="text-sm mb-1.5 block" style={{ color: "var(--cs-text-primary)" }}>
                {t("settings.mcpServers.url")}
              </label>
              <Input
                value={formData.url}
                onChange={(e) => setFormData((prev) => ({ ...prev, url: e.target.value }))}
                placeholder={t("settings.mcpServers.urlPlaceholder")}
              />
            </div>
          )}

          {formData.serverType !== "stdio" && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-sm" style={{ color: "var(--cs-text-primary)" }}>
                  {t("settings.mcpServers.headers")}
                </label>
                <Button type="link" size="small" icon={<PlusOutlined />} onClick={addHeaderRow}>
                  {t("settings.mcpServers.addHeader")}
                </Button>
              </div>
              {formData.headers.length > 0 && (
                <div className="space-y-1.5">
                  {formData.headers.map((item, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <Input size="small" value={item.key} onChange={(e) => updateHeaderRow(index, "key", e.target.value)} placeholder={t("settings.mcpServers.headerKey")} className="flex-1" />
                      <Input size="small" value={item.value} onChange={(e) => updateHeaderRow(index, "value", e.target.value)} placeholder={t("settings.mcpServers.headerValue")} className="flex-1" />
                      <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => removeHeaderRow(index)} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Environment Variables */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm" style={{ color: "var(--cs-text-primary)" }}>
                {t("settings.mcpServers.env")}
              </label>
              <Button
                type="link"
                size="small"
                icon={<PlusOutlined />}
                onClick={addEnvRow}
              >
                {t("settings.mcpServers.addEnv")}
              </Button>
            </div>
            {formData.env.length > 0 && (
              <div className="space-y-1.5">
                {formData.env.map((item, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <Input
                      size="small"
                      value={item.key}
                      onChange={(e) => updateEnvRow(index, "key", e.target.value)}
                      placeholder={t("settings.mcpServers.envKey")}
                      className="flex-1"
                    />
                    <Input
                      size="small"
                      value={item.value}
                      onChange={(e) => updateEnvRow(index, "value", e.target.value)}
                      placeholder={t("settings.mcpServers.envValue")}
                      className="flex-1"
                    />
                    <Button
                      type="text"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => removeEnvRow(index)}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        open={!!deleteTarget}
        title={t("settings.mcpServers.confirmDeleteTitle")}
        onCancel={() => setDeleteTarget(null)}
        onOk={handleDelete}
        confirmLoading={deleting}
        okText={t("settings.mcpServers.confirmDelete")}
        okButtonProps={{ danger: true }}
        cancelText={t("settings.mcpServers.cancel")}
        centered
      >
        <div className="text-sm leading-6" style={{ color: "var(--cs-text-secondary)" }}>
          {t("settings.mcpServers.confirmDeleteDesc", { agent: AGENT_DEFINITIONS[activeAgent].displayName })}
        </div>
      </Modal>
    </>
  );
}

/* ────────────── About Page ────────────── */
const ABOUT_FLOW_VERTEX_SHADER = `
  attribute vec2 aPosition;

  void main() {
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

const ABOUT_FLOW_FRAGMENT_SHADER = `
  precision highp float;

  uniform vec2 uResolution;
  uniform float uTime;
  uniform float uEnergy;
  uniform vec3 uBaseColor;
  uniform vec3 uPaleColor;
  uniform vec3 uVividColor;
  uniform vec3 uCobaltColor;
  uniform vec3 uDeepColor;
  uniform vec3 uHighlightColor;

  float hash(vec2 point) {
    point = fract(point * vec2(123.34, 456.21));
    point += dot(point, point + 45.32);
    return fract(point.x * point.y);
  }

  float noise(vec2 point) {
    vec2 cell = floor(point);
    vec2 local = fract(point);
    local = local * local * (3.0 - 2.0 * local);

    return mix(
      mix(hash(cell), hash(cell + vec2(1.0, 0.0)), local.x),
      mix(hash(cell + vec2(0.0, 1.0)), hash(cell + vec2(1.0, 1.0)), local.x),
      local.y
    );
  }

  float fbm(vec2 point) {
    float value = 0.0;
    float amplitude = 0.56;
    mat2 rotation = mat2(0.8, 0.6, -0.6, 0.8);

    for (int index = 0; index < 5; index++) {
      value += amplitude * noise(point);
      point = rotation * point * 2.0 + 3.7;
      amplitude *= 0.5;
    }

    return value;
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / uResolution;
    vec2 point = uv * vec2(uResolution.x / uResolution.y, 1.0) * 1.62;
    float time = uTime;

    vec2 flow = vec2(
      fbm(point + time * vec2(0.58, 0.18)),
      fbm(point + time * vec2(-0.38, 0.48) + 5.2)
    );
    vec2 eddy = vec2(
      fbm(point + 2.25 * flow + time * vec2(0.31, -0.42) + 1.7),
      fbm(point + 2.25 * flow + time * vec2(-0.22, 0.34) + 8.3)
    );
    float cloud = fbm(point + 2.55 * eddy);

    vec3 fluid = mix(uPaleColor, uCobaltColor, smoothstep(0.18, 0.64, cloud));
    fluid = mix(fluid, uVividColor, smoothstep(0.48, 0.9, flow.x));
    fluid = mix(fluid, uDeepColor, smoothstep(0.58, 0.94, eddy.y));

    float folded = abs((cloud + 0.44 * eddy.x + 0.18 * flow.y) - 0.73);
    float vein = 1.0 - smoothstep(0.055, 0.2, folded);
    fluid = mix(fluid, uHighlightColor, vein * 0.62);
    fluid += 0.14 * eddy.x * uPaleColor;
    fluid = mix(fluid, fluid * fluid * 1.32 + fluid * 0.1, uEnergy * 0.48);

    // Preserve a clean reading area on the left while avoiding a straight transition boundary.
    float transitionWarp = uv.x + 0.22 * (flow.y - 0.5) + 0.12 * (eddy.x - 0.5);
    float colourZone = smoothstep(0.18, 0.92, transitionWarp);
    float density = smoothstep(0.22, 0.82, cloud + 0.28 * eddy.x);
    float pigment = clamp(colourZone * (0.28 + 0.88 * density), 0.0, 1.0);
    float rightDepth = smoothstep(0.58, 1.0, uv.x + 0.1 * eddy.y);
    fluid = mix(fluid, uDeepColor, rightDepth * 0.34);

    vec3 colour = mix(uBaseColor, fluid, pigment);
    float topGlass = smoothstep(0.56, 1.0, uv.y) * (1.0 - pigment * 0.7);
    colour = mix(colour, uBaseColor, topGlass * 0.34);

    gl_FragColor = vec4(colour, 1.0);
  }
`;

type AboutFlowRgb = readonly [number, number, number];

type AboutFlowPalette = {
  base: AboutFlowRgb;
  pale: AboutFlowRgb;
  vivid: AboutFlowRgb;
  cobalt: AboutFlowRgb;
  deep: AboutFlowRgb;
  highlight: AboutFlowRgb;
};

const parseAboutFlowColor = (value: string): AboutFlowRgb | null => {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value.trim());
  if (!match) return null;

  return [
    Number.parseInt(match[1], 16) / 255,
    Number.parseInt(match[2], 16) / 255,
    Number.parseInt(match[3], 16) / 255,
  ];
};

const readAboutFlowPalette = (): AboutFlowPalette | null => {
  const styles = getComputedStyle(document.documentElement);
  const readColor = (name: string) => parseAboutFlowColor(styles.getPropertyValue(name));
  const base = readColor("--cs-about-flow-base");
  const pale = readColor("--cs-about-flow-pale");
  const vivid = readColor("--cs-about-flow-vivid");
  const cobalt = readColor("--cs-about-flow-cobalt");
  const deep = readColor("--cs-about-flow-deep");
  const highlight = readColor("--cs-about-flow-highlight");

  if (!base || !pale || !vivid || !cobalt || !deep || !highlight) return null;
  return { base, pale, vivid, cobalt, deep, highlight };
};

const parseAboutFlowPalette = (palette: AboutFlowHexPalette): AboutFlowPalette | null => {
  const base = parseAboutFlowColor(palette.base);
  const pale = parseAboutFlowColor(palette.pale);
  const vivid = parseAboutFlowColor(palette.vivid);
  const cobalt = parseAboutFlowColor(palette.cobalt);
  const deep = parseAboutFlowColor(palette.deep);
  const highlight = parseAboutFlowColor(palette.highlight);

  if (!base || !pale || !vivid || !cobalt || !deep || !highlight) return null;
  return { base, pale, vivid, cobalt, deep, highlight };
};

function AboutFlowBackdrop({
  palette,
  animate = true,
  preserveDrawingBuffer = true,
}: {
  palette?: AboutFlowHexPalette;
  animate?: boolean;
  preserveDrawingBuffer?: boolean;
} = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const card = canvas?.closest<HTMLElement>(".app-flow-surface");
    if (!canvas || !card) return;
    canvas.style.visibility = "hidden";

    const initialPalette = palette
      ? parseAboutFlowPalette(palette)
      : readAboutFlowPalette();
    if (!initialPalette) return;

    const gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: false,
      depth: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer,
    });
    if (!gl) return;

    const compileShader = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;

      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vertexShader = compileShader(gl.VERTEX_SHADER, ABOUT_FLOW_VERTEX_SHADER);
    const fragmentShader = compileShader(gl.FRAGMENT_SHADER, ABOUT_FLOW_FRAGMENT_SHADER);
    if (!vertexShader || !fragmentShader) {
      if (vertexShader) gl.deleteShader(vertexShader);
      if (fragmentShader) gl.deleteShader(fragmentShader);
      return;
    }

    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      return;
    }

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return;
    }

    const buffer = gl.createBuffer();
    if (!buffer) {
      gl.deleteProgram(program);
      return;
    }

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const position = gl.getAttribLocation(program, "aPosition");
    const resolution = gl.getUniformLocation(program, "uResolution");
    const time = gl.getUniformLocation(program, "uTime");
    const energy = gl.getUniformLocation(program, "uEnergy");
    const paletteUniforms = {
      base: gl.getUniformLocation(program, "uBaseColor"),
      pale: gl.getUniformLocation(program, "uPaleColor"),
      vivid: gl.getUniformLocation(program, "uVividColor"),
      cobalt: gl.getUniformLocation(program, "uCobaltColor"),
      deep: gl.getUniformLocation(program, "uDeepColor"),
      highlight: gl.getUniformLocation(program, "uHighlightColor"),
    };
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const targetFrameInterval = 1000 / 30;
    let animationFrame = 0;
    let flowTime = 8.4;
    let stirEnergy = 0;
    let previousFrame = performance.now();
    let previousDraw = 0;
    let previousPointer: { x: number; y: number } | null = null;
    let isVisible = true;

    const applyPalette = (palette: AboutFlowPalette) => {
      gl.useProgram(program);
      (Object.keys(paletteUniforms) as Array<keyof AboutFlowPalette>).forEach((key) => {
        const [red, green, blue] = palette[key];
        gl.uniform3f(paletteUniforms[key], red, green, blue);
      });
    };

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1);
      const width = Math.max(1, Math.round(bounds.width * dpr));
      const height = Math.max(1, Math.round(bounds.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
    };

    const draw = (now: number) => {
      if (!isVisible) return;

      const shouldAnimate = animate && !motionQuery.matches && !document.hidden;
      if (
        shouldAnimate &&
        previousDraw > 0 &&
        now - previousDraw < targetFrameInterval
      ) {
        animationFrame = window.requestAnimationFrame(draw);
        return;
      }

      previousDraw = now;
      resize();
      const delta = Math.min((now - previousFrame) / 1000, 0.1);
      previousFrame = now;

      if (shouldAnimate) {
        stirEnergy *= Math.exp(-delta * 1.55);
        flowTime += delta * (0.25 + stirEnergy * 0.82);
      }

      gl.useProgram(program);
      gl.uniform2f(resolution, canvas.width, canvas.height);
      gl.uniform1f(time, flowTime);
      gl.uniform1f(energy, stirEnergy);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      canvas.style.visibility = "visible";

      if (shouldAnimate) {
        animationFrame = window.requestAnimationFrame(draw);
      }
    };

    const restart = () => {
      window.cancelAnimationFrame(animationFrame);
      previousFrame = performance.now();
      if (isVisible) draw(previousFrame);
    };

    const handleThemeChange = () => {
      if (palette) return;
      const currentPalette = readAboutFlowPalette();
      if (!currentPalette) return;
      applyPalette(currentPalette);
      restart();
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!animate || motionQuery.matches) return;
      if (previousPointer) {
        const distance = Math.hypot(event.clientX - previousPointer.x, event.clientY - previousPointer.y);
        stirEnergy = Math.min(1, stirEnergy + distance * 0.012);
      }
      previousPointer = { x: event.clientX, y: event.clientY };
    };

    const clearPointer = () => {
      previousPointer = null;
    };

    const handleDocumentVisibilityChange = () => {
      if (document.hidden) {
        window.cancelAnimationFrame(animationFrame);
      } else {
        restart();
      }
    };

    const resizeObserver = new ResizeObserver(resize);
    const visibilityObserver = new IntersectionObserver(([entry]) => {
      const nextVisible = entry?.isIntersecting ?? true;
      if (nextVisible === isVisible) return;

      isVisible = nextVisible;
      if (isVisible) {
        restart();
      } else {
        window.cancelAnimationFrame(animationFrame);
      }
    });
    const themeObserver = palette ? null : new MutationObserver(handleThemeChange);
    resizeObserver.observe(canvas);
    visibilityObserver.observe(card);
    themeObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    motionQuery.addEventListener("change", restart);
    document.addEventListener("visibilitychange", handleDocumentVisibilityChange);
    if (animate) {
      card.addEventListener("pointermove", handlePointerMove);
      card.addEventListener("pointerleave", clearPointer);
    }
    applyPalette(initialPalette);
    restart();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      themeObserver?.disconnect();
      motionQuery.removeEventListener("change", restart);
      document.removeEventListener("visibilitychange", handleDocumentVisibilityChange);
      card.removeEventListener("pointermove", handlePointerMove);
      card.removeEventListener("pointerleave", clearPointer);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
  }, [animate, palette, preserveDrawingBuffer]);

  const fallbackBackground = palette
    ? `linear-gradient(104deg, ${palette.base} 0%, ${palette.pale} 48%, ${palette.vivid} 72%, ${palette.deep} 100%)`
    : undefined;

  return (
    <div
      aria-hidden="true"
      className="about-flow-backdrop pointer-events-none absolute inset-0 overflow-hidden"
      style={{ background: fallbackBackground }}
    >
      <canvas ref={canvasRef} className="about-flow-canvas absolute inset-0 h-full w-full" />
      <div
        className="about-flow-gloss"
        style={palette ? {
          background: `linear-gradient(180deg, ${palette.base}3d, transparent 38%), radial-gradient(ellipse 78% 150% at 0% 50%, ${palette.base}52, ${palette.vivid}14 48%, transparent 100%)`,
        } : undefined}
      />
    </div>
  );
}
function AboutPage() {
  const { t } = useTranslation();
  const supportedAgents = AI_AGENT_ORDER.map((id) => ({
    id,
    name: AGENT_DEFINITIONS[id].displayName,
  }));
  const productHighlights = [
    {
      key: "agent-orchestration",
      icon: <AppstoreOutlined />,
      title: t("settings.about.agentOrchestration"),
      desc: t("settings.about.agentOrchestrationDesc"),
    },
    {
      key: "context-continuity",
      icon: <ReloadOutlined />,
      title: t("settings.about.contextContinuity"),
      desc: t("settings.about.contextContinuityDesc"),
    },
    {
      key: "local-control",
      icon: <SafetyCertificateOutlined />,
      title: t("settings.about.localControl"),
      desc: t("settings.about.localControlDesc"),
    },
  ];
  const techStack = [
    { label: t("settings.about.framework"), value: "Tauri 2 + React 19" },
    { label: t("settings.about.terminal"), value: "xterm.js + ConPTY" },
    { label: t("settings.about.stateManagement"), value: "Zustand + persist" },
    { label: t("settings.about.appId"), value: "com.termflow.desktop", mono: true },
  ];

  const openAboutLink = (url: string | null) => {
    if (url) void openUrl(url);
  };

  return (
    <div className="space-y-6">
      <div className="app-about-hero app-flow-surface app-glass-card relative overflow-hidden rounded-2xl">
        <AboutFlowBackdrop />
        <div className="app-about-hero-glow-primary pointer-events-none absolute -right-16 -top-28 h-64 w-64 rounded-full blur-3xl" />
        <div className="app-about-hero-glow-secondary pointer-events-none absolute -bottom-24 left-1/3 h-48 w-48 rounded-full blur-3xl" />

        <div className="app-about-hero-content relative flex flex-col gap-6 px-6 py-7 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <img
              src="/logo.png"
              alt="Termflow"
              className="h-16 w-16 shrink-0 object-contain"
            />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="app-about-hero-title m-0 text-2xl font-semibold tracking-tight">
                  Termflow
                </h1>
                <Tag className="app-about-hero-version !m-0 rounded-full !px-2.5">v{packageJson.version}</Tag>
              </div>
              <div className="app-about-hero-subtitle mt-1 text-sm font-medium">
                {t("settings.about.subtitle")}
              </div>
              <div className="app-about-hero-description mt-2 max-w-2xl text-sm leading-6">
                {t("settings.about.headerDesc")}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap gap-2">
            <Button
              icon={<GlobalOutlined />}
              disabled={!ABOUT_LINKS.website}
              onClick={() => openAboutLink(ABOUT_LINKS.website)}
            >
              {t("settings.about.officialWebsite")}
            </Button>
            <Button
              icon={<GithubOutlined />}
              disabled={!ABOUT_LINKS.github}
              onClick={() => openAboutLink(ABOUT_LINKS.github)}
            >
              GitHub
            </Button>
            {!ABOUT_LINKS.website && !ABOUT_LINKS.github && (
              <Tag className="!m-0 flex items-center rounded-full !px-2.5">
                {t("settings.about.comingSoon")}
              </Tag>
            )}
          </div>
        </div>

        <div className="app-about-hero-footer relative flex flex-wrap items-center gap-2 border-t px-6 py-4">
          <span className="app-about-hero-agents-label mr-1 text-xs font-medium">
            {t("settings.about.supportedAgents")}
          </span>
          {supportedAgents.map((agent) => (
            <div
              key={agent.id}
              className="app-about-hero-agent flex items-center gap-1.5 rounded-lg px-2.5 py-1.5"
            >
              <AgentIcon agentId={agent.id} size={15} />
              <span className="text-xs font-medium">{agent.name}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 2xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
        <section
          className="app-glass-card overflow-hidden rounded-2xl p-6"
          style={{ background: "var(--cs-bg-card)", border: "1px solid var(--cs-border-card)" }}
        >
          <div className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--cs-text-tertiary)" }}>
            {t("settings.menu.about")}
          </div>
          <p className="mb-0 mt-4 text-sm leading-7" style={{ color: "var(--cs-text-secondary)" }}>
            {t("settings.about.description")}
          </p>

          <div className="mt-6 text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--cs-text-tertiary)" }}>
            {t("settings.about.capabilities")}
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-3">
            {productHighlights.map((item) => (
              <div
                key={item.key}
                className="rounded-xl p-4"
                style={{ background: "var(--cs-bg-hover)", border: "1px solid var(--cs-border-card)" }}
              >
                <div
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-sm"
                  style={{ color: "var(--cs-primary)", background: "color-mix(in srgb, var(--cs-primary) 12%, transparent)" }}
                >
                  {item.icon}
                </div>
                <div className="mt-3 text-sm font-medium" style={{ color: "var(--cs-text-primary)" }}>{item.title}</div>
                <div className="mt-1.5 text-xs leading-5" style={{ color: "var(--cs-text-tertiary)" }}>{item.desc}</div>
              </div>
            ))}
          </div>

          <div className="mt-5 flex items-center gap-2 text-xs font-medium" style={{ color: "var(--cs-primary)" }}>
            <SafetyCertificateOutlined />
            {t("settings.about.localFirst")}
          </div>
        </section>

        <section
          className="app-glass-card overflow-hidden rounded-2xl"
          style={{ background: "var(--cs-bg-card)", border: "1px solid var(--cs-border-card)" }}
        >
          <div className="px-5 pb-3 pt-5">
            <div className="text-xs font-semibold uppercase tracking-widest" style={{ color: "var(--cs-text-tertiary)" }}>
              {t("settings.about.techStack")}
            </div>
          </div>
          <div className="px-2 pb-2">
            {techStack.map((item) => (
              <div key={item.label} className="flex items-center justify-between gap-4 rounded-xl px-3 py-3 hover:bg-[var(--cs-bg-hover)]">
                <span className="text-sm" style={{ color: "var(--cs-text-secondary)" }}>{item.label}</span>
                <span
                  className={item.mono ? "text-xs font-mono" : "text-sm font-medium"}
                  style={{ color: item.mono ? "var(--cs-text-tertiary)" : "var(--cs-text-primary)" }}
                >
                  {item.value}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

const pageComponents: Record<SettingsPage, React.FC> = {
  general: GeneralPage,
  notifications: NotificationsPage,
  agents: AgentsPage,
  terminal: TerminalPage,
  voiceRecognition: VoiceRecognitionPage,
  shortcuts: ShortcutsPage,
  skills: SkillsPage,
  hooks: HooksPage,
  mcpServers: McpServersPage,
  commands: CommandsPage,
  quickCommands: QuickCommandsPage,
  claudeMd: ClaudeMdPage,
  searchIndex: SearchIndexPage,
  dataPrivacy: DataPrivacyPage,
  archived: ArchivedSessionsPage,
  about: AboutPage,
};

/* ────────────── Main Settings Panel ────────────── */
function SettingsPanel() {
  const { t } = useTranslation();
  const [activePage, setActivePage] = useState<SettingsPage>("general");
  const [menuSearch, setMenuSearch] = useState("");
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const PageComponent = pageComponents[activePage];
  const normalizedMenuSearch = menuSearch.trim().toLocaleLowerCase();
  const visibleMenuGroups = useMemo(
    () => menuGroups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) =>
          t(item.labelKey).toLocaleLowerCase().includes(normalizedMenuSearch)
        ),
      }))
      .filter((group) => group.items.length > 0),
    [normalizedMenuSearch, t]
  );

  const selectPage = (page: SettingsPage) => {
    if (page === activePage) return;
    contentScrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
    setActivePage(page);
  };

  return (
    <div
      className="h-full flex min-h-0"
      style={{ background: "var(--cs-bg-card-solid, var(--cs-bg-card))" }}
    >
      {/* Left nav */}
      <div
        className="app-settings-nav w-16 min-[960px]:w-48 shrink-0 py-5 px-2 min-[960px]:px-3 overflow-y-auto"
        style={{
          borderRight: "1px solid var(--cs-border-sidebar)",
          background: "var(--cs-bg-card-solid, var(--cs-bg-card))",
        }}
      >
        <div className="hidden min-[960px]:block mb-4">
          <Input
            allowClear
            size="small"
            prefix={<SearchOutlined />}
            value={menuSearch}
            placeholder={t("settings.menu.searchPlaceholder")}
            onChange={(event) => setMenuSearch(event.target.value)}
          />
        </div>
        <div className="min-[960px]:hidden mb-4 flex justify-center">
          <Popover
            trigger="click"
            placement="rightTop"
            content={
              <Input
                autoFocus
                allowClear
                prefix={<SearchOutlined />}
                value={menuSearch}
                placeholder={t("settings.menu.searchPlaceholder")}
                onChange={(event) => setMenuSearch(event.target.value)}
                style={{ width: 240 }}
              />
            }
          >
            <button
              type="button"
              className="flex h-9 w-9 items-center justify-center rounded-lg"
              style={{ color: "var(--cs-text-secondary)" }}
              aria-label={t("settings.menu.searchPlaceholder")}
            >
              <SearchOutlined />
            </button>
          </Popover>
        </div>

        {visibleMenuGroups.length === 0 ? (
          <div
            className="px-2 py-4 text-center text-xs"
            style={{ color: "var(--cs-text-tertiary)" }}
          >
            {t("common.noResults")}
          </div>
        ) : visibleMenuGroups.map((group, groupIndex) => (
          <div key={group.key} className={groupIndex > 0 ? "mt-5" : undefined}>
            <div
              className="hidden min-[960px]:block mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider"
              style={{ color: "var(--cs-text-tertiary)" }}
            >
              {t(group.labelKey)}
            </div>
            {group.items.map((item) => {
              const isActive = activePage === item.key;
              const label = t(item.labelKey);
              return (
                <Tooltip key={item.key} title={label} placement="right" mouseEnterDelay={0.6}>
                  <button
                    type="button"
                    className="mb-1 flex w-full items-center justify-center gap-3 rounded-lg px-2 py-2 transition-all min-[960px]:justify-start min-[960px]:px-3"
                    style={{
                      background: isActive ? "var(--cs-bg-active)" : "transparent",
                      color: isActive ? "var(--cs-primary)" : "var(--cs-text-secondary)",
                      fontWeight: isActive ? 500 : 400,
                    }}
                    onMouseEnter={(event) => {
                      if (!isActive) event.currentTarget.style.background = "var(--cs-bg-hover)";
                    }}
                    onMouseLeave={(event) => {
                      if (!isActive) event.currentTarget.style.background = "transparent";
                    }}
                    onClick={() => selectPage(item.key)}
                  >
                    <span className="text-sm opacity-80">{item.icon}</span>
                    <span className="hidden min-[960px]:inline min-w-0 truncate text-sm">
                      {label}
                    </span>
                  </button>
                </Tooltip>
              );
            })}
          </div>
        ))}
      </div>

      {/* Right content */}
      <div
        ref={contentScrollRef}
        className="flex-1 overflow-y-auto min-w-0 flex justify-center"
      >
        <div className="w-full max-w-[1280px] py-6 px-8 xl:px-10">
          <PageComponent />
        </div>
      </div>
    </div>
  );
}

export default SettingsPanel;
