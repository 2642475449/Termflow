import { BottomRunnerRailButton } from "@/components/bottomRunner/BottomRunnerStatus";
import { CloudServerOutlined, SettingOutlined } from "@ant-design/icons";
import { message, Popover, Tooltip } from "antd";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { getQuickSettingsMenuFocusIndex, getQuickSettingsSubmenuOnPopoverChange, toggleQuickSettingsSubmenu, type QuickSettingsSubmenu } from "@/lib/quickSettingsMenu";
import { useTranslation } from "react-i18next";
import { ShortcutHint } from "@/components/ui/ShortcutHint";
import { WorkbenchGlyph } from "@/components/ui/WorkbenchGlyph";
import { useShortcutStore } from "@/store/slices/shortcutSlice";
import { getAppShortcut } from "@/lib/appShortcuts";
import { useAppStore, type Language, type SidebarSection, type ThemeCategory } from "@/store";
import { checkForApplicationUpdate } from "@/lib/applicationUpdater";
import { useApplicationUpdateStore } from "@/store/slices/applicationUpdate";
import { useRemoteWorkspaceStore } from "@/store/slices/remoteWorkspace";
import i18n, { toI18nLanguage } from "@/i18n";

interface RailButtonProps {
  label?: string;
  active?: boolean;
  title: React.ReactNode;
  tooltipOpen?: boolean;
  buttonRef?: React.Ref<HTMLButtonElement>;
  expanded?: boolean;
  controls?: string;
  onKeyDown?: React.KeyboardEventHandler<HTMLButtonElement>;
  onClick: () => void;
  children: React.ReactNode;
}

function RailButton({ active = false, title, label, tooltipOpen, buttonRef, expanded, controls, onKeyDown, onClick, children }: RailButtonProps) {
  return (
    <Tooltip title={title} placement="right" mouseEnterDelay={0.4} open={tooltipOpen}>
      <button
        type="button"
        ref={buttonRef}
        aria-pressed={expanded === undefined ? active : undefined}
        aria-haspopup={controls ? "menu" : undefined}
        aria-expanded={expanded}
        aria-controls={controls}
        aria-label={label ?? (typeof title === "string" ? title : undefined)}
        data-active={active ? "true" : "false"}
        className="app-rail-button app-marker-host app-marker-rail h-10 w-10 flex items-center justify-center rounded-md"
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        {children}
      </button>
    </Tooltip>
  );
}

interface QuickThemeModeOption {
  key: ThemeCategory;
  labelKey: string;
  accent: string;
}

const quickThemeModeOptions: QuickThemeModeOption[] = [
  {
    key: "dark",
    labelKey: "settings.general.appearance.dark",
    accent: "#f5bd69",
  },
  {
    key: "light",
    labelKey: "settings.general.appearance.light",
    accent: "#4f6cf7",
  },
  {
    key: "system",
    labelKey: "settings.general.appearance.system",
    accent: "#94a3b8",
  },
];

const SETTINGS_ID = "__settings__";

export function SettingsMenu({
  open,
  menuId,
  activeSubmenu,
  onClose,
  onCheckVersion,
  onToggleSubmenu,
  onClearSubmenu,
  checkingForUpdate,
}: {
  open: boolean;
  menuId: string;
  activeSubmenu: QuickSettingsSubmenu;
  onClose: () => void;
  onCheckVersion: () => void;
  onToggleSubmenu: (submenu: Exclude<QuickSettingsSubmenu, null>) => void;
  onClearSubmenu: () => void;
  checkingForUpdate: boolean;
}) {
  const { t } = useTranslation();
  const themeCategory = useAppStore((s) => s.themeCategory);
  const setThemeCategory = useAppStore((s) => s.setThemeCategory);
  const language = useAppStore((s) => s.language);
  const setLanguage = useAppStore((s) => s.setLanguage);
  const openTab = useAppStore((s) => s.openTab);
  const containerRef = useRef<HTMLDivElement>(null);
  const previousSubmenuRef = useRef<QuickSettingsSubmenu>(null);

  function focusSubmenu(submenu: Exclude<QuickSettingsSubmenu, null>) {
    const menu = containerRef.current?.querySelector<HTMLElement>(`[data-submenu="${submenu}"]`);
    const selected = menu?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    (selected ?? menu?.querySelector<HTMLButtonElement>("button"))?.focus();
  }

  useEffect(() => {
    const previousSubmenu = previousSubmenuRef.current;
    previousSubmenuRef.current = activeSubmenu;
    if (!open) return;

    if (activeSubmenu) {
      focusSubmenu(activeSubmenu);
    } else {
      const selector = previousSubmenu
        ? `[data-opens-submenu="${previousSubmenu}"]`
        : '[role="menuitem"]';
      containerRef.current?.querySelector<HTMLButtonElement>(selector)?.focus();
    }
  }, [open, activeSubmenu]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
    const menu = button?.closest<HTMLElement>('[role="menu"]');
    if (!button || !menu) return;

    if (event.key === "Escape" || (event.key === "ArrowLeft" && menu.dataset.submenu)) {
      event.preventDefault();
      event.stopPropagation();
      if (activeSubmenu) onClearSubmenu();
      else onClose();
      return;
    }

    if (event.key === "Tab") {
      // 先返回触发按钮，再由浏览器将 Tab 焦点移到工作台中的下一个控件。
      onClose();
      return;
    }

    if (event.key === "ArrowRight") {
      const submenu = button.dataset.opensSubmenu as QuickSettingsSubmenu;
      if (submenu) {
        event.preventDefault();
        event.stopPropagation();
        if (activeSubmenu === submenu) focusSubmenu(submenu);
        else onToggleSubmenu(submenu);
      }
      return;
    }

    const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>("button"));
    const nextIndex = getQuickSettingsMenuFocusIndex(event.key, buttons.indexOf(button), buttons.length);
    if (nextIndex !== null) {
      event.preventDefault();
      event.stopPropagation();
      buttons[nextIndex]?.focus();
    }
  }

  const currentThemeLabel = t(`settings.general.appearance.${themeCategory}`);
  const languageLabels = [
    { value: "zh_CN" as Language, label: t("settings.languageName.zh_CN") },
    { value: "en" as Language, label: t("settings.languageName.en") },
    { value: "ja" as Language, label: t("settings.languageName.ja") },
  ] as const;
  const currentLangLabel =
    languageLabels.find((item) => item.value === language)?.label ?? language;
  const settingsShortcut = useShortcutStore((s) => getAppShortcut(s.overrides, "openSettings"));

  const handleOpenSettings = () => {
    onClose();
    openTab(SETTINGS_ID);
  };

  const handleSelectLanguage = (lang: Language) => {
    setLanguage(lang);
    void i18n.changeLanguage(toI18nLanguage(lang));
    onClearSubmenu();
  };

  const handleSelectThemeCategory = (category: ThemeCategory) => {
    setThemeCategory(category);
    onClearSubmenu();
  };

  return (
    <div ref={containerRef} className="relative" onKeyDown={handleKeyDown}>
      {/* Main menu */}
      <div
        id={menuId}
        role="menu"
        aria-label={t("common.settings")}
        className="w-56 rounded-lg overflow-hidden"
        style={{
          background: "var(--cs-bg-sidebar)",
          border: "1px solid var(--cs-border-sidebar)",
        }}
      >

        {/* Menu items */}
        <div className="py-1">
          <MenuItem
            label={t("settings.quickMenu.theme", "主题")}
            value={currentThemeLabel}
            showArrow
            active={activeSubmenu === "theme"}
            submenu="theme"
            controls={`${menuId}-theme`}
            onClick={() => onToggleSubmenu("theme")}
          />
          <MenuItem
            label={t("settings.quickMenu.language", "语言")}
            value={currentLangLabel}
            showArrow
            active={activeSubmenu === "language"}
            submenu="language"
            controls={`${menuId}-language`}
            onClick={() => onToggleSubmenu("language")}
          />
          <div role="separator" className="my-1 border-t border-[var(--cs-border-sidebar)]" />
          <MenuItem
            label={t("common.settings", "设置")}
            shortcut={settingsShortcut}
            onClick={handleOpenSettings}
          />

          <MenuItem
            label={checkingForUpdate
              ? t("settings.quickMenu.checkingForUpdate")
              : t("settings.quickMenu.checkVersion", "检查更新")}
            onClick={onCheckVersion}
          />
        </div>
      </div>

      {/* Submenu: Language */}
      {activeSubmenu === "language" && (
        <div
          id={`${menuId}-language`}
          role="menu"
          aria-label={t("settings.quickMenu.language")}
          data-submenu="language"
          className="absolute left-full top-0 ml-1 w-48 rounded-lg overflow-hidden py-1"
          style={{
            background: "var(--cs-bg-sidebar)",
            border: "1px solid var(--cs-border-sidebar)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
          }}
        >
          {languageLabels.map(({ value: lang, label }) => {
            const isSelected = language === lang;
            return (
              <button
                key={lang}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                tabIndex={-1}
                className="app-quick-settings-item flex w-full items-center justify-between px-4 py-2 text-left transition-colors"
                onClick={() => handleSelectLanguage(lang)}
              >
                <span className="text-sm">{label}</span>
                {isSelected && (
                  <span aria-hidden="true" className="text-xs text-[var(--cs-primary)]">
                    ✓
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Submenu: Theme */}
      {activeSubmenu === "theme" && (
        <div
          id={`${menuId}-theme`}
          role="menu"
          aria-label={t("settings.quickMenu.theme")}
          data-submenu="theme"
          className="absolute left-full top-0 ml-1 w-48 rounded-lg overflow-hidden py-1"
          style={{
            background: "var(--cs-bg-sidebar)",
            border: "1px solid var(--cs-border-sidebar)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
          }}
        >
          {quickThemeModeOptions.map((opt) => {
            const isSelected = themeCategory === opt.key;
            return (
              <button
                key={opt.key}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                tabIndex={-1}
                className="app-quick-settings-item flex w-full items-center justify-between px-4 py-2 text-left transition-colors"
                onClick={() => handleSelectThemeCategory(opt.key)}
              >
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="w-3 h-3 rounded-full shrink-0"
                    style={{ background: opt.accent }}
                  />
                  <span className="text-sm">{t(opt.labelKey)}</span>
                </span>
                {isSelected && (
                  <span aria-hidden="true" className="text-xs text-[var(--cs-primary)]">
                    ✓
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  label,
  value,
  shortcut,
  showArrow,
  active,
  submenu,
  controls,
  onClick,
}: {
  label: string;
  value?: string;
  shortcut?: string;
  showArrow?: boolean;
  active?: boolean;
  submenu?: Exclude<QuickSettingsSubmenu, null>;
  controls?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      aria-haspopup={submenu ? "menu" : undefined}
      aria-expanded={submenu ? Boolean(active) : undefined}
      aria-controls={controls}
      data-opens-submenu={submenu}
      data-active={active ? "true" : "false"}
      className="app-quick-settings-item flex w-full items-center justify-between px-4 py-2 text-left transition-colors"
      onClick={onClick}
    >
      <span className="text-sm">{label}</span>
      <span className="flex items-center gap-1.5">
        {value && (
          <span className="text-xs" style={{ color: "var(--cs-text-secondary)" }}>
            {value}
          </span>
        )}
        {shortcut && <ShortcutHint keys={shortcut} />}
        {showArrow && (
          <span aria-hidden="true" className="text-xs" style={{ color: active ? "var(--cs-primary)" : "var(--cs-text-secondary)" }}>
            ›
          </span>
        )}
      </span>
    </button>
  );
}

function PrimarySidebarRail() {
  const { t } = useTranslation();
  const activeSidebarSection = useAppStore((s) => s.activeSidebarSection);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const setActiveSidebarSection = useAppStore((s) => s.setActiveSidebarSection);
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);
  const gitChangeCount = useAppStore((s) => s.gitChangeCount);
  const gitAheadCount = useAppStore((s) => s.gitAheadCount);
  const gitBehindCount = useAppStore((s) => s.gitBehindCount);
  const [quickSettingsOpen, setQuickSettingsOpen] = useState(false);
  const [quickSettingsSubmenu, setQuickSettingsSubmenu] = useState<QuickSettingsSubmenu>(null);
  const quickSettingsButtonRef = useRef<HTMLButtonElement>(null);
  const quickSettingsMenuId = useId();
  const checkingForUpdate = useApplicationUpdateStore((state) => state.phase === "checking");
  const remoteWorkspaceVisible = useRemoteWorkspaceStore((state) => state.visible);

  const handleQuickSettingsOpenChange = useCallback((open: boolean) => {
    setQuickSettingsOpen(open);
    setQuickSettingsSubmenu((activeSubmenu) =>
      getQuickSettingsSubmenuOnPopoverChange(open, activeSubmenu)
    );
  }, []);

  const handleToggleQuickSettingsSubmenu = useCallback(
    (submenu: Exclude<QuickSettingsSubmenu, null>) => {
      setQuickSettingsSubmenu((activeSubmenu) =>
        toggleQuickSettingsSubmenu(activeSubmenu, submenu)
      );
    },
    []
  );

  const handleCloseQuickSettings = useCallback(() => {
    handleQuickSettingsOpenChange(false);
    quickSettingsButtonRef.current?.focus();
  }, [handleQuickSettingsOpenChange]);

  const handleCheckVersion = useCallback(async () => {
    if (checkingForUpdate) return;

    const messageKey = "termflow-update";
    handleCloseQuickSettings();
    message.info({
      key: messageKey,
      content: t("settings.quickMenu.checkingForUpdate"),
    });

    const result = await checkForApplicationUpdate({ manual: true });
    if (result.status === "up-to-date") {
      message.success({
        key: messageKey,
        content: t("settings.quickMenu.upToDate", { version: result.currentVersion }),
      });
      return;
    }
    if (result.status === "error") {
      message.error({
        key: messageKey,
        content: t("settings.quickMenu.updateCheckFailed"),
      });
      return;
    }
    message.success({
      key: messageKey,
      content: t("settings.quickMenu.updateAvailable", { version: result.version }),
    });
  }, [checkingForUpdate, handleCloseQuickSettings, t]);

  const handleActivate = useCallback(
    (section: SidebarSection) => {
      if (section === activeSidebarSection) {
        setSidebarCollapsed(!sidebarCollapsed);
        return;
      }

      setActiveSidebarSection(section);
      setSidebarCollapsed(false);
    },
    [activeSidebarSection, setActiveSidebarSection, setSidebarCollapsed, sidebarCollapsed]
  );

  const gitTooltip = (
    <div className="flex flex-col gap-1 text-xs leading-5">
      <div>{t("sidebar.gitSection", "Git")}</div>
      <div>{t("sidebar.gitAhead", { count: gitAheadCount })}</div>
      <div>{t("sidebar.gitBehind", { count: gitBehindCount })}</div>
    </div>
  );

  return (
    <aside
      className="app-shell-chrome app-sidebar-rail flex h-full w-12 shrink-0 flex-col items-center justify-between py-2"
    >
      <div className="flex flex-col items-center gap-1.5">
        <RailButton
          active={activeSidebarSection === "sessions"}
          title={t("sidebar.sessionsSection")}
          onClick={() => handleActivate("sessions")}
        >
          <WorkbenchGlyph kind="terminal" />
        </RailButton>
        <RailButton
          active={activeSidebarSection === "project"}
          title={t("common.file")}
          onClick={() => handleActivate("project")}
        >
          <WorkbenchGlyph kind="folder" />
        </RailButton>
        <div className="relative">
          <RailButton
            active={activeSidebarSection === "git"}
            title={gitTooltip}
            label={t("sidebar.gitSection", "Git")}
            onClick={() => handleActivate("git")}
          >
            <WorkbenchGlyph kind="git" />
          </RailButton>
          {gitChangeCount > 0 && (
            <span
              className="pointer-events-none absolute bottom-[1px] right-[1px] flex h-[20px] min-w-[20px] items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none"
              style={{
                background: "var(--cs-primary)",
                color: "#fff",
                border: "2px solid var(--cs-bg-sidebar)",
                boxShadow: "0 0 0 1px color-mix(in srgb, var(--cs-border-sidebar) 72%, transparent)",
              }}
            >
              {gitChangeCount > 99 ? "99+" : gitChangeCount}
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-col items-center gap-1.5">
        <RailButton
          active={remoteWorkspaceVisible}
          title={t("remote.title")}
          onClick={() => useRemoteWorkspaceStore.getState().setVisible(!remoteWorkspaceVisible)}
        >
          <CloudServerOutlined className="text-[18px]" />
        </RailButton>
        <BottomRunnerRailButton />
        <Popover
          trigger="click"
          placement="rightBottom"
          content={(
            <SettingsMenu
              open={quickSettingsOpen}
              menuId={quickSettingsMenuId}
              activeSubmenu={quickSettingsSubmenu}
              onClose={handleCloseQuickSettings}
              onCheckVersion={() => void handleCheckVersion()}
              onToggleSubmenu={handleToggleQuickSettingsSubmenu}
              onClearSubmenu={() => setQuickSettingsSubmenu(null)}
              checkingForUpdate={checkingForUpdate}
            />
          )}
          open={quickSettingsOpen}
          onOpenChange={handleQuickSettingsOpenChange}
          styles={{ container: { padding: 0, background: "transparent", boxShadow: "none" } }}
        >
          <div>
            <RailButton
              active={quickSettingsOpen}
              title={t("common.settings")}
              tooltipOpen={quickSettingsOpen ? false : undefined}
              buttonRef={quickSettingsButtonRef}
              expanded={quickSettingsOpen}
              controls={quickSettingsMenuId}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  event.stopPropagation();
                  handleQuickSettingsOpenChange(true);
                }
              }}
              onClick={() => {}}
            >
              <SettingOutlined className="app-nav-settings-gear text-[18px]" />
            </RailButton>
          </div>
        </Popover>
      </div>
    </aside>
  );
}

export default PrimarySidebarRail;
