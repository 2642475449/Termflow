import { create } from "zustand";
import { getMarketplaceSkillDetail, getMarketplaceSkillSummaries, searchSkillMarketplace } from "@/lib/api";
import { marketplaceSkillKey, type MarketplaceCategory } from "@/lib/skillMarketplace";
import type { MarketplaceSkill, MarketplaceSkillDetail, SkillAgent, SkillMarketSearch, SkillScope } from "@/types";

interface SkillMarketplaceState {
  query: string;
  category: MarketplaceCategory;
  page: number;
  browseResults: SkillMarketSearch | null;
  results: SkillMarketSearch | null;
  loading: boolean;
  error: string | null;
  selected: MarketplaceSkill | null;
  detail: MarketplaceSkillDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  installing: boolean;
  installError: string | null;
  agents: SkillAgent[];
  scope: SkillScope;
  searchId: number;
  detailId: number;
  setQuery: (query: string) => void;
  setCategory: (category: MarketplaceCategory) => void;
  setPage: (page: number) => void;
  setAgents: (agents: SkillAgent[]) => void;
  setScope: (scope: SkillScope) => void;
  setInstalling: (installing: boolean, error?: string | null) => void;
  search: (refresh?: boolean) => Promise<void>;
  loadSummaries: (skills: MarketplaceSkill[]) => Promise<void>;
  selectSkill: (skill: MarketplaceSkill | null, refresh?: boolean) => Promise<void>;
}

// 在线结果与临时安装选择不持久化；异步响应必须匹配发起请求时的序号。
export const useSkillMarketplaceStore = create<SkillMarketplaceState>((set, get) => ({
  query: "", results: null, loading: false, error: null,
  category: "all", page: 1, browseResults: null,
  selected: null, detail: null, detailLoading: false, detailError: null,
  installing: false, installError: null, agents: ["codex"], scope: "user", searchId: 0, detailId: 0,
  setQuery: (query) => set((state) => ({ query, page: 1, results: [...query.trim()].length < 2 ? state.browseResults : null, loading: false, error: null, searchId: state.searchId + 1 })),
  setCategory: (category) => set({ category, page: 1 }),
  setPage: (page) => set({ page }),
  setAgents: (agents) => set({ agents, installError: null }),
  setScope: (scope) => set({ scope, installError: null }),
  setInstalling: (installing, installError = null) => set({ installing, installError }),
  search: async (refresh = false) => {
    const input = get().query.trim();
    const query = [...input].length < 2 ? "" : input;
    const searchId = get().searchId + 1;
    if (!query && get().browseResults && !refresh) {
      set({ searchId, results: get().browseResults, loading: false, error: null });
      return;
    }
    set({ searchId, loading: true, error: null });
    try {
      const results = await searchSkillMarketplace(query);
      if (get().searchId === searchId) set({ results, ...(!query ? { browseResults: results } : {}), loading: false });
    } catch (reason) {
      if (get().searchId === searchId) set({ error: String(reason), loading: false });
    }
  },
  loadSummaries: async (skills) => {
    const pending = skills.filter((skill) => !skill.description);
    if (!pending.length) return;
    try {
      const summaries = await getMarketplaceSkillSummaries(pending);
      const descriptions = new Map(summaries.map((summary) => [marketplaceSkillKey({ ...summary, name: "", installs: null }), summary.description]));
      const merge = (results: SkillMarketSearch | null) => results ? { ...results, skills: results.skills.map((skill) => {
        const description = descriptions.get(marketplaceSkillKey(skill));
        return description ? { ...skill, description } : skill;
      }) } : null;
      set((state) => ({ results: merge(state.results), browseResults: merge(state.browseResults) }));
    } catch (reason) { console.error("Failed to load optional skill descriptions", reason); }
  },
  selectSkill: async (selected, refresh = false) => {
    if (get().installing) return;
    const detailId = get().detailId + 1;
    set({ detailId, selected, detail: null, detailLoading: !!selected, detailError: null, installError: null });
    if (!selected) return;
    try {
      const detail = await getMarketplaceSkillDetail(selected, refresh);
      if (get().detailId === detailId) set({ detail, detailLoading: false });
    } catch (reason) {
      if (get().detailId === detailId) set({ detailError: String(reason), detailLoading: false });
    }
  },
}));
