import { create } from "zustand";
import { getMarketplaceSkillDetail, searchSkillMarketplace } from "@/lib/api";
import type { MarketplaceSkill, MarketplaceSkillDetail, SkillAgent, SkillMarketProvider, SkillMarketSearch, SkillScope } from "@/types";

interface SkillMarketplaceState {
  open: boolean;
  query: string;
  provider: SkillMarketProvider | null;
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
  setOpen: (open: boolean) => void;
  setQuery: (query: string) => void;
  setProvider: (provider: SkillMarketProvider | null) => void;
  setAgents: (agents: SkillAgent[]) => void;
  setScope: (scope: SkillScope) => void;
  setInstalling: (installing: boolean, error?: string | null) => void;
  search: (refresh?: boolean) => Promise<void>;
  selectSkill: (skill: MarketplaceSkill | null) => Promise<void>;
}

// 在线结果与临时安装选择不持久化；异步响应必须匹配发起请求时的序号。
export const useSkillMarketplaceStore = create<SkillMarketplaceState>((set, get) => ({
  open: false, query: "", provider: null, results: null, loading: false, error: null,
  selected: null, detail: null, detailLoading: false, detailError: null,
  installing: false, installError: null, agents: ["codex"], scope: "user", searchId: 0, detailId: 0,
  setOpen: (open) => set((state) => state.installing ? state : {
    open, selected: null, detail: null, detailError: null, installError: null, loading: false, detailLoading: false,
    searchId: state.searchId + 1, detailId: state.detailId + 1,
  }),
  setQuery: (query) => set((state) => ({ query, results: null, error: null, searchId: state.searchId + 1 })),
  setProvider: (provider) => set((state) => ({ provider, results: null, error: null, searchId: state.searchId + 1 })),
  setAgents: (agents) => set({ agents, installError: null }),
  setScope: (scope) => set({ scope, installError: null }),
  setInstalling: (installing, installError = null) => set({ installing, installError }),
  search: async (refresh = false) => {
    const { query, provider } = get();
    const searchId = get().searchId + 1;
    set({ searchId, loading: true, error: null });
    try {
      const results = await searchSkillMarketplace(query.trim(), provider, refresh);
      if (get().searchId === searchId) set({ results, loading: false });
    } catch (reason) {
      if (get().searchId === searchId) set({ error: String(reason), loading: false });
    }
  },
  selectSkill: async (selected) => {
    if (get().installing) return;
    const detailId = get().detailId + 1;
    set({ detailId, selected, detail: null, detailLoading: !!selected, detailError: null, installError: null });
    if (!selected) return;
    try {
      const detail = await getMarketplaceSkillDetail(selected);
      if (get().detailId === detailId) set({ detail, detailLoading: false });
    } catch (reason) {
      if (get().detailId === detailId) set({ detailError: String(reason), detailLoading: false });
    }
  },
}));
