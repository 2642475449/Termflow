import { getHookCommandName, getHookSource, groupHooksBySource, isTermflowHook } from "@/lib/hookPresentation";
import { SkillsSettingsPage } from "./settings/SkillsSettingsPage";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { BackgroundSettings } from "./settings/BackgroundSettings";
import { SettingRow } from "./settings/SettingRow";
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
  DeleteOutlined,
  InboxOutlined,
  FileMarkdownOutlined,
  CloudServerOutlined,
  RobotOutlined,
  GlobalOutlined,

  SafetyCertificateOutlined,
  DatabaseOutlined,
} from "@ant-design/icons";
import { Pagination, Segmented, Tag, Select, Spin, Empty, Button, message, Switch, Input, Drawer, Modal, Tooltip, Popover } from "antd";
import { invoke } from "@tauri-apps/api/core";

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
import { captureShortcutFromEvent, formatShortcutDisplay, toTauriShortcut } from "@/lib/shortcut";
import { stripAnsiEscapeSequences } from "@/lib/textContent";
import { TERMINAL_SCROLLBACK_OPTIONS } from "@/lib/terminalSettings";
import {
  createCommand,
  ensureCommandStore,
  getCommandDetail,
  getAgentHookDetail,
  deleteCommand,
  deleteClaudeHook,
  listCommands,
  listAgentHooks,
  repairAgentHooks,
  migrateWorkspaceClaudeHooks,
  runCommandTest,
  openInFileManager,
  updateCommand,
  listMcpServers,
  addMcpServer,
  updateMcpServer,
  deleteMcpServer,
  testMcpServer,
  setExplorerContextMenuEnabled,
  configureVoiceGlobalShortcut,
  startLiveAsr,
  finishLiveAsr,
  polishVoiceText,
} from "@/lib/api";
import { VoicePolishModePicker } from "@/components/settings/VoicePolishModePicker";
import { VoiceSettingsDisclosure, VoiceSettingsField, VoiceSettingsSection } from "@/components/settings/VoiceSettingsLayout";
import "@/styles/voiceSettings.css";
import { availableVoicePolishModels, resolveVoicePolishModel } from "@/lib/voicePolish";
import { VoiceProviderLabel } from "@/components/settings/VoiceProviderLabel";
import type {
  CommandCatalog,
  CommandCwdMode,
  CommandDetail,
  CommandDraft,
  CommandInfo,
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
import { ShortcutsPage } from "./settings/ShortcutsPage";
import { findShortcutConflict } from "@/lib/appShortcuts";
import { useShortcutStore } from "@/store/slices/shortcutSlice";
import ClaudeMdPage from "@/components/settings/ClaudeMdPage";
import { QuickCommandsPage } from "@/components/settings/QuickCommandsPage";
import { AgentIcon } from "@/components/AgentIcon";
import { GitIcon } from "@/components/GitIcon";
import { AgentsPage } from "@/components/settings/AgentsPage";
import { GitSettingsPage } from "@/components/settings/GitSettingsPage";
import { ArchivedSessionsPage } from "@/components/settings/ArchivedSessionsPage";
import { DataPrivacyPage } from "@/components/settings/DataPrivacyPage";
import { SearchIndexPage } from "@/components/settings/SearchIndexPage";
import { McpServersView } from "@/components/settings/McpServersView";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";
import { SettingsSection as SettingSection } from "@/components/settings/SettingsSection";
import { NotificationsPage } from "@/components/settings/NotificationsPage";
import { AboutPage } from "@/components/settings/AboutPage";
import { NetworkSettingsPage } from "@/components/settings/NetworkSettingsPage";
import {
  AGENT_DEFINITIONS,

  getAgentIdsWithCapability,
} from "@/lib/agents";



type SettingsPage = "general" | "network" | "notifications" | "agents" | "git" | "terminal" | "voiceRecognition" | "shortcuts" | "skills" | "hooks" | "mcpServers" | "commands" | "quickCommands" | "claudeMd" | "searchIndex" | "dataPrivacy" | "archived" | "about";

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
      { key: "network", icon: <GlobalOutlined />, labelKey: "settings.menu.network" },
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
      { key: "git", icon: <GitIcon />, labelKey: "settings.menu.git" },
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
  category: "light" | "dark";
}


const themeOptions: ThemeOption[] = [
  {
    key: "dark-starry",
    labelKey: "settings.theme.dark-starry.label",
    category: "dark",
  },
  {
    key: "dark-mocha",
    labelKey: "settings.theme.dark-mocha.label",
    category: "dark",
  },
  {
    key: "light-glass",
    labelKey: "settings.theme.light-glass.label",
    category: "light",
  },
  {
    key: "light-warm",
    labelKey: "settings.theme.light-warm.label",
    category: "light",
  },
];

/* ────────────── Theme Card ────────────── */
function ThemeCard({ opt, isActive, onClick, tabIndex, onKeyDown }: {
  opt: ThemeOption;
  isActive: boolean;
  onClick: () => void;
  tabIndex: number;
  onKeyDown: React.KeyboardEventHandler<HTMLButtonElement>;
}) {
  const { t } = useTranslation();
  return (
    <button type="button" role="radio" aria-checked={isActive} tabIndex={tabIndex}
      className="app-settings-theme" onClick={onClick} onKeyDown={onKeyDown}>
      <div className="app-settings-theme__preview" data-theme={opt.key} aria-hidden="true">
        <div className="app-settings-theme__window">
          <div className="app-settings-theme__chrome"><span /><span /><span /><div /></div>
          <div className="app-settings-theme__body">
            <div className="app-settings-theme__sidebar"><span /><span /><span /></div>
            <div className="app-settings-theme__editor">
              <div className="app-settings-theme__line" /><div className="app-settings-theme__line app-settings-theme__line--short" />
              <div className="app-settings-theme__terminal"><span>&gt;</span> termflow<span className="app-settings-theme__cursor" /></div>
            </div>
          </div>
        </div>
      </div>
      <span className="app-settings-theme__footer">
        <span>{t(opt.labelKey)}</span>
        {isActive && <CheckOutlined aria-hidden="true" className="text-[var(--cs-primary)]" />}
      </span>
    </button>
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
      />
      <SettingSection title={t("settings.general.appearance.title")}>
        <div>
          <div className="app-settings-control-line justify-between">
            <div className="min-w-0">
              <div className="text-sm font-semibold" style={{ color: "var(--cs-text-primary)" }}>
                {t("settings.general.appearance.mode.label")}
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
            className="app-settings-grid mt-4"
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
        <SettingRow label={t("settings.general.uiLanguage")}>
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
        <BackgroundSettings />
        <SettingRow
          label={t("settings.general.restoreLastProject")}
        >
          <Switch
            checked={startupRestoreLastProject}
            onChange={setStartupRestoreLastProject}
          />
        </SettingRow>
        <SettingRow
          label={t("settings.general.projectOpenBehavior")}
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
      />
      <SettingSection title={t("settings.terminal.shell")}>
        <SettingRow label={t("settings.terminal.defaultShell")}>
          <Segmented
            size="small"
            value={defaultTerminalShell}
            options={shellOptions}
            onChange={(v) => setDefaultTerminalShell(v as TerminalShell)}
          />
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("settings.terminal.font")}>
        <SettingRow label={t("settings.terminal.editorFontSize")}>
          <Segmented
            size="small"
            value={editorFontSize}
            options={fontSizeOptions}
            onChange={(v) => setEditorFontSize(v as number)}
          />
        </SettingRow>
        <SettingRow label={t("settings.terminal.fontSize")}>
          <Segmented
            size="small"
            value={terminalFontSize}
            options={fontSizeOptions}
            onChange={(v) => setTerminalFontSize(v as number)}
          />
        </SettingRow>
      </SettingSection>

      <SettingSection title={t("settings.terminal.behavior")}>
        <SettingRow label={t("settings.terminal.cursorBlink")}>
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
        <SettingRow label={t("settings.terminal.lineHeight")}>
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
        <SettingRow label={t("settings.terminal.renderer")}>
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

type AsrModelOption = {
  value: string;
  label: string;
  modeKey: string;
  descriptionKey: string;
};

type AsrProvider = "mimo" | "dashscope";

const MIMO_ASR_MODELS: AsrModelOption[] = [
  {
    value: DEFAULT_ASR_MODEL,
    label: "MiMo v2.5 ASR",
    modeKey: "settings.voiceRecognition.modelOptions.cloud",
    descriptionKey: "settings.voiceRecognition.modelOptions.mimoDescription",
  },
];

const DASHSCOPE_ASR_MODELS: AsrModelOption[] = [
  {
    value: "qwen-audio-3.0-asr-flash-streaming",
    label: "Qwen-Audio-3.0-ASR-Flash-Streaming",
    modeKey: "settings.voiceRecognition.modelOptions.realtime",
    descriptionKey: "settings.voiceRecognition.modelOptions.qwenStreamingDescription",
  },
  {
    value: "qwen3-asr-flash",
    label: "Qwen3-ASR-Flash",
    modeKey: "settings.voiceRecognition.modelOptions.nonRealtime",
    descriptionKey: "settings.voiceRecognition.modelOptions.qwenFlashDescription",
  },
];

export function VoiceRecognitionPage() {
  const { t } = useTranslation();
  const asrApiKey = useAppStore((s) => s.asrApiKey);
  const asrAuthMode = useAppStore((s) => s.asrAuthMode);
  const asrModel = useAppStore((s) => s.asrModel);
  const asrRegion = useAppStore((s) => s.asrRegion);
  const voicePolishEnabled = useAppStore((s) => s.voicePolishEnabled);
  const voicePolishModel = useAppStore((s) => s.voicePolishModel);
  const voicePolishProvider = useAppStore((s) => s.voicePolishProvider);
  const voicePolishApiKey = useAppStore((s) => s.voicePolishApiKey);
  const voicePolishAuthMode = useAppStore((s) => s.voicePolishAuthMode);
  const voicePolishRegion = useAppStore((s) => s.voicePolishRegion);
  const voicePolishStyle = useAppStore((s) => s.voicePolishStyle);
  const voicePolishInstructions = useAppStore((s) => s.voicePolishInstructions);
  const setVoicePolishInstructions = useAppStore((s) => s.setVoicePolishInstructions);
  const voiceShortcut = useAppStore((s) => s.voiceShortcut);
  const voiceTriggerVisible = useAppStore((s) => s.voiceTriggerVisible);
  const setAsrApiKey = useAppStore((s) => s.setAsrApiKey);
  const setAsrAuthMode = useAppStore((s) => s.setAsrAuthMode);
  const setAsrModel = useAppStore((s) => s.setAsrModel);
  const setAsrRegion = useAppStore((s) => s.setAsrRegion);
  const setVoicePolishEnabled = useAppStore((s) => s.setVoicePolishEnabled);
  const setVoicePolishModel = useAppStore((s) => s.setVoicePolishModel);
  const setVoicePolishProvider = useAppStore((s) => s.setVoicePolishProvider);
  const setVoicePolishApiKey = useAppStore((s) => s.setVoicePolishApiKey);
  const setVoicePolishAuthMode = useAppStore((s) => s.setVoicePolishAuthMode);
  const setVoicePolishRegion = useAppStore((s) => s.setVoicePolishRegion);
  const setVoicePolishStyle = useAppStore((s) => s.setVoicePolishStyle);
  const setVoiceShortcut = useAppStore((s) => s.setVoiceShortcut);
  const setVoiceTriggerVisible = useAppStore((s) => s.setVoiceTriggerVisible);

  const [showApiKey, setShowApiKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [polishTesting, setPolishTesting] = useState(false);
  const [isRecordingShortcut, setIsRecordingShortcut] = useState(false);
  const [isPreparingShortcutRecording, setIsPreparingShortcutRecording] = useState(false);
  const previousShortcutRef = useRef<string | null>(null);
  const asrProvider: AsrProvider =
    asrModel.startsWith("fun-asr-flash") || asrModel.startsWith("qwen3-asr-flash") || asrModel.startsWith("qwen-audio-3.0-asr")
      ? "dashscope"
      : "mimo";
  const isDashScopeProvider = asrProvider === "dashscope";
  const providerOptions = [
    { label: <VoiceProviderLabel provider="mimo" label="MiMo" />, value: "mimo" },
    { label: <VoiceProviderLabel provider="dashscope" label="DashScope" />, value: "dashscope" },
  ];
  const mimoAuthOptions = [
    { label: "Token Plan", value: "token-plan" },
    { label: "API", value: "api" },
  ];
  const currentModelOptions = isDashScopeProvider ? DASHSCOPE_ASR_MODELS : MIMO_ASR_MODELS;
  const renderAsrModelOption = (option: { data: AsrModelOption }) => {
    const model = option.data;
    const isSelected = model.value === asrModel;

    return (
      <div className="flex min-w-0 items-start gap-3 py-1">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-[var(--cs-text-primary)]">{model.label}</span>
            <span className="shrink-0 text-xs text-[var(--cs-text-tertiary)]">
              {t(model.modeKey)}
            </span>
          </div>

        </div>
        {isSelected && <CheckOutlined className="mt-0.5 shrink-0 text-[var(--cs-primary)]" />}
      </div>
    );
  };
  const apiKeyPlaceholder = isDashScopeProvider
    ? t("settings.voiceRecognition.polishingKeyPlaceholder", { provider: "DashScope" })
    : asrAuthMode === "token-plan"
      ? t("settings.voiceRecognition.layout.tokenPlanKeyPlaceholder")
      : t("settings.voiceRecognition.polishingKeyPlaceholder", { provider: "MiMo" });
  const apiKeyDesc = t("settings.voiceRecognition.apiKeyDesc");
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
      setAsrModel("qwen-audio-3.0-asr-flash-streaming");
      return;
    }
    setAsrModel(DEFAULT_ASR_MODEL);
  };

  const handlePolishTest = async () => {
    if (!voicePolishApiKey.trim()) {
      message.warning(t("settings.voiceRecognition.apiKeyRequired"));
      return;
    }
    setPolishTesting(true);
    try {
      const output = await polishVoiceText(
        t("settings.voiceRecognition.polishingTestSample"),
        voicePolishProvider,
        resolveVoicePolishModel(voicePolishProvider, voicePolishModel),
        voicePolishApiKey.trim(),
        voicePolishAuthMode,
        voicePolishRegion,
        voicePolishStyle,
        voicePolishInstructions,
      );
      Modal.info({
        title: t("settings.voiceRecognition.polishingTestSuccess"),
        content: output,
      });
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setPolishTesting(false);
    }
  };

  const restoreGlobalVoiceShortcut = useCallback(async (shortcut: string) => {
    try {
      await configureVoiceGlobalShortcut(
        toTauriShortcut(shortcut),
        Boolean(shortcut.trim()),
      );
    } catch (error) {
      console.warn("failed to restore voice global shortcut:", error);
    }
  }, []);

  const startShortcutRecording = useCallback(async () => {
    if (isRecordingShortcut || isPreparingShortcutRecording) {
      return;
    }

    setIsPreparingShortcutRecording(true);
    try {
      // 系统级快捷键会在 WebView 收到 keydown 前截获按键，因此录制前必须先注销旧键。
      await configureVoiceGlobalShortcut(null, false);
      previousShortcutRef.current = voiceShortcut;
      setIsRecordingShortcut(true);
    } catch (error) {
      console.warn("failed to suspend voice global shortcut for recording:", error);
      message.error(
        t("settings.voiceRecognition.shortcutRecordFailed", {
          defaultValue: "无法暂停当前语音快捷键，请重试",
        }),
      );
    } finally {
      setIsPreparingShortcutRecording(false);
    }
  }, [isPreparingShortcutRecording, isRecordingShortcut, t, voiceShortcut]);

  const cancelShortcutRecording = useCallback(() => {
    const previousShortcut = previousShortcutRef.current;
    previousShortcutRef.current = null;
    setIsRecordingShortcut(false);

    if (previousShortcut !== null) {
      void restoreGlobalVoiceShortcut(previousShortcut);
    }
  }, [restoreGlobalVoiceShortcut]);

  const applyRecordedShortcut = useCallback((shortcut: string) => {
    const conflict = findShortcutConflict(useShortcutStore.getState().overrides, "voiceInput", shortcut, voiceShortcut);
    if (conflict) {
      message.warning(t("settings.shortcuts.conflict", { action: t(`settings.shortcuts.${conflict}`) }));
      return;
    }
    const previousShortcut = previousShortcutRef.current;
    previousShortcutRef.current = null;
    setVoiceShortcut(shortcut);
    setIsRecordingShortcut(false);

    // 相同的快捷键不会触发 AppLayout 的配置 effect，需要在此重新注册。
    if (previousShortcut === shortcut) {
      void restoreGlobalVoiceShortcut(shortcut);
    }
  }, [restoreGlobalVoiceShortcut, setVoiceShortcut, t, voiceShortcut]);

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
      if (asrModel.trim() === "qwen-audio-3.0-asr-flash-streaming") {
        const sessionId = typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `settings-test-${Date.now()}`;
        await startLiveAsr(sessionId, asrApiKey.trim(), asrModel.trim(), asrRegion);
        await finishLiveAsr(sessionId);
      } else {
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
        cancelShortcutRecording();
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

      applyRecordedShortcut(nextShortcut);
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
  }, [applyRecordedShortcut, cancelShortcutRecording, isRecordingShortcut, t]);

  useEffect(() => () => {
    const previousShortcut = previousShortcutRef.current;
    if (previousShortcut !== null) {
      void restoreGlobalVoiceShortcut(previousShortcut);
    }
  }, [restoreGlobalVoiceShortcut]);

  return (
    <div className="app-voice-settings">
      <SettingsPageHeader title={t("settings.menu.voiceRecognition")}
        description={t("settings.voiceRecognition.layout.description")}
        decoration={<span className="app-settings-signal"><span /><span /><span /><span /><span /><span /><span /></span>} />

      <VoiceSettingsSection title={t("settings.voiceRecognition.layout.recognition")} actions={
        <Tooltip title={t("settings.voiceRecognition.testConnectionDesc")}>
          <Button size="small" loading={testing} onClick={handleTest} disabled={!asrApiKey.trim()}>
            {t("settings.voiceRecognition.testConnection")}
          </Button>
        </Tooltip>
      }>
        <div className="app-voice-settings-grid">
          <VoiceSettingsField htmlFor="voice-asr-provider" label={t("settings.voiceRecognition.serviceProvider")}>
            <Select id="voice-asr-provider" className="w-full" value={asrProvider}
              options={providerOptions} onChange={handleProviderChange} showSearch={false} />
          </VoiceSettingsField>
          <VoiceSettingsField htmlFor="voice-asr-api-key" label={t("settings.voiceRecognition.apiKey")}>
            <Input.Password id="voice-asr-api-key" name="voice-asr-api-key" className="w-full" value={asrApiKey}
              onChange={(event) => setAsrApiKey(event.target.value)} placeholder={apiKeyPlaceholder}
              autoComplete="off" spellCheck={false} title={apiKeyDesc}
              visibilityToggle={{ visible: showApiKey, onVisibleChange: setShowApiKey }} />
          </VoiceSettingsField>
          <VoiceSettingsField htmlFor="voice-asr-model" label={t("settings.voiceRecognition.model")}>
            <Select id="voice-asr-model" className="w-full" value={asrModel} onChange={setAsrModel}
              options={currentModelOptions} optionRender={renderAsrModelOption}
              popupClassName="app-asr-model-select-dropdown"
              placeholder={t("settings.voiceRecognition.modelPlaceholder")} />
          </VoiceSettingsField>
          {isDashScopeProvider ? (
            <VoiceSettingsField htmlFor="voice-asr-region" label={t("settings.voiceRecognition.region")}>
              <Select id="voice-asr-region" className="w-full" value={asrRegion} onChange={setAsrRegion} options={[
                { value: "beijing", label: t("settings.voiceRecognition.polishingRegionBeijing") },
                { value: "singapore", label: t("settings.voiceRecognition.polishingRegionSingapore") },
                { value: "us", label: t("settings.voiceRecognition.polishingRegionUs") },
              ]} />
            </VoiceSettingsField>
          ) : (
            <VoiceSettingsField htmlFor="voice-asr-auth" label={t("settings.voiceRecognition.polishingAuthLabel")}>
              <Select id="voice-asr-auth" className="w-full" value={asrAuthMode} options={mimoAuthOptions}
                onChange={(value) => setAsrAuthMode(value as MimoAuthMode)} />
            </VoiceSettingsField>
          )}
        </div>
      </VoiceSettingsSection>

      <VoiceSettingsSection title={t("settings.voiceRecognition.polishingLabel")} actions={
        <Tooltip title={t("settings.voiceRecognition.polishingDesc")}>
          <Switch aria-label={t("settings.voiceRecognition.polishingLabel")}
            checked={voicePolishEnabled} onChange={setVoicePolishEnabled} />
        </Tooltip>
      }>
        {voicePolishEnabled ? (
          <div className="space-y-4">
            <div className="app-voice-settings-grid items-start">
              <VoiceSettingsField htmlFor="voice-polish-provider" label={t("settings.voiceRecognition.serviceProvider")}>
                <Select id="voice-polish-provider" className="w-full" value={voicePolishProvider} onChange={setVoicePolishProvider} options={[
                  { value: "deepseek", label: <VoiceProviderLabel provider="deepseek" label="DeepSeek" /> },
                  { value: "dashscope", label: <VoiceProviderLabel provider="dashscope" label="DashScope" /> },
                  { value: "mimo", label: <VoiceProviderLabel provider="mimo" label="MiMo" /> },
                ]} />
              </VoiceSettingsField>
              <VoicePolishModePicker value={voicePolishStyle} onChange={setVoicePolishStyle} />
              <VoiceSettingsField htmlFor="voice-polish-api-key" label={t("settings.voiceRecognition.apiKey")}>
                <div className="flex min-w-0 gap-2">
                <Input.Password id="voice-polish-api-key" name="voice-polish-api-key" className="min-w-0 flex-1" value={voicePolishApiKey}
                  onChange={(event) => setVoicePolishApiKey(event.target.value)} autoComplete="off" spellCheck={false}
                  placeholder={t("settings.voiceRecognition.polishingKeyPlaceholder", { provider: voicePolishProvider === "deepseek" ? "DeepSeek" : voicePolishProvider === "dashscope" ? "DashScope" : "MiMo" })} />
                {voicePolishProvider === "mimo" && (
                  <Select id="voice-polish-auth" aria-label={t("settings.voiceRecognition.polishingAuthLabel")}
                    className="w-32 shrink-0" value={voicePolishAuthMode} onChange={setVoicePolishAuthMode} options={mimoAuthOptions} />
                )}
                {voicePolishProvider === "dashscope" && (
                  <Select id="voice-polish-region" aria-label={t("settings.voiceRecognition.region")}
                    className="w-40 shrink-0" value={voicePolishRegion} onChange={setVoicePolishRegion} options={[
                      { value: "beijing", label: t("settings.voiceRecognition.polishingRegionBeijing") },
                      { value: "singapore", label: t("settings.voiceRecognition.polishingRegionSingapore") },
                      { value: "us", label: t("settings.voiceRecognition.polishingRegionUs") },
                    ]} />
                )}
                </div>
              </VoiceSettingsField>
              <VoiceSettingsField htmlFor="voice-polish-model" label={t("settings.voiceRecognition.polishingModelLabel")}>
                <div className="flex min-w-0 items-center gap-2">
                  <Select id="voice-polish-model" className="min-w-0 flex-1"
                    value={resolveVoicePolishModel(voicePolishProvider, voicePolishModel)} onChange={setVoicePolishModel}
                    options={availableVoicePolishModels(voicePolishProvider).map((model) => ({ value: model, label: model }))} showSearch={false} />
                  <Tooltip title={t("settings.voiceRecognition.polishingModelDesc")}>
                    <Button className="shrink-0" loading={polishTesting} onClick={() => void handlePolishTest()}
                      aria-label={t("settings.voiceRecognition.polishingTest")}>{t("settings.voiceRecognition.testButton")}</Button>
                  </Tooltip>
                </div>
              </VoiceSettingsField>
            </div>
            {!voicePolishApiKey.trim() && <p role="status" className="m-0 text-xs text-[var(--cs-text-secondary)]">{t("settings.voiceRecognition.polishingKeyMissing")}</p>}
            <div className="space-y-2">
              <VoiceSettingsDisclosure title={t("settings.voiceRecognition.polishingInstructionsLabel")}>
                <Input.TextArea id="voice-polish-instructions" name="voice-polish-instructions" value={voicePolishInstructions}
                  aria-label={t("settings.voiceRecognition.polishingInstructionsLabel")}
                  onChange={(event) => setVoicePolishInstructions(event.target.value)}
                  placeholder={t("settings.voiceRecognition.polishingInstructionsPlaceholder")}
                  autoSize={{ minRows: 2, maxRows: 6 }} maxLength={2000} showCount
                  aria-describedby="voice-polish-instructions-hint" />
                <p id="voice-polish-instructions-hint" className="mb-0 mt-6 text-xs leading-5 text-[var(--cs-text-secondary)]">
                  {t("settings.voiceRecognition.layout.instructionsHint")}
                </p>
              </VoiceSettingsDisclosure>
            </div>
          </div>
        ) : <p className="m-0 text-xs leading-5 text-[var(--cs-text-secondary)]">{t("settings.voiceRecognition.layout.polishOff")}</p>}
      </VoiceSettingsSection>

      <VoiceSettingsSection title={t("settings.voiceRecognition.layout.input")}>
        <div className="space-y-4">
          <VoiceSettingsField htmlFor="voice-shortcut" label={t("settings.voiceRecognition.shortcutLabel")}>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Input id="voice-shortcut" name="voice-shortcut" readOnly value={currentShortcutLabel} placeholder={shortcutPlaceholder}
                onClick={() => void startShortcutRecording()} disabled={isPreparingShortcutRecording}
                onKeyDown={(event) => {
                  if (!isRecordingShortcut && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    void startShortcutRecording();
                  }
                }}
                className="min-w-0 flex-1 cursor-pointer" />
              <Button type={isRecordingShortcut ? "primary" : "default"} loading={isPreparingShortcutRecording}
                onClick={() => { if (isRecordingShortcut) { cancelShortcutRecording(); return; } void startShortcutRecording(); }}>
                {t(isRecordingShortcut ? "settings.voiceRecognition.shortcutRecording" : "settings.voiceRecognition.shortcutRecord")}
              </Button>
              <Button disabled={isPreparingShortcutRecording} onClick={() => applyRecordedShortcut(DEFAULT_VOICE_SHORTCUT)}>
                {t("settings.voiceRecognition.shortcutReset")}
              </Button>
              <Tooltip title={t("settings.voiceRecognition.shortcutClear")}>
                <Button icon={<DeleteOutlined />} aria-label={t("settings.voiceRecognition.shortcutClear")}
                  disabled={!voiceShortcut.trim() || isPreparingShortcutRecording} onClick={() => applyRecordedShortcut("")} />
              </Tooltip>
            </div>
          </VoiceSettingsField>
          <SettingRow label={t("settings.voiceRecognition.triggerButton")} htmlFor="voice-trigger-visible">
            <Switch id="voice-trigger-visible" checked={voiceTriggerVisible} onChange={setVoiceTriggerVisible} />
          </SettingRow>
        </div>
      </VoiceSettingsSection>
    </div>
  );
}


/* ────────────── Shared resource lists ────────────── */
type ResourceScope = "workspace" | "user";
const SETTINGS_LIST_PAGE_SIZE = 5;
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
    <div className="app-settings-scope-tabs">
      {options.map(option => <button key={option.value} type="button" disabled={option.disabled}
        aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
        {option.label}<span>{option.count}</span>
      </button>)}
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
  if (total <= pageSize) return null;
  return <div className="flex flex-wrap justify-end border-t border-[var(--cs-border-card)] py-4">
    <Pagination current={current} total={total} pageSize={pageSize} onChange={onChange} size="small" showSizeChanger={false} />
  </div>;
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

function buildCommandEmptyDraft(): CommandDraft {
  return {
    name: "",
    description: "",
    template: "",
    shell: "default",
    cwdMode: "project",
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
  projectPath: string | null;
  search: string;
  t: (key: string) => string;
}) {
  const { projectPath, search, t } = params;
  if (!projectPath) {
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
    <div className="app-settings-resource-row">
      <button type="button" className="app-settings-resource-row__open" onClick={onOpen}>
        <div className="app-settings-resource-row__name">
          <CodeOutlined style={{ color: "var(--cs-primary)", fontSize: 14 }} />
          <span className="text-sm font-medium" style={{ color: "var(--cs-text-primary)" }}>
            {command.name}
          </span>
          <Tag className="!m-0" color={command.format === "claude_native" ? "cyan" : "purple"}>
            {command.format === "claude_native" ? t("settings.commands.claudeNative") : t("settings.commands.extended")}
          </Tag>
          {command.supportsTestRun && (
            <Tag className="!m-0" color="purple">
              {formatCommandShellLabel(command.shell, t)}
            </Tag>
          )}
        </div>
        <div className="app-settings-resource-row__summary">
          {command.description || command.commandPreview || t("settings.shared.noDescription")}
        </div>
      </button>
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
  const [selectedCommand, setSelectedCommand] = useState<CommandInfo | null>(null);
  const [detail, setDetail] = useState<CommandDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<CommandTestResult | null>(null);
  const [page, setPage] = useState(1);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingCommand, setEditingCommand] = useState<CommandInfo | null>(null);
  const [draft, setDraft] = useState<CommandDraft>(buildCommandEmptyDraft);
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
    loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    setPage(1);
  }, [search, catalog?.commands]);

  const filteredCommands = useMemo(() => {
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
      const next = await getCommandDetail(command.id, projectPath);
      setDetail(next);
    } catch (error) {
      console.error("Failed to load command details:", error);
      message.error(t("settings.commands.loadDetailFailed"));
    } finally {
      setDetailLoading(false);
    }
  }

  async function handleOpenConfig() {
    try {
      const configPath = await ensureCommandStore(projectPath);
      await openInFileManager(configPath);
    } catch (error) {
      console.error("Failed to open command config:", error);
      message.error(t("settings.commands.openDirectoryFailed"));
    }
  }

  function openCreateModal() {
    if (!projectPath) return;
    setEditingCommand(null);
    setDraft(buildCommandEmptyDraft());
    setTagsInput("");
    setEditorOpen(true);
  }

  function openEditModal(command: CommandInfo) {
    setEditingCommand(command);
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
      cwdMode: draft.cwdMode ?? "project",
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
        ? await updateCommand(editingCommand.id, payload, projectPath)
        : await createCommand(payload, projectPath);
      closeEditor();
      message.success(
        editingCommand
          ? t("settings.commands.updateSuccess", { name: saved.name })
          : t("settings.commands.createSuccess", { name: saved.name })
      );
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
      await deleteCommand(target.id, projectPath);
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
      const result = await runCommandTest(command.id, projectPath);
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
    const directoryPath = catalog?.workspaceDir;
    const totalItems = filteredCommands.length;
    const items = pagedCommands;
    const emptyState = buildCommandEmptyState({
      projectPath,
      search,
      t,
    });

    return (
      <SettingSection title={`${t("settings.commands.workspaceCommands")} (${totalItems})`}>
        <div className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0">

            <div className="text-[11px] mt-1 break-all" style={{ color: "var(--cs-text-tertiary)" }}>
              {directoryPath || t("settings.commands.workspaceDirUnavailable")}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="small"
              icon={<FolderOpenOutlined />}
              onClick={() => handleOpenConfig()}
              disabled={!projectPath}
            >
              {t("settings.commands.openCommandDirectory")}
            </Button>
            <Button
              size="small"
              type="primary"
              icon={<PlusOutlined />}
              onClick={openCreateModal}
              disabled={!projectPath}
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
              onClick={openCreateModal}
              disabled={!projectPath}
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
        actions={
          <>
            <Button
              icon={<PlusOutlined />}
              type="primary"
              onClick={openCreateModal}
              disabled={!projectPath}
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
  return isTermflowHook(hook);
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

  if (scope === "workspace") {
    return {
      description: t("settings.hooks.emptyWorkspace"),
      detail: t("settings.hooks.emptyWorkspaceDetail", { agent: hookAgentLabel(agent, t) }),
    };
  }

  return {
    description: t("settings.hooks.emptyInitial"),
    detail: t("settings.hooks.emptyInitialDetail"),
  };
}

function HookRow({ hook, onOpen }: { hook: HookInfo; onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="app-settings-resource-row">
      <button type="button" className="app-settings-resource-row__open" onClick={onOpen}>
        <div className="app-settings-resource-row__name">
          <ApiOutlined className="text-[var(--cs-primary)]" aria-hidden="true" />
          <span className="text-sm font-medium text-[var(--cs-text-primary)]">{formatHookEventLabel(hook.event)}</span>
          {!hook.enabled && <Tag>{t("settings.hooks.registrationDisabled")}</Tag>}
        </div>
        <div className="app-settings-resource-row__summary">
          {t("settings.hooks.matcher")}: {formatHookMatcher(hook.matcher, t)}
          <span className="ml-3 break-all">{getHookCommandName(hook)}</span>
        </div>
      </button>
      <Button type="text" size="small" onClick={onOpen}>{t("settings.hooks.viewDetails")}</Button>
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
          <p className="m-0 text-xs text-[var(--cs-text-secondary)]">
            {t("settings.shared.updatedAt", { value: formatHookUpdatedAt(detail.hook.updatedAt) ?? t("common.unknown") })}
          </p>
          <p className="text-xs text-[var(--cs-text-secondary)]">
            {t("settings.hooks.sourceLabel")}: {t(`settings.hooks.sources.${getHookSource(detail.hook)}`)}. {t("settings.hooks.inferredSourceHint")}
          </p>
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
  const key = `settings.hooks.agents.${agent}`;
  const label = t(key);
  return label === key ? AGENT_DEFINITIONS[agent].displayName : label;
}

function HooksPage() {
  const projectPath = useAppStore((state) => state.currentProject?.path ?? null);
  const [activeAgent, setActiveAgent] = useState<HookAgent>("claude");
  // 切换上下文时重新挂载，旧请求、详情和确认目标不能带入另一个智能体。
  return <HooksAgentPage key={JSON.stringify([activeAgent, projectPath])}
    activeAgent={activeAgent} setActiveAgent={setActiveAgent} projectPath={projectPath} />;
}

function HooksAgentPage({ activeAgent, setActiveAgent, projectPath }: {
  activeAgent: HookAgent;
  setActiveAgent: (agent: HookAgent) => void;
  projectPath: string | null;
}) {
  const { t } = useTranslation();
  const catalogRequest = useRef(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<HookCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [migrationTarget, setMigrationTarget] = useState<{
    projectPath: string;
    count: number;
  } | null>(null);
  const [search, setSearch] = useState("");
  const [activeScope, setActiveScope] = useState<HookScope>("user");
  const [eventFilter, setEventFilter] = useState<string>("all");
  const [selectedHook, setSelectedHook] = useState<HookInfo | null>(null);
  const [detail, setDetail] = useState<HookDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HookInfo | null>(null);

  const loadCatalog = useCallback(async (silent = false) => {
    const request = ++catalogRequest.current;
    setLoadError(null);
    setRefreshing(silent);
    setLoading(!silent);
    try {
      const next = await listAgentHooks(activeAgent, projectPath);
      if (request === catalogRequest.current) setCatalog(next);
    } catch (error) {
      if (request !== catalogRequest.current) return;
      setCatalog(null);
      setLoadError(error instanceof Error ? error.message : String(error));
      console.error("Failed to load hooks:", error);
    } finally {
      if (request === catalogRequest.current) {
        setRefreshing(false);
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
    void loadCatalog();
    return () => { catalogRequest.current += 1; };
  }, [loadCatalog]);

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

  const workspaceCount = (catalog?.hooks ?? []).filter((hook) => hook.scope === "workspace").length;
  const userCount = (catalog?.hooks ?? []).filter((hook) => hook.scope === "user").length;
  const workspaceManagedHookCount = (catalog?.hooks ?? []).filter(
    (hook) => hook.agent === "claude" && hook.scope === "workspace" && isDefaultHook(hook)
  ).length;
  const filteredHooks = baseFilteredHooks.filter((hook) => hook.scope === activeScope);
  const scopeHooks = (catalog?.hooks ?? []).filter((hook) => hook.scope === activeScope);
  const sourceGroups = groupHooksBySource(filteredHooks);
  const hasHookFilter = search.trim().length > 0 || eventFilter !== "all";
  const managedCount = (catalog?.hooks ?? []).filter((hook) => hook.scope === "user" && isDefaultHook(hook)).length;

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

  async function handleRepair() {
    const request = ++catalogRequest.current;
    setRepairing(true);
    try {
      const next = await repairAgentHooks(activeAgent, "user", projectPath);
      if (request !== catalogRequest.current) return;
      setLoadError(null);
      setCatalog(next);
      setActiveScope("user");
      message.success(t("settings.hooks.repairUserSuccess", { agent: hookAgentLabel(activeAgent, t) }));
    } catch (error) {
      console.error("Failed to repair hooks:", error);
      message.error(t("settings.hooks.repairFailedWithError", {
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setRepairing(false);
      setRefreshing(false);
      setLoading(false);
    }
  }

  async function handleConfirmMigration() {
    if (!migrationTarget) return;
    const target = migrationTarget;
    setMigrating(true);
    try {
      const result = await migrateWorkspaceClaudeHooks(target.projectPath);
      if (useAppStore.getState().currentProject?.path === target.projectPath) {
        setCatalog(result.catalog);
      }
      setMigrationTarget(null);
      message.success(t("settings.hooks.migrationSuccess", {
        count: String(result.removedCount),
      }));
    } catch (error) {
      console.error("Failed to migrate workspace hooks:", error);
      message.error(t("settings.hooks.migrationFailed", {
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setMigrating(false);
    }
  }

  function renderHookSection() {
    const configPath = activeScope === "workspace" ? catalog?.workspaceConfigPath : catalog?.userConfigPath;
    const emptyState = buildHookEmptyState({ agent: activeAgent, scope: activeScope, projectPath, search, eventFilter, t });
    return <section className="space-y-4" aria-label={t("settings.menu.hooks")}>
      <div className="text-sm text-[var(--cs-text-secondary)]">
        {hasHookFilter
          ? t("settings.hooks.matchingRegistrations", { count: filteredHooks.length, total: scopeHooks.length })
          : t("settings.hooks.registrationOverview", {
              count: scopeHooks.length,
              events: new Set(scopeHooks.map((hook) => hook.event)).size,
              sources: groupHooksBySource(scopeHooks).length,
            })}
      </div>
      {sourceGroups.length === 0 ? <Empty description={emptyState.description}>
        <p className="text-xs text-[var(--cs-text-secondary)]">{emptyState.detail}</p>
      </Empty> : sourceGroups.map((group) => <details key={`${activeAgent}:${activeScope}:${group.source}:${search}:${eventFilter}`}
        open={hasHookFilter || undefined} className="app-hook-source-group rounded-lg border border-[var(--cs-border)]">
        <summary className="cursor-pointer rounded-lg px-4 py-3 text-sm text-[var(--cs-text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--cs-primary)]">
          <span className="ml-2 font-medium">{t(`settings.hooks.sources.${group.source}`)}</span>
          <span className="ml-3 text-xs text-[var(--cs-text-secondary)]">{t("settings.hooks.registrationCount", { count: group.hooks.length })}</span>
        </summary>
        <div className="border-t border-[var(--cs-border)] px-4">
          <p className="my-3 text-xs text-[var(--cs-text-secondary)]">{t(group.source === "termflow" ? "settings.hooks.managedSourceHint" : "settings.hooks.inferredSourceHint")}</p>
          {group.hooks.map((hook) => <HookRow key={hook.id} hook={hook} onOpen={() => void handleOpenDetail(hook)} />)}
        </div>
      </details>)}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--cs-border)] py-4">
        <span className="min-w-0 break-all text-xs text-[var(--cs-text-secondary)]">{t("settings.hooks.configFile")}: {configPath || t("settings.hooks.notSet")}</span>
        <Button size="small" icon={<FolderOpenOutlined />} disabled={!configPath}
          onClick={() => { if (configPath) void openInFileManager(configPath).catch(() => message.error(t("settings.hooks.openConfigFailed"))); }}>
          {t("settings.hooks.openConfigFile")}
        </Button>
      </div>
    </section>;
  }


  return (
    <>
      <SettingsPageHeader
        title={t("settings.menu.hooks")}
        actions={
          <>
            <Button
              icon={<ReloadOutlined spin={refreshing} />}
              disabled={refreshing || repairing || loading}
              onClick={() => void loadCatalog(true)}
            >
              {t("common.refresh")}
            </Button>
          </>
        }
      >
        {workspaceManagedHookCount > 0 && (
          <div
            className="mb-3 rounded-xl px-3 py-2 text-xs flex items-center justify-between gap-3"
            style={{
              background: "color-mix(in srgb, #d99b2b 10%, transparent)",
              border: "1px solid color-mix(in srgb, #d99b2b 24%, transparent)",
              color: "var(--cs-text-secondary)",
            }}
          >
            <span>{t("settings.hooks.workspaceDuplicateNotice", { count: workspaceManagedHookCount })}</span>
            <Button
              size="small"
              onClick={() => projectPath && setMigrationTarget({
                projectPath,
                count: workspaceManagedHookCount,
              })}
            >
              {t("settings.hooks.migrateToGlobal")}
            </Button>
          </div>
        )}
        <div className="app-settings-choices mb-4 flex flex-wrap" role="group" aria-label={t("settings.mcpServers.selectAgent")}>
          {HOOK_AGENTS.map(agent => <button key={agent} type="button" aria-pressed={agent === activeAgent} onClick={() => setActiveAgent(agent)}>
            <AgentIcon agentId={agent} size={14} />{hookAgentLabel(agent, t)}
          </button>)}
        </div>
        {!loading && !loadError && <ScopeTabs
          value={activeScope}
          workspaceCount={workspaceCount}
          userCount={userCount}
          projectAvailable={!!projectPath}
          onChange={setActiveScope}
        />}
      </SettingsPageHeader>

      {loading ? <div className="flex justify-center py-20"><Spin /></div>
        : loadError ? <div role="alert" className="rounded-lg border border-[var(--cs-border)] p-6 text-[var(--cs-text-primary)]">
          <p className="font-medium">{t("settings.hooks.loadFailed")}</p>
          <p className="break-words text-sm text-[var(--cs-text-secondary)]">{loadError}</p>
          <Button onClick={() => void loadCatalog()}>{t("settings.hooks.retryLoad")}</Button>
        </div> : <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--cs-border)] bg-[var(--cs-bg-hover)] p-4 text-[var(--cs-text-primary)]">
        <div>
          <div className="text-sm font-medium">{t("settings.hooks.managedRegistrationSummary", { agent: hookAgentLabel(activeAgent, t), count: managedCount })}</div>
          <p className="mb-0 mt-1 text-xs text-[var(--cs-text-secondary)]">{t("settings.hooks.managedRegistrationHint")}</p>
        </div>
        <Button type="primary" onClick={handleRepair} loading={repairing}>{t("settings.hooks.repairGlobalHook")}</Button>
      </div>
      <div className="mb-4 flex flex-wrap gap-3">
        <Input className="min-w-48 flex-1" allowClear prefix={<SearchOutlined aria-hidden="true" />}
          placeholder={t("settings.hooks.searchPlaceholder")} aria-label={t("settings.hooks.searchPlaceholder")}
          value={search} onChange={(e) => setSearch(e.target.value)} />
        <Select className="min-w-44" aria-label={t("settings.hooks.allEvents")} value={eventFilter} onChange={setEventFilter} options={eventOptions} />
      </div>
      {activeAgent === "pi" && <p className="text-xs text-[var(--cs-text-secondary)]">{t("settings.hooks.piExtensionHint")}</p>}
      {renderHookSection()}
      </>}

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
            setSelectedHook(null);
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

      <Modal
        open={!!migrationTarget}
        title={t("settings.hooks.migrationTitle")}
        onCancel={() => !migrating && setMigrationTarget(null)}
        onOk={handleConfirmMigration}
        confirmLoading={migrating}
        cancelButtonProps={{ disabled: migrating }}
        closable={!migrating}
        maskClosable={!migrating}
        okText={t("settings.hooks.migrateToGlobal")}
        cancelText={t("common.cancel")}
        centered
      >
        <div className="text-sm leading-6" style={{ color: "var(--cs-text-secondary)" }}>
          {t("settings.hooks.migrationDesc", { count: migrationTarget?.count ?? 0 })}
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
  const { t } = useTranslation();
  return (
    <div
      className="app-mcp-type-picker"
      role="radiogroup"
      aria-label={t("settings.mcpServers.serverType")}
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
            className="app-mcp-type-option"
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function McpServersPage() {
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
    projectPath ? "local" : "user"
  );
  const [showForm, setShowForm] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServerInfo | null>(null);
  const [formData, setFormData] = useState<McpServerFormData>({ ...emptyMcpForm });
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<McpServerInfo | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [testingName, setTestingName] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ name: string; success: boolean; message: string } | null>(null);

  const catalogRequestRef = useRef(0);
  const testRequestRef = useRef(0);

  const loadCatalog = useCallback(
    async (silent = false) => {
      const request = ++catalogRequestRef.current;
      if (silent) setRefreshing(true);
      else { setLoading(true); setCatalog(null); }
      try {
        const next = await listMcpServers(activeAgent, projectPath);
        if (request !== catalogRequestRef.current) return;
        setCatalog(next);
      } catch (error) {
        if (request !== catalogRequestRef.current) return;
        console.error("Failed to load MCP servers:", error);
        message.error({
          content: t("settings.mcpServers.loadFailed"),
          duration: 8,
          key: "mcp-server-catalog-load-failed",
        });
      } finally {
        if (request === catalogRequestRef.current) {
          setRefreshing(false);
          setLoading(false);
        }
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
    setDeleteTarget(null);
    setTestResult(null);
    setTestingName(null);
    testRequestRef.current += 1;
    return () => { testRequestRef.current += 1; };
  }, [activeAgent, projectPath]);

  useEffect(() => {
    void loadCatalog();
    return () => { catalogRequestRef.current += 1; };
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
      testRequestRef.current += 1;
      setTestingName(null);
      setTestResult(null);
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
      testRequestRef.current += 1;
      setTestingName(null);
      setTestResult(null);
      setDeleteTarget(null);
    } catch (error) {
      console.error("Failed to delete MCP server:", error);
      message.error(t("settings.mcpServers.deleteFailed"));
    } finally {
      setDeleting(false);
    }
  }

  async function handleTest(server: McpServerInfo) {
    const request = ++testRequestRef.current;
    const testKey = `${server.scope}:${server.name}`;
    setTestingName(testKey);
    setTestResult(null);
    try {
      const result = await testMcpServer(activeAgent, server.scope, server.name, projectPath);
      if (request !== testRequestRef.current) return;
      setTestResult({
        name: testKey,
        success: result.success,
        message: stripAnsiEscapeSequences(result.message),
      });
    } catch (error) {
      console.error("Failed to test MCP server:", error);
      if (request !== testRequestRef.current) return;
      setTestResult({
        name: testKey,
        success: false,
        message: stripAnsiEscapeSequences(String(error)),
      });
    } finally {
      if (request === testRequestRef.current) setTestingName(null);
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

  return (
    <>
      <McpServersView
        agents={mcpAgents}
        agent={activeAgent}
        scope={activeScope}
        servers={catalog?.servers ?? []}
        filteredServers={filteredServers}
        projectName={currentProject?.name}
        configPath={configPath}
        search={search}
        loading={loading}
        refreshing={refreshing}
        available={catalog !== null}
        testingKey={testingName}
        testResult={testResult}
        onAgent={setActiveAgent}
        onScope={(scope) => {
          testRequestRef.current += 1;
          setTestingName(null);
          setActiveScope(scope);
          closeForm();
          setDeleteTarget(null);
          setTestResult(null);
        }}
        onSearch={setSearch}
        onRefresh={() => void loadCatalog(true)}
        onAdd={openAddForm}
        onEdit={openEditForm}
        onDelete={setDeleteTarget}
        onTest={(server) => void handleTest(server)}
        onOpenConfig={() => {
          if (configPath) void openInFileManager(configPath).catch(() => message.error(t("settings.mcpServers.openConfigFailed")));
        }}
      />

      {/* Add/Edit Form Modal */}
      <Modal
        open={showForm}
        title={
          editingServer
            ? t("settings.mcpServers.editServer")
            : t("settings.mcpServers.addServer")
        }
        onCancel={() => { if (!saving) closeForm(); }}
        closable={!saving}
        maskClosable={!saving}
        cancelButtonProps={{ disabled: saving }}
        onOk={handleSave}
        confirmLoading={saving}
        okText={t("settings.mcpServers.save")}
        cancelText={t("settings.mcpServers.cancel")}
        centered
        width={620}
        className="app-mcp-form"
      >
        <div className="app-mcp-form-context">
          <AgentIcon agentId={activeAgent} size={18} />
          <span>{AGENT_DEFINITIONS[activeAgent].displayName}</span>
          <span>·</span>
          <span>{t(`settings.mcpServers.${activeScope}Servers`)}</span>
        </div>
        <div className="space-y-4 py-2">
          {/* Name */}
          <div>
            <label className="text-sm mb-1.5 block" >
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
            <label className="text-sm mb-1.5 block" >
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
                <label className="text-sm mb-1.5 block" >
                  {t("settings.mcpServers.command")}
                </label>
                <Input
                  value={formData.command}
                  onChange={(e) => setFormData((prev) => ({ ...prev, command: e.target.value }))}
                  placeholder={t("settings.mcpServers.commandPlaceholder")}
                />
              </div>
              <div>
                <label className="text-sm mb-1.5 block" >
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
                <label className="text-sm mb-1.5 block" >
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
              <label className="text-sm mb-1.5 block" >
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
                <label className="text-sm" >
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
                      <Input.Password size="small" value={item.value} onChange={(e) => updateHeaderRow(index, "value", e.target.value)} placeholder={t("settings.mcpServers.headerValue")} className="flex-1" />
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
              <label className="text-sm" >
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
                    <Input.Password
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
        onCancel={() => { if (!deleting) setDeleteTarget(null); }}
        closable={!deleting}
        maskClosable={!deleting}
        cancelButtonProps={{ disabled: deleting }}
        onOk={handleDelete}
        confirmLoading={deleting}
        okText={t("settings.mcpServers.confirmDelete")}
        okButtonProps={{ danger: true }}
        cancelText={t("settings.mcpServers.cancel")}
        centered
      >
        <div className="app-mcp-delete-description text-sm leading-6">
          {t("settings.mcpServers.confirmDeleteDesc", { agent: AGENT_DEFINITIONS[activeAgent].displayName })}
        </div>
      </Modal>
    </>
  );
}

const pageComponents: Record<SettingsPage, React.FC> = {
  general: GeneralPage,
  network: NetworkSettingsPage,
  notifications: NotificationsPage,
  agents: AgentsPage,
  git: GitSettingsPage,
  terminal: TerminalPage,
  voiceRecognition: VoiceRecognitionPage,
  shortcuts: ShortcutsPage,
  skills: SkillsSettingsPage,
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
  const contentLayout = activePage === "about"
    ? "app-settings-content--about"
    : ["agents", "skills", "hooks", "mcpServers", "commands", "quickCommands", "claudeMd", "archived"].includes(activePage)
      ? "app-settings-content--wide"
      : "";
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
    <div className="app-settings">
      {/* Left nav */}
      <nav className="app-settings-nav" aria-label={t("common.settings")}>
        <div className="app-settings-nav__search app-settings-nav__search--wide">
          <Input
            allowClear
            size="small"
            prefix={<SearchOutlined />}
            value={menuSearch}
            placeholder={t("settings.menu.searchPlaceholder")}
            aria-label={t("settings.menu.searchPlaceholder")}
            onChange={(event) => setMenuSearch(event.target.value)}
          />
        </div>
        <div className="app-settings-nav__search app-settings-nav__search--compact">
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
                aria-label={t("settings.menu.searchPlaceholder")}
                className="app-settings-nav__search-input"
              />
            }
          >
            <button
              type="button"
              className="app-settings-nav__search-button"
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
        ) : visibleMenuGroups.map((group) => (
          <div key={group.key} className="app-settings-nav__group">
            <div className="app-settings-nav__group-title">
              {t(group.labelKey)}
            </div>
            {group.items.map((item) => {
              const isActive = activePage === item.key;
              const label = t(item.labelKey);
              return (
                <Tooltip key={item.key} title={label} placement="right" mouseEnterDelay={0.6}>
                  <button
                    type="button"
                    className="app-settings-nav__item"
                    aria-label={label}
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => selectPage(item.key)}
                  >
                    <span className="text-sm opacity-80" aria-hidden="true">{item.icon}</span>
                    <span className="app-settings-nav__label">
                      {label}
                    </span>
                  </button>
                </Tooltip>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Right content */}
      <div
        ref={contentScrollRef}
        className="app-settings-scroll"
      >
        <div className={`app-settings-content ${contentLayout}`} data-settings-page={activePage}>
          {activePage === "about" ? <AboutPage onNavigate={(page) => selectPage(page as SettingsPage)} /> : <PageComponent />}
        </div>
      </div>
    </div>
  );
}

export default SettingsPanel;
