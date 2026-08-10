import { CodeOutlined, FolderOutlined, SettingOutlined, BranchesOutlined } from "@ant-design/icons";
import { message, Popover, Tooltip } from "antd";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ShortcutHint } from "@/components/ui/ShortcutHint";
import { getKeysForAction } from "@/constants/shortcuts";
import { useAppStore, type Language, type SidebarSection, type ThemeCategory } from "@/store";
import { setClaudeTheme } from "@/lib/api";
import i18n, { toI18nLanguage } from "@/i18n";
import packageJson from "../../../package.json";

interface RailButtonProps {
  active?: boolean;
  title: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
}

function RailButton({ active = false, title, onClick, children }: RailButtonProps) {
  return (
    <Tooltip title={title} placement="right" mouseEnterDelay={0.4}>
      <button
        type="button"
        aria-pressed={active}
        data-active={active ? "true" : "false"}
        className="app-rail-button app-marker-host app-marker-rail h-10 w-10 flex items-center justify-center rounded-md"
        onClick={onClick}
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

type SubmenuKey = null | "language" | "theme";

function SettingsMenu({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const themeCategory = useAppStore((s) => s.themeCategory);
  const setThemeCategory = useAppStore((s) => s.setThemeCategory);
  const language = useAppStore((s) => s.language);
  const setLanguage = useAppStore((s) => s.setLanguage);
  const openTab = useAppStore((s) => s.openTab);
  const currentProject = useAppStore((s) => s.currentProject);
  const projectPath = currentProject?.path ?? null;
  const [activeSubmenu, setActiveSubmenu] = useState<SubmenuKey>(null);
  const systemPrefersDark = useAppStore((s) => s.systemPrefersDark);

  const currentThemeLabel = t(`settings.general.appearance.${themeCategory}`);
  const languageLabels = [
    { value: "zh_CN" as Language, label: t("settings.languageName.zh_CN") },
    { value: "zh_TW" as Language, label: t("settings.languageName.zh_TW") },
    { value: "en" as Language, label: t("settings.languageName.en") },
    { value: "ja" as Language, label: t("settings.languageName.ja") },
  ] as const;
  const currentLangLabel =
    languageLabels.find((item) => item.value === language)?.label ?? language;
  const settingsShortcut = getKeysForAction("openSettings");

  const handleOpenSettings = () => {
    openTab(SETTINGS_ID);
    onClose();
  };

  const handleCheckVersion = () => {
    message.info(t("settings.quickMenu.currentVersion", {
      version: packageJson.version,
    }));
    onClose();
  };

  const handleSelectLanguage = (lang: Language) => {
    setLanguage(lang);
    void i18n.changeLanguage(toI18nLanguage(lang));
    setActiveSubmenu(null);
  };

  const handleSelectThemeCategory = (category: ThemeCategory) => {
    setThemeCategory(category);
    const effectiveCategory = category === "system"
      ? (systemPrefersDark ? "dark" : "light")
      : category;
    setClaudeTheme(effectiveCategory, projectPath).catch((error) => {
      console.error("Failed to sync Claude theme:", error);
    });

    setActiveSubmenu(null);
  };

  return (
    <div className="relative">
      {/* Main menu */}
      <div
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
            onClick={() => setActiveSubmenu(activeSubmenu === "theme" ? null : "theme")}
          />
          <MenuItem
            label={t("settings.quickMenu.language", "语言")}
            value={currentLangLabel}
            showArrow
            active={activeSubmenu === "language"}
            onClick={() => setActiveSubmenu(activeSubmenu === "language" ? null : "language")}
          />
          <div style={{ borderTop: "1px solid var(--cs-border-sidebar)", margin: "4px 0" }} />
          <MenuItem
            label={t("common.settings", "设置")}
            shortcut={settingsShortcut}
            showArrow
            onClick={handleOpenSettings}
          />

          <MenuItem
            label={t("settings.quickMenu.checkVersion", "检查版本")}
            onClick={handleCheckVersion}
          />
        </div>
      </div>

      {/* Submenu: Language */}
      {activeSubmenu === "language" && (
        <div
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
              <div
                key={lang}
                className="flex items-center justify-between px-4 py-2 cursor-pointer transition-colors"
                style={{ color: "var(--cs-text-primary)" }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--cs-bg-hover)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
                onClick={() => handleSelectLanguage(lang)}
              >
                <span className="text-sm">{label}</span>
                {isSelected && (
                  <span className="text-xs" style={{ color: "var(--cs-primary)" }}>
                    ✓
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Submenu: Theme */}
      {activeSubmenu === "theme" && (
        <div
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
              <div
                key={opt.key}
                className="flex items-center justify-between px-4 py-2 cursor-pointer transition-colors"
                style={{ color: "var(--cs-text-primary)" }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--cs-bg-hover)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
                onClick={() => handleSelectThemeCategory(opt.key)}
              >
                <div className="flex items-center gap-2">
                  <div
                    className="w-3 h-3 rounded-full flex-shrink-0"
                    style={{ background: opt.accent }}
                  />
                  <span className="text-sm">{t(opt.labelKey)}</span>
                </div>
                {isSelected && (
                  <span className="text-xs" style={{ color: "var(--cs-primary)" }}>
                    ✓
                  </span>
                )}
              </div>
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
  onClick,
}: {
  label: string;
  value?: string;
  shortcut?: string;
  showArrow?: boolean;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <div
      className="flex items-center justify-between px-4 py-2 cursor-pointer transition-colors"
      style={{
        color: "var(--cs-text-primary)",
        background: active ? "var(--cs-bg-hover)" : "transparent",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--cs-bg-hover)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
      onClick={onClick}
    >
      <span className="text-sm">{label}</span>
      <div className="flex items-center gap-1.5">
        {value && (
          <span className="text-xs" style={{ color: "var(--cs-text-secondary)" }}>
            {value}
          </span>
        )}
        {shortcut && <ShortcutHint keys={shortcut} />}
        {showArrow && (
          <span className="text-xs" style={{ color: active ? "var(--cs-primary)" : "var(--cs-text-secondary)" }}>
            ›
          </span>
        )}
      </div>
    </div>
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
          <CodeOutlined className="text-[18px]" />
        </RailButton>
        <RailButton
          active={activeSidebarSection === "project"}
          title={t("common.file")}
          onClick={() => handleActivate("project")}
        >
          <FolderOutlined className="text-[18px]" />
        </RailButton>
        <div className="relative">
          <RailButton
            active={activeSidebarSection === "git"}
            title={gitTooltip}
            onClick={() => handleActivate("git")}
          >
            <BranchesOutlined className="text-[18px]" />
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
        <Popover
          trigger="click"
          placement="rightBottom"
          content={<SettingsMenu onClose={() => setQuickSettingsOpen(false)} />}
          open={quickSettingsOpen}
          onOpenChange={setQuickSettingsOpen}
          overlayInnerStyle={{ padding: 0, background: "transparent", boxShadow: "none" }}
        >
          <div>
            <RailButton active={quickSettingsOpen} title={t("common.settings")} onClick={() => {}}>
              <SettingOutlined className="text-[18px]" />
            </RailButton>
          </div>
        </Popover>
      </div>
    </aside>
  );
}

export default PrimarySidebarRail;
