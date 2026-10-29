import { useTranslation } from "react-i18next";
import "@/styles/settingsSkeleton.css";

function SkeletonBlock({ className }: { className: string }) {
  return <div className={`app-settings-skeleton-block ${className}`} />;
}

// 与通用设置共用外壳和细线分组，避免懒加载后布局跳动。
export function SettingsPanelSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="app-settings app-settings-skeleton" role="status" aria-label={t("settings.loading")} aria-busy="true">
      <div aria-hidden="true" className="app-settings-nav overflow-hidden">
        <SkeletonBlock className="mb-5 h-6 w-full" />
        {[6, 8, 3, 1].map((count, group) => <div key={group} className="app-settings-nav__group">
          <SkeletonBlock className="app-settings-nav__group-title h-2.5 w-12" />
          {Array.from({ length: count }, (_, index) => <div key={index} className="app-settings-nav__item">
            <SkeletonBlock className="h-3.5 w-3.5 shrink-0" />
            <SkeletonBlock className={`app-settings-nav__label h-3 ${index % 2 ? "w-14" : "w-20"}`} />
          </div>)}
        </div>)}
      </div>
      <div aria-hidden="true" className="app-settings-scroll overflow-hidden">
        <div className="app-settings-content">
          <div className="app-settings-page-header"><SkeletonBlock className="h-[30px] w-28" /></div>
          <div className="app-settings-section">
            <SkeletonBlock className="mb-4 h-4 w-20" />
            <div className="app-settings-control-line justify-between">
              <SkeletonBlock className="h-4 w-24" /><SkeletonBlock className="h-8 w-44 max-w-full" />
            </div>
            <div className="app-settings-grid mt-4">
              {[0, 1].map(index => <div key={index} className="overflow-hidden rounded-lg border border-[var(--cs-border-card)]">
                <SkeletonBlock className="h-28 w-full !rounded-none" />
                <div className="p-3"><SkeletonBlock className="h-4 w-24 max-w-full" /></div>
              </div>)}
            </div>
          </div>
          {[0, 1, 2].map(section => <div key={section} className="app-settings-section">
            <SkeletonBlock className="mb-4 h-4 w-20" />
            <div className="app-setting-row">
              <SkeletonBlock className="h-4 w-28 max-w-full" />
              <SkeletonBlock className={`h-8 max-w-full ${section === 2 ? "w-11 !rounded-full" : "w-36"}`} />
            </div>
          </div>)}
        </div>
      </div>
    </div>
  );
}
