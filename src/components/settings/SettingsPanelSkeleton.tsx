import { useTranslation } from "react-i18next";
import "@/styles/settingsSkeleton.css";

function SkeletonBlock({ className }: { className: string }) {
  return <div className={`app-settings-skeleton-block ${className}`} />;
}

// 与首次打开的通用设置页保持相同布局；独立于设置模块，懒加载期间即可显示。
export function SettingsPanelSkeleton() {
  const { t } = useTranslation();

  return (
    <div
      className="app-settings-skeleton flex h-full min-h-0"
      role="status"
      aria-label={t("settings.loading")}
      aria-busy="true"
    >
      <div
        aria-hidden="true"
        className="app-settings-nav w-16 shrink-0 overflow-hidden border-r border-[var(--cs-border-sidebar)] px-2 py-5 min-[960px]:w-[var(--cs-workspace-tab-width)] min-[960px]:px-3"
      >
        <SkeletonBlock className="mx-auto mb-4 h-6 w-6 min-[960px]:w-full" />
        {[5, 6, 4].map((count, group) => (
          <div key={group} className={group > 0 ? "mt-5" : undefined}>
            <SkeletonBlock className="mb-2 ml-3 hidden h-2.5 w-12 min-[960px]:block" />
            {Array.from({ length: count }, (_, index) => (
              <div key={index} className="mb-1 flex h-9 items-center justify-center gap-3 px-2 min-[960px]:justify-start min-[960px]:px-3">
                <SkeletonBlock className="h-4 w-4 shrink-0" />
                <SkeletonBlock className={`hidden h-3 min-[960px]:block ${index % 2 === 0 ? "w-20" : "w-14"}`} />
              </div>
            ))}
          </div>
        ))}
      </div>

      <div aria-hidden="true" className="flex min-w-0 flex-1 justify-center overflow-hidden">
        <div className="w-full max-w-[1280px] px-8 py-6 xl:px-10">
          <div className="mb-6 rounded-xl border border-[var(--cs-border-card)] p-5">
            <SkeletonBlock className="h-[25px] w-28 max-w-full" />
          </div>

          <SkeletonBlock className="mb-3 h-3 w-16" />
          <div className="mb-6 rounded-xl border border-[var(--cs-border-card)] p-5">
            <div className="flex flex-col gap-4 border-b border-[var(--cs-border-card)] pb-5 min-[760px]:flex-row min-[760px]:items-center min-[760px]:justify-between">
              <SkeletonBlock className="h-4 w-24 max-w-full" />
              <SkeletonBlock className="h-8 w-44 max-w-full" />
            </div>
            <div className="mt-5 grid grid-cols-1 gap-4 min-[760px]:grid-cols-2">
              {[0, 1].map((index) => (
                <div key={index} className="overflow-hidden rounded-2xl border border-[var(--cs-border-card)]">
                  <SkeletonBlock className="h-44 w-full !rounded-none" />
                  <div className="space-y-2 p-4">
                    <SkeletonBlock className="h-4 w-24 max-w-full" />
                    <SkeletonBlock className="h-3 w-3/4" />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {[0, 1, 2].map((section) => (
            <div key={section} className="mb-6">
              <SkeletonBlock className="mb-3 h-3 w-16" />
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[var(--cs-border-card)] px-5 py-4">
                <SkeletonBlock className="h-4 w-28 max-w-full" />
                <SkeletonBlock className={`h-8 max-w-full ${section === 2 ? "w-11 !rounded-full" : "w-36"}`} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
