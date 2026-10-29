import { lazy, Suspense, useEffect, useRef } from "react";
import { ArrowLeftOutlined, CopyOutlined, EyeOutlined, GithubOutlined, GlobalOutlined, LinkOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Alert, Avatar, Button, Empty, Input, Spin, message } from "antd";
import { useTranslation } from "react-i18next";
import { openExternalUrl } from "@/lib/api";
import { MARKETPLACE_CATEGORIES, marketplaceBrowseView, marketplaceInstallCommand, marketplaceDetailErrorKind, marketplaceRepositoryUrl, marketplaceSkillKey, marketplaceSkillUrl, marketplaceIsGitHubSource } from "@/lib/skillMarketplace";
import { skillMarkdownBody } from "@/lib/skills";
import { useSkillMarketplaceStore } from "@/store/slices/skillMarketplaceSlice";
import { SkillMarketplaceSkeleton } from "./SkillMarketplaceSkeleton";
import { SettingsPageHeader } from "./SettingsPageHeader";

const MarkdownPreview = lazy(() => import("@/components/markdown/MarkdownPreview"));

interface Props {
  isActive: boolean;
}

export default function SkillMarketplacePage({ isActive }: Props) {
  const { t, i18n } = useTranslation();
  const market = useSkillMarketplaceStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const isSearch = [...market.query.trim()].length >= 2;
  const detail = market.detail;
  const initialLoading = !market.results && !market.error;
  const listLoading = market.loading || initialLoading;
  const summaryLoadingKeys = new Set(market.summaryLoadingKeys);
  const detailErrorKind = marketplaceDetailErrorKind(market.detailError);
  const installCommand = market.selected ? marketplaceInstallCommand(market.selected) : null;
  const view = marketplaceBrowseView(market.results?.skills ?? [], market.category, market.page, isSearch ? "leaderboard" : market.viewMode);
  const canGoNext = view.hasMore || (!isSearch && market.results?.nextPage != null);
  const navigationBusy = market.loading || market.loadingMore;
  const visible = view.sections.flatMap((section) => section.skills);
  const visibleKey = visible.map(marketplaceSkillKey).join("\n");
  const formatInstalls = (count: number) => new Intl.NumberFormat(i18n.language, { notation: "compact", maximumFractionDigits: 1 }).format(count);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: market.selected ? 0 : useSkillMarketplaceStore.getState().listScrollTop });
  }, [market.category, market.query, market.page, market.viewMode, market.selected]);

  useEffect(() => {
    if (!isActive) return;
    const timer = window.setTimeout(() => { void useSkillMarketplaceStore.getState().search(); }, 400);
    return () => window.clearTimeout(timer);
  }, [isActive, market.query]);

  useEffect(() => {
    if (isActive && !market.selected && visible.length) void useSkillMarketplaceStore.getState().loadSummaries(visible);
  }, [isActive, market.selected, visibleKey]);

  async function openSource(url: string) {
    try { await openExternalUrl(url); }
    catch (reason) { message.error(t("settings.skills.operationFailed", { reason: String(reason) })); }
  }

  async function copyCommand() {
    if (!installCommand) return;
    try { await navigator.clipboard.writeText(installCommand); message.success(t("common.copied")); }
    catch (reason) { message.error(t("settings.skills.operationFailed", { reason: String(reason) })); }
  }

  function previewSkill(skill: (typeof visible)[number]) {
    market.setListScrollTop(scrollRef.current?.scrollTop ?? 0);
    void market.selectSkill(skill);
  }

  const pagination = <nav className="app-skill-market-pagination" aria-label={t("settings.skillMarket.pagination")}>
    <span className="app-skills-muted">{t("settings.skillMarket.pageLabel", { page: view.page })}</span>
    <div className="flex items-center gap-2">
      <Button disabled={view.page <= 1 || navigationBusy} onClick={() => market.setPage(view.page - 1)}>{t("settings.skillMarket.previousPage")}</Button>
      <Button loading={market.loadingMore} disabled={!canGoNext || market.loading || !!market.error}
        onClick={() => void market.nextPage()}>{t("settings.skillMarket.nextPage")}</Button>
    </div>
  </nav>;

  return <div ref={scrollRef} className="app-skill-market-page app-skills-library h-full overflow-auto">
    <div className="app-skill-market-page-inner">
      <SettingsPageHeader title={t("settings.skillMarket.title")} description={t("settings.skillMarket.description")}
        actions={!market.selected && <div className="flex items-center gap-2">
          <Button icon={<ReloadOutlined spin={market.loading} />} disabled={market.loading && !market.loadingSlow} onClick={() => void market.search(true)}>{t("common.refresh")}</Button>
        </div>} />
    {market.selected ? <div>
      <Button type="text" className="mb-4" icon={<ArrowLeftOutlined />} onClick={() => void market.selectSkill(null)}>{t("settings.skillMarket.back")}</Button>
      <h3 className="font-semibold text-lg">{detail?.skill.name ?? market.selected.name}</h3>
      <p className="app-skills-secondary text-xs mt-1 mb-4">{market.selected.repository}</p>
      <div className="app-skill-market-detail">
        <section className="min-w-0">
          {market.detailLoading ? <div className="flex justify-center py-20"><Spin /></div> : market.detailError ?
            <Alert type={detailErrorKind === "previewUnavailable" ? "info" : detailErrorKind === "unavailable" ? "warning" : "error"} showIcon
              message={t(`settings.skillMarket.${detailErrorKind === "request" ? "detailFailed" : detailErrorKind}`)}
              description={detailErrorKind === "request" ? market.detailError : t(`settings.skillMarket.${detailErrorKind}Hint`)}
              action={<Button onClick={() => market.selected && void market.selectSkill(market.selected, true)}>{t("common.refresh")}</Button>} /> : detail && <>
              <p className="app-skills-secondary text-sm mb-3">{detail.skill.description}</p>
              <Suspense fallback={<div className="py-8"><Spin /></div>}>
                <MarkdownPreview content={skillMarkdownBody(detail.content)} emptyText={t("settings.skills.editor.emptyBody")}
                  className="app-skill-markdown-preview" enableImagePreview={false} onOpenExternalLink={(href) => void openSource(href)} />
              </Suspense>
            </>}
        </section>
        <aside className="app-skill-market-guide">
          <h4 className="text-sm font-semibold mb-2">{t("settings.skillMarket.manualInstall")}</h4>
          <p className="app-skills-secondary text-xs mb-3">{t("settings.skillMarket.manualInstallHint")}</p>
          {installCommand ? <>
            <pre className="app-skills-content whitespace-pre-wrap break-all mb-3"><code>{installCommand}</code></pre>
            <Button block icon={<CopyOutlined />} onClick={() => void copyCommand()}>{t("settings.skillMarket.copyCommand")}</Button>
          </> : <p className="app-skills-secondary text-xs">{t("settings.skillMarket.commandUnavailable")}</p>}
          <p className="app-skills-secondary text-xs mt-3 mb-3">{t("settings.skillMarket.commandHint")}</p>
          <Button type="link" className="!px-0" icon={<LinkOutlined />} onClick={() => market.selected && void openSource(marketplaceSkillUrl(market.selected))}>{t("settings.skillMarket.viewListing")}</Button>
          {detail ? <>
            <Button type="link" className="!px-0" icon={<LinkOutlined />} onClick={() => void openSource(detail.sourceUrl)}>{t("settings.skillMarket.viewSource")}</Button>
            {!detail.previewOnly && <details className="mt-3">
              <summary className="app-skills-secondary text-xs cursor-pointer">{t("settings.skillMarket.resourceFiles")} ({detail.fileCount})</summary>
              <ul className="max-h-40 overflow-y-auto mt-2">{detail.files.map((path) => <li className="app-skills-path" key={path}>{path}</li>)}</ul>
            </details>}
          </> : marketplaceIsGitHubSource(market.selected) && <Button type="link" className="!px-0" icon={<LinkOutlined />} onClick={() => market.selected && void openSource(marketplaceRepositoryUrl(market.selected))}>{t("settings.skillMarket.viewRepository")}</Button>}
        </aside>
      </div>
    </div> : <div>
      <div className="app-skill-market-controls">
        {!isSearch && <nav className="app-skill-market-categories" aria-label={t("settings.skillMarket.categoryFilter")}>
          <button type="button" className="app-skill-market-category" aria-pressed={market.category === "all" && market.viewMode === "featured"}
            onClick={() => market.setViewMode("featured")}>{t("settings.skillMarket.featured")}</button>
          <button type="button" className="app-skill-market-category" aria-pressed={market.category === "all" && market.viewMode === "leaderboard"}
            onClick={() => market.setViewMode("leaderboard")}>{t("settings.skillMarket.leaderboard")}</button>
          {MARKETPLACE_CATEGORIES.filter((category) => category !== "all").map((category) => <button key={category} type="button" className="app-skill-market-category"
            aria-pressed={market.category === category} onClick={() => market.setCategory(category)}>{t(`settings.skillMarket.categories.${category}`)}</button>)}
        </nav>}
        <Input className="app-skills-search" allowClear prefix={<SearchOutlined />} placeholder={t("settings.skillMarket.searchPlaceholder")}
          maxLength={200} value={market.query} onChange={(event) => market.setQuery(event.target.value)} />
      </div>
      {isSearch && <p className="app-skills-secondary text-xs mb-4">{t("settings.skillMarket.remoteSearchHint")}</p>}
      {!view.overview && <div className="app-skill-market-pagination-sticky">{pagination}</div>}
      {listLoading && market.loadingSlow && <div className="app-skill-market-loading-status" role="status" aria-live="polite">
        <div className="app-skill-market-loading-slow">
          <span>{t("settings.skillMarket.loadingSlow")}</span>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void market.search(true)}>{t("settings.skillMarket.retry")}</Button>
        </div>
      </div>}
      {market.error && <Alert type="error" showIcon className="mb-3" message={t("settings.skillMarket.loadFailed")}
        description={market.error === "marketplace_request_timeout" ? t("settings.skillMarket.requestTimedOut") : market.error}
        action={<Button onClick={() => void market.search(true)}>{t("settings.skillMarket.retry")}</Button>} />}
      {market.loadMoreError && <Alert type="error" showIcon className="mb-3" message={t("settings.skillMarket.loadMoreFailed")} description={market.loadMoreError}
        action={<Button loading={market.loadingMore} onClick={() => void market.nextPage()}>{t("settings.skillMarket.retry")}</Button>} />}
      <div className="app-skill-market-results" aria-busy={listLoading || market.loadingMore}>
        {initialLoading ? <SkillMarketplaceSkeleton grouped={view.overview} /> : market.results && !view.total ?
          <div className="py-12"><Empty description={t("settings.skillMarket.empty")} /></div> :
          market.results && <div>
            {view.sections.map((group) => <section className="app-skill-market-section" key={group.category}>
              <div className="flex items-center justify-between gap-3">
                <h3 className="app-skill-market-section-title">{isSearch ? t("settings.skillMarket.searchResults") : group.category === "all" ? t("settings.skillMarket.leaderboard")
                  : view.overview ? t(`settings.skillMarket.categories.${group.category}`) : t("settings.skillMarket.popularCategory", { category: t(`settings.skillMarket.categories.${group.category}`) })}</h3>
                {view.overview && <Button type="link" onClick={() => market.setCategory(group.category)}>{t("settings.skillMarket.viewCategory")}</Button>}
              </div>
              <div className="app-skill-market-grid">{group.skills.map((skill) => <article key={marketplaceSkillKey(skill)} className="app-skill-market-card">
                <Avatar className="app-skill-market-avatar" shape="square" size={48}
                  src={marketplaceIsGitHubSource(skill) ? `https://github.com/${encodeURIComponent(skill.repository.split("/")[0])}.png?size=96` : undefined} icon={marketplaceIsGitHubSource(skill) ? <GithubOutlined /> : <GlobalOutlined />} />
                <button type="button" className="app-skill-market-card-main" aria-label={t("settings.skillMarket.previewSkill", { name: skill.name })}
                  onClick={() => previewSkill(skill)}>
                  <span className="app-skill-market-card-title" title={skill.name}>{skill.name}</span>
                  {!skill.description && summaryLoadingKeys.has(marketplaceSkillKey(skill)) ? <span className="app-skill-market-description-placeholder" aria-label={t("settings.skillMarket.loadingDescription")}>
                    <span className="app-skill-market-skeleton-block app-skill-market-skeleton-line" />
                    <span className="app-skill-market-skeleton-block app-skill-market-skeleton-line-short" />
                  </span> : <span className="app-skill-market-card-description">{skill.description || t("settings.skillMarket.cardHint", { repository: skill.repository })}</span>}
                  <span className="app-skill-market-card-meta" title={skill.repository}>{skill.repository}
                    {skill.installs !== null && <> · {t("settings.skillMarket.installCount", { value: formatInstalls(skill.installs) })}</>}</span>
                </button>
                <Button size="small" className="app-skill-market-card-action" icon={<EyeOutlined />} onClick={() => previewSkill(skill)}>{t("settings.skillMarket.preview")}</Button>
              </article>)}</div>
            </section>)}
          </div>}
      </div>
      {!view.overview && pagination}
      {isSearch && market.results?.limited && <p className="app-skills-muted text-xs mt-3">{t("settings.skillMarket.limited")}</p>}
    </div>}
    </div>
  </div>;
}
