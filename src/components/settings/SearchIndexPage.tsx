import { DatabaseOutlined } from "@ant-design/icons";
import { Switch, Tag } from "antd";
import { useTranslation } from "react-i18next";
import { SettingsPageHeader } from "@/components/settings/SettingsPageHeader";

interface IndexSettingRowProps {
  title: string;
  description: string;
}

function IndexSettingRow({ title, description }: IndexSettingRowProps) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-between gap-6 px-5 py-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium" style={{ color: "var(--cs-text-primary)" }}>
            {title}
          </span>
          <Tag className="m-0">{t("settings.searchIndex.comingSoon")}</Tag>
        </div>
        <div className="mt-1 text-xs leading-5" style={{ color: "var(--cs-text-tertiary)" }}>
          {description}
        </div>
      </div>
      <Switch disabled aria-label={title} />
    </div>
  );
}

export function SearchIndexPage() {
  const { t } = useTranslation();

  return (
    <div className="mx-auto max-w-5xl">
      <SettingsPageHeader
        title={t("settings.searchIndex.title")}
        description={t("settings.searchIndex.subtitle")}
      />

      <div
        className="mb-2 flex items-center gap-2 px-1 text-[11px] font-semibold uppercase tracking-widest"
        style={{ color: "var(--cs-text-tertiary)" }}
      >
        <DatabaseOutlined />
        {t("settings.searchIndex.repositories")}
      </div>
      <section
        className="app-glass-card overflow-hidden rounded-xl"
        style={{ background: "var(--cs-bg-card)", border: "1px solid var(--cs-border-card)" }}
      >
        <IndexSettingRow
          title={t("settings.searchIndex.autoIndexTitle")}
          description={t("settings.searchIndex.autoIndexDescription")}
        />
        <div style={{ borderTop: "1px solid var(--cs-border-card)" }}>
          <IndexSettingRow
            title={t("settings.searchIndex.instantSearchTitle")}
            description={t("settings.searchIndex.instantSearchDescription")}
          />
        </div>
      </section>
    </div>
  );
}

export default SearchIndexPage;
