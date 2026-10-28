import { useCallback, useEffect } from "react";
import { ArrowLeftOutlined, DownloadOutlined, LinkOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { Alert, Button, Empty, Input, Segmented, Select, Spin, message } from "antd";
import { useTranslation } from "react-i18next";
import { AgentIcon } from "@/components/AgentIcon";
import { getAgentIdsWithCapability } from "@/lib/agents";
import { installMarketplaceSkill, openExternalUrl } from "@/lib/api";
import { marketplaceConflicts, marketplaceDetailErrorKind, marketplaceRepositoryUrl, marketplaceSkillKey, marketplaceSkillUrl } from "@/lib/skillMarketplace";
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
  const { t } = useTranslation();
  const projectPath = useAppStore((state) => state.currentProject?.path ?? null);
  const market = useSkillMarketplaceStore();
  const catalog = useSkillsStore((state) => state.catalog);
  const catalogError = useSkillsStore((state) => state.error);
  const canSearch = [...market.query.trim()].length >= 2;
  const detail = market.detail;
  const detailErrorKind = marketplaceDetailErrorKind(market.detailError);
  const targets = skillInstallTargets(catalog, market.agents, market.scope);
  const conflicts = detail ? marketplaceConflicts(catalog, detail.folderName, market.agents, market.scope) : [];
  const consumers = [...new Set(targets.flatMap((target) => target.consumers))];

  useEffect(() => {
    if (!isActive) return;
    const timer = window.setTimeout(() => { void useSkillMarketplaceStore.getState().search(); }, 400);
    return () => window.clearTimeout(timer);
  }, [isActive, market.query]);

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

  return <div className="app-skill-market-page app-skills-library h-full overflow-auto">
    <div className="app-skill-market-page-inner">
      <div className="app-skills-toolbar"><h2 className="app-skills-title">{t("settings.skillMarket.title")}</h2></div>
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
      <p className="app-skills-secondary text-sm mb-4">{t("settings.skillMarket.description")}</p>
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <Input className="app-skills-search" allowClear prefix={<SearchOutlined />} placeholder={t("settings.skillMarket.searchPlaceholder")}
          maxLength={200} value={market.query} onChange={(event) => market.setQuery(event.target.value)} />
        <Button icon={<ReloadOutlined spin={market.loading} />} disabled={market.loading || !canSearch} onClick={() => void market.search()}>{t("common.refresh")}</Button>
      </div>
      {market.error && <Alert type="error" showIcon className="mb-3" message={t("settings.skillMarket.loadFailed")} description={market.error}
        action={<Button onClick={() => void market.search()}>{t("common.refresh")}</Button>} />}
      <div className="app-skill-market-results" aria-busy={market.loading}>
        {!canSearch ? <div className="py-12"><Empty description={t("settings.skillMarket.searchHint")} /></div> :
          market.loading ? <div className="flex justify-center py-20"><Spin /></div> : market.results && !market.results.skills.length ?
          <div className="py-12"><Empty description={t("settings.skillMarket.empty")} /></div> :
          <div className="app-skills-list">
            {(market.results?.skills ?? []).map((skill) => <button key={marketplaceSkillKey(skill)} type="button" className="app-skills-row"
              onClick={() => void market.selectSkill(skill)}>
              <div className="app-skills-row-body">
                <div className="font-medium text-sm">{skill.name}</div>
                <p className="app-skills-secondary text-xs mt-2 line-clamp-2">{skill.description || t("settings.skillMarket.previewHint")}</p>
                <p className="app-skills-muted text-xs mt-2">{skill.repository}</p>
              </div>
              {skill.installs !== null && <span className="app-skills-secondary text-xs shrink-0">{t("settings.skillMarket.installs", { count: skill.installs })}</span>}
            </button>)}
          </div>}
      </div>
      {market.results?.limited && <p className="app-skills-muted text-xs mt-3">{t("settings.skillMarket.limited")}</p>}
    </div>}
    </div>
  </div>;
}
