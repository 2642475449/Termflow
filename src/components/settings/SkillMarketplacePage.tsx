import { useCallback, useEffect, useRef } from "react";
import { ArrowLeftOutlined, DownloadOutlined, GithubOutlined, LinkOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Alert, Avatar, Button, Empty, Input, Pagination, Segmented, Select, Spin, message } from "antd";
import { useTranslation } from "react-i18next";
import { AgentIcon } from "@/components/AgentIcon";
import { getAgentIdsWithCapability } from "@/lib/agents";
import { installMarketplaceSkill, openExternalUrl } from "@/lib/api";
import { MARKETPLACE_CATEGORIES, marketplaceBrowseView, marketplaceConflicts, marketplaceDetailErrorKind, marketplaceRepositoryUrl, marketplaceSkillKey, marketplaceSkillUrl } from "@/lib/skillMarketplace";
import { skillInstallTargets } from "@/lib/skills";
import { useSkillMarketplaceStore } from "@/store/slices/skillMarketplaceSlice";
import { useSkillsStore } from "@/store/slices/skillsSlice";
import { useAppStore } from "@/store";
import type { SkillScope } from "@/types";

const SKILL_AGENTS = getAgentIdsWithCapability("skills");

interface Props {
  isActive: boolean;
}

export default function SkillMarketplacePage({ isActive }: Props) {
  const { t, i18n } = useTranslation();
  const projectPath = useAppStore((state) => state.currentProject?.path ?? null);
  const market = useSkillMarketplaceStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const catalog = useSkillsStore((state) => state.catalog);
  const catalogError = useSkillsStore((state) => state.error);
  const isSearch = [...market.query.trim()].length >= 2;
  const detail = market.detail;
  const detailErrorKind = marketplaceDetailErrorKind(market.detailError);
  const targets = skillInstallTargets(catalog, market.agents, market.scope);
  const conflicts = detail ? marketplaceConflicts(catalog, detail.folderName, market.agents, market.scope) : [];
  const consumers = [...new Set(targets.flatMap((target) => target.consumers))];
  const view = marketplaceBrowseView(market.results?.skills ?? [], market.category, market.page);
  const visible = view.sections.flatMap((section) => section.skills);
  const visibleKey = visible.map(marketplaceSkillKey).join("\n");
  const formatInstalls = (count: number) => new Intl.NumberFormat(i18n.language, { notation: "compact", maximumFractionDigits: 1 }).format(count);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [market.category, market.page]);

  useEffect(() => {
    if (!isActive) return;
    const timer = window.setTimeout(() => { void useSkillMarketplaceStore.getState().search(); }, 400);
    return () => window.clearTimeout(timer);
  }, [isActive, market.query]);

  useEffect(() => {
    if (isActive && !market.selected && visible.length) void useSkillMarketplaceStore.getState().loadSummaries(visible);
  }, [isActive, market.selected, visibleKey]);

  const refreshCatalog = useCallback(async () => {
    await useSkillsStore.getState().refreshCatalog(projectPath);
  }, [projectPath]);

  useEffect(() => {
    const state = useSkillMarketplaceStore.getState();
    void state.selectSkill(null);
    if (!projectPath) state.setScope("user");
    if (useSkillsStore.getState().projectPath !== projectPath) useSkillsStore.getState().setProject(projectPath);
    void refreshCatalog().catch((reason) => console.error("Failed to load installation targets", reason));
  }, [projectPath, refreshCatalog]);

  async function openSource(url: string) {
    try { await openExternalUrl(url); }
    catch (reason) { message.error(t("settings.skills.operationFailed", { reason: String(reason) })); }
  }

  async function install() {
    if (!detail || market.installing || !market.agents.length || !targets.length || conflicts.length) return;
    market.setInstalling(true);
    try {
      await installMarketplaceSkill({ skill: detail.skill, revision: detail.revision, directory: detail.directory,
        agents: market.agents, scope: market.scope, projectPath });
    } catch (reason) { market.setInstalling(false, String(reason)); return; }
    market.setInstalling(false);
    message.success(t("settings.skills.installSuccess"));
    try { await refreshCatalog(); }
    catch { message.error(t("settings.skills.loadFailed")); }
  }

  return <div ref={scrollRef} className="app-skill-market-page app-skills-library h-full overflow-auto">
    <div className="app-skill-market-page-inner">
      <div className="app-skills-toolbar">
        <div><h2 className="app-skills-title">{t("settings.skillMarket.title")}</h2>
          <p className="app-skills-secondary text-xs mt-1">{t("settings.skillMarket.description")}</p></div>
        {!market.selected && <Button icon={<ReloadOutlined spin={market.loading} />} disabled={market.loading} onClick={() => void market.search(true)}>{t("common.refresh")}</Button>}
      </div>
      {catalogError && <Alert type="error" showIcon className="mb-3" message={t("settings.skills.loadFailed")}
        action={<Button onClick={() => void refreshCatalog().catch(() => message.error(t("settings.skills.loadFailed")))}>{t("common.refresh")}</Button>} />}
    {market.selected ? <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <Button type="text" icon={<ArrowLeftOutlined />} disabled={market.installing} onClick={() => void market.selectSkill(null)}>{t("settings.skillMarket.back")}</Button>
      </div>
      <h3 className="font-semibold text-lg">{detail?.skill.name ?? market.selected.name}</h3>
      <p className="app-skills-secondary text-xs mt-1 mb-4">{market.selected.repository}</p>
      {market.detailLoading ? <div className="flex justify-center py-20"><Spin /></div> : market.detailError ? <div>
        <Alert type={detailErrorKind === "unavailable" ? "warning" : "error"} showIcon
          message={t(`settings.skillMarket.${detailErrorKind === "request" ? "detailFailed" : detailErrorKind}`)}
          description={detailErrorKind === "request" ? market.detailError : t(`settings.skillMarket.${detailErrorKind}Hint`)}
          action={<Button onClick={() => market.selected && void market.selectSkill(market.selected, true)}>{t("common.refresh")}</Button>} />
        <div className="flex flex-wrap gap-2 mt-3">
          <Button icon={<LinkOutlined />} onClick={() => market.selected && void openSource(marketplaceSkillUrl(market.selected))}>{t("settings.skillMarket.viewListing")}</Button>
          <Button icon={<LinkOutlined />} onClick={() => market.selected && void openSource(marketplaceRepositoryUrl(market.selected))}>{t("settings.skillMarket.viewRepository")}</Button>
        </div>
      </div> : detail &&
        <div className="app-skill-market-detail">
          <section className="min-w-0">
            <p className="app-skills-secondary text-sm mb-3">{detail.skill.description}</p>
            <pre className="app-skills-content app-skill-market-content">{detail.content}</pre>
          </section>
          <aside className="app-skill-market-install">
            <Button type="link" className="!px-0" icon={<LinkOutlined />} onClick={() => void openSource(detail.sourceUrl)}>{t("settings.skillMarket.viewSource")}</Button>
            <p className="app-skills-muted text-xs mb-4">{t("settings.skillMarket.files", { count: detail.fileCount, size: Math.ceil(detail.totalBytes / 1024) })}</p>
            <details className="mb-4">
              <summary className="app-skills-secondary text-xs cursor-pointer">{t("settings.skillMarket.resourceFiles")}</summary>
              <ul className="max-h-32 overflow-y-auto mt-2">
                {detail.files.map((path) => <li className="app-skills-path" key={path}>{path}</li>)}
              </ul>
            </details>
            <div className="mb-4">
              <label className="app-skills-field-label">{t("settings.skills.skillScope")}</label>
              <Segmented block value={market.scope} disabled={market.installing} onChange={(value) => market.setScope(value as SkillScope)} options={[
                { value: "workspace", label: t("settings.scope.workspaceShort"), disabled: !projectPath },
                { value: "user", label: t("settings.scope.userShort") },
              ]} />
              {market.scope === "workspace" && <p className="app-skills-path mt-2">{projectPath}</p>}
            </div>
            <label className="app-skills-field-label">{t("settings.skills.targetAgents")}</label>
            <Select mode="multiple" className="w-full mb-4" aria-label={t("settings.skills.targetAgents")} value={market.agents}
              disabled={market.installing} onChange={market.setAgents} options={SKILL_AGENTS.map((id) => ({ value: id,
                label: <span className="inline-flex items-center gap-1"><AgentIcon agentId={id} size={14} />{t(`settings.skills.agents.${id}`)}</span> }))} />
            <div className="app-skills-entry">
              <h4 className="text-xs font-medium mb-2">{t("settings.skills.installPreview")}</h4>
              {targets.map((target) => <p className="app-skills-path mb-2" key={target.path}>{target.path}/{detail.folderName}</p>)}
              {!targets.length && <p className="app-skills-secondary text-xs">{t("settings.skills.selectTargets")}</p>}
              {!!consumers.length && <p className="app-skills-secondary text-xs">{t("settings.skills.toggleAffects", { agents: consumers.map((id) => t(`settings.skills.agents.${id}`)).join(", ") })}</p>}
            </div>
            {!!conflicts.length && <Alert type="warning" showIcon className="mb-3" message={t("settings.skillMarket.conflict")}
              description={conflicts.map((path) => <p className="app-skills-path" key={path}>{path}</p>)} />}
            {market.installError && <Alert type="error" showIcon className="mb-3" message={t("settings.skillMarket.installFailed")} description={market.installError} />}
            <Button type="primary" block icon={<DownloadOutlined />} loading={market.installing}
              disabled={!market.agents.length || !targets.length || conflicts.length > 0 || (market.scope === "workspace" && !projectPath)}
              onClick={() => void install()}>{t("settings.skillMarket.install")}</Button>
          </aside>
        </div>}
    </div> : <div>
      <div className="app-skill-market-controls">
        <nav className="app-skill-market-categories" aria-label={t("settings.skillMarket.categoryFilter")}>
          {MARKETPLACE_CATEGORIES.map((category) => <button key={category} type="button" className="app-skill-market-category"
            aria-pressed={market.category === category} onClick={() => market.setCategory(category)}>{t(`settings.skillMarket.categories.${category}`)}{market.results && <span className="ml-1">{view.counts[category]}</span>}</button>)}
        </nav>
        <Input className="app-skills-search" allowClear prefix={<SearchOutlined />} placeholder={t("settings.skillMarket.searchPlaceholder")}
          maxLength={200} value={market.query} onChange={(event) => market.setQuery(event.target.value)} />
      </div>
      {market.error && <Alert type="error" showIcon className="mb-3" message={t("settings.skillMarket.loadFailed")} description={market.error}
        action={<Button onClick={() => void market.search()}>{t("common.refresh")}</Button>} />}
      <div className="app-skill-market-results" aria-busy={market.loading}>
        {market.loading ? <div className="flex justify-center py-20"><Spin /></div> : market.results && !view.total ?
          <div className="py-12"><Empty description={t("settings.skillMarket.empty")} /></div> :
          <div>
            <div className="app-skill-market-result-heading">{t(`settings.skillMarket.${isSearch ? "searchResults" : "popular"}`)}
              <span className="app-skills-muted ml-2">{view.total}</span></div>
            {view.sections.map((group) => <section className="app-skill-market-section" key={group.category}>
              <div className="flex items-center justify-between gap-3">
                <h3 className="app-skill-market-section-title">{t(`settings.skillMarket.categories.${group.category}`)}<span className="app-skills-muted ml-2">{group.total}</span></h3>
                {view.overview && group.total > group.skills.length && <Button type="link" onClick={() => market.setCategory(group.category)}>{t("settings.skillMarket.viewCategory")}</Button>}
              </div>
              <div className="app-skill-market-grid">{group.skills.map((skill) => <article key={marketplaceSkillKey(skill)} className="app-skill-market-card">
                <Avatar className="app-skill-market-avatar" shape="square" size={48}
                  src={`https://github.com/${encodeURIComponent(skill.repository.split("/")[0])}.png?size=96`} icon={<GithubOutlined />} />
                <button type="button" className="app-skill-market-card-main" aria-label={t("settings.skillMarket.previewSkill", { name: skill.name })}
                  onClick={() => void market.selectSkill(skill)}>
                  <span className="app-skill-market-card-title" title={skill.name}>{skill.name}</span>
                  <span className="app-skill-market-card-description">{skill.description || t("settings.skillMarket.cardHint", { repository: skill.repository })}</span>
                  <span className="app-skill-market-card-meta" title={skill.repository}>{skill.repository}
                    {skill.installs !== null && <> · {t("settings.skillMarket.installCount", { value: formatInstalls(skill.installs) })}</>}</span>
                </button>
                <Button size="small" className="app-skill-market-card-action" icon={<PlusOutlined />} onClick={() => void market.selectSkill(skill)}>{t("settings.skillMarket.installShort")}</Button>
              </article>)}</div>
            </section>)}
            {!view.overview && view.total > view.pageSize && <div className="flex justify-end mt-6"><Pagination current={view.page} total={view.total} pageSize={view.pageSize}
              showSizeChanger={false} onChange={market.setPage} /></div>}
          </div>}
      </div>
      {market.results?.limited && <p className="app-skills-muted text-xs mt-3">{t(`settings.skillMarket.${isSearch ? "limited" : "browseLimited"}`)}</p>}
    </div>}
    </div>
  </div>;
}
