import { create } from "zustand";
import { getMarketplaceSkillDetail, getMarketplaceSkillSummaries, searchSkillMarketplace } from "@/lib/api";
import { marketplaceSkillKey, type MarketplaceCategory } from "@/lib/skillMarketplace";
import type { MarketplaceSkill, MarketplaceSkillDetail, SkillMarketSearch } from "@/types";

interface SkillMarketplaceState {
  query: string;
  category: MarketplaceCategory;
  page: number;
  browseResults: SkillMarketSearch | null;
  results: SkillMarketSearch | null;
  loading: boolean;
  loadingSlow: boolean;
  loadingMore: boolean;
  loadMoreError: string | null;
  error: string | null;
  selected: MarketplaceSkill | null;
  detail: MarketplaceSkillDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  summaryLoadingKeys: string[];
  searchId: number;
  detailId: number;
  setQuery: (query: string) => void;
  setCategory: (category: MarketplaceCategory) => void;
  setPage: (page: number) => void;
  search: (refresh?: boolean) => Promise<void>;
  loadMore: () => Promise<void>;
  loadSummaries: (skills: MarketplaceSkill[]) => Promise<void>;
  selectSkill: (skill: MarketplaceSkill | null, refresh?: boolean) => Promise<void>;
}

// 在线结果不持久化；异步响应必须匹配发起请求时的序号。
export const useSkillMarketplaceStore = create<SkillMarketplaceState>((set, get) => ({
  query: "", results: null, loading: false, loadingSlow: false, error: null, loadingMore: false, loadMoreError: null,
  category: "all", page: 1, browseResults: null,
  selected: null, detail: null, detailLoading: false, detailError: null,
  summaryLoadingKeys: [],
  searchId: 0, detailId: 0,
  setQuery: (query) => set((state) => ({ query, page: 1, results: [...query.trim()].length < 2 ? state.browseResults : null, loading: false, loadingSlow: false, loadingMore: false, loadMoreError: null, error: null, searchId: state.searchId + 1 })),
  setCategory: (category) => set({ category, page: 1 }),
  setPage: (page) => set({ page }),
  search: async (refresh = false) => {
    if (get().loading && !refresh) return;
    const input = get().query.trim();
    const query = [...input].length < 2 ? "" : input;
    const searchId = get().searchId + 1;
    if (!query && get().browseResults && !refresh) {
      set({ searchId, results: get().browseResults, loading: false, loadingSlow: false, loadingMore: false, loadMoreError: null, error: null });
      return;
    }
    set({ searchId, loading: true, loadingSlow: false, loadingMore: false, loadMoreError: null, error: null });
    const slowTimer = setTimeout(() => {
      if (get().searchId === searchId && get().loading) set({ loadingSlow: true });
    }, 8000);
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const results = await Promise.race([
        searchSkillMarketplace(query),
        new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => reject("marketplace_request_timeout"), 35000);
        }),
      ]);
      if (get().searchId === searchId) set({ results, ...(!query ? { browseResults: results } : {}), loading: false, loadingSlow: false });
    } catch (reason) {
      if (get().searchId === searchId) set({ error: String(reason), loading: false, loadingSlow: false });
    } finally {
      clearTimeout(slowTimer);
      clearTimeout(timeoutTimer);
    }
  },
  loadMore: async () => {
    const state = get();
    const nextPage = state.browseResults?.nextPage;
    if (state.loading || state.loadingMore || [...state.query.trim()].length >= 2 || nextPage == null) return;
    const searchId = state.searchId;
    set({ loadingMore: true, loadMoreError: null });
    try {
      const next = await searchSkillMarketplace("", nextPage);
      if (get().searchId !== searchId) return;
      const entries = new Map((get().browseResults?.skills ?? []).map((skill) => [marketplaceSkillKey(skill), skill]));
      // 榜单实时变化会导致相邻批次重复，保留已补齐简介的条目。
      for (const skill of next.skills) if (!entries.has(marketplaceSkillKey(skill))) entries.set(marketplaceSkillKey(skill), skill);
      const merged = { ...next, skills: [...entries.values()] };
      set({ browseResults: merged, results: merged, loadingMore: false });
    } catch (reason) {
      if (get().searchId === searchId) set({ loadingMore: false, loadMoreError: String(reason) });
    }
  },
  loadSummaries: async (skills) => {
    const pending = skills.filter((skill) => !skill.description && !get().summaryLoadingKeys.includes(marketplaceSkillKey(skill)));
    if (!pending.length) return;
    const keys = pending.map(marketplaceSkillKey);
    set((state) => ({ summaryLoadingKeys: [...new Set([...state.summaryLoadingKeys, ...keys])] }));
    try {
      // 每批简介完成后立即展示，不等待其余卡片。
      for (let offset = 0; offset < pending.length; offset += 24) {
        const batch = pending.slice(offset, offset + 24);
        const summaries = await getMarketplaceSkillSummaries(batch);
        const batchKeys = batch.map(marketplaceSkillKey);
        const descriptions = new Map(summaries.map((summary) => [marketplaceSkillKey(summary), summary.description]));
        const merge = (results: SkillMarketSearch | null) => results ? { ...results, skills: results.skills.map((skill) => {
          const description = descriptions.get(marketplaceSkillKey(skill));
          return description ? { ...skill, description } : skill;
        }) } : null;
        set((state) => ({ results: merge(state.results), browseResults: merge(state.browseResults),
          summaryLoadingKeys: state.summaryLoadingKeys.filter((key) => !batchKeys.includes(key)) }));
      }
    } catch (reason) { console.error("Failed to load optional skill descriptions", reason); }
    finally { set((state) => ({ summaryLoadingKeys: state.summaryLoadingKeys.filter((key) => !keys.includes(key)) })); }
  },
  selectSkill: async (selected, refresh = false) => {
    const detailId = get().detailId + 1;
    set({ detailId, selected, detail: null, detailLoading: !!selected, detailError: null });
    if (!selected) return;
    try {
      const detail = await getMarketplaceSkillDetail(selected, refresh);
      if (get().detailId === detailId) set({ detail, detailLoading: false });
    } catch (reason) {
      if (get().detailId === detailId) set({ detailError: String(reason), detailLoading: false });
    }
  },
}));
