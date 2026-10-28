import { afterEach, expect, it, vi } from "vitest";
import { getMarketplaceSkillDetail, getMarketplaceSkillSummaries, searchSkillMarketplace } from "@/lib/api";
import type { MarketplaceSkill, MarketplaceSkillDetail, SkillMarketSearch } from "@/types";
import { useSkillMarketplaceStore } from "./skillMarketplaceSlice";

vi.mock("@/lib/api", () => ({ getMarketplaceSkillDetail: vi.fn(), getMarketplaceSkillSummaries: vi.fn(), searchSkillMarketplace: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  useSkillMarketplaceStore.setState(useSkillMarketplaceStore.getInitialState(), true);
  vi.resetAllMocks();
});

it("keeps existing cards visible throughout a refresh", async () => {
  const first = results("cached");
  useSkillMarketplaceStore.setState({ results: first, browseResults: first });
  const next = deferred<SkillMarketSearch>();
  vi.mocked(searchSkillMarketplace).mockReturnValueOnce(next.promise);
  const pending = useSkillMarketplaceStore.getState().search(true);
  expect(useSkillMarketplaceStore.getState()).toMatchObject({ loading: true, results: first });
  next.resolve(results("fresh"));
  await pending;
  expect(useSkillMarketplaceStore.getState()).toMatchObject({ loading: false, results: results("fresh") });
});

it("shows slow loading feedback and lets a retry replace the pending request", async () => {
  vi.useFakeTimers();
  const old = deferred<SkillMarketSearch>();
  vi.mocked(searchSkillMarketplace).mockReturnValueOnce(old.promise).mockResolvedValueOnce(results("fresh"));
  const store = useSkillMarketplaceStore.getState();
  const pending = store.search();
  await store.search();
  expect(searchSkillMarketplace).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(8000);
  expect(useSkillMarketplaceStore.getState()).toMatchObject({ loading: true, loadingSlow: true });
  await store.search(true);
  expect(useSkillMarketplaceStore.getState()).toMatchObject({ loading: false, loadingSlow: false, results: results("fresh") });
  old.resolve(results("old"));
  await pending;
  expect(useSkillMarketplaceStore.getState().results).toEqual(results("fresh"));
  expect(vi.getTimerCount()).toBe(0);
});

it("ends an unresponsive refresh with a retryable timeout while preserving cards", async () => {
  vi.useFakeTimers();
  const first = results("cached");
  useSkillMarketplaceStore.setState({ results: first, browseResults: first });
  const late = deferred<SkillMarketSearch>();
  vi.mocked(searchSkillMarketplace).mockReturnValueOnce(late.promise).mockResolvedValueOnce(results("fresh"));
  const store = useSkillMarketplaceStore.getState();
  const pending = store.search(true);
  await vi.advanceTimersByTimeAsync(35000);
  await pending;
  expect(useSkillMarketplaceStore.getState()).toMatchObject({ loading: false, loadingSlow: false, results: first, error: "marketplace_request_timeout" });
  late.resolve(results("late"));
  await Promise.resolve();
  expect(useSkillMarketplaceStore.getState().results).toEqual(first);
  await store.search(true);
  expect(useSkillMarketplaceStore.getState()).toMatchObject({ error: null, results: results("fresh") });
  expect(vi.getTimerCount()).toBe(0);
});

it("does not carry slow loading feedback into a different query", async () => {
  vi.useFakeTimers();
  const old = deferred<SkillMarketSearch>();
  vi.mocked(searchSkillMarketplace).mockReturnValueOnce(old.promise);
  const store = useSkillMarketplaceStore.getState();
  const pending = store.search();
  store.setQuery("different");
  await vi.advanceTimersByTimeAsync(8000);
  expect(useSkillMarketplaceStore.getState()).toMatchObject({ loading: false, loadingSlow: false });
  old.resolve(results("old"));
  await pending;
  expect(useSkillMarketplaceStore.getState().results).toBeNull();
});

it("tracks description placeholders without sending duplicate summary requests", async () => {
  const initial = results("review");
  useSkillMarketplaceStore.setState({ results: initial });
  const response = deferred<{ repository: string; slug: string; description: string }[]>();
  vi.mocked(getMarketplaceSkillSummaries).mockReturnValueOnce(response.promise);
  const store = useSkillMarketplaceStore.getState();
  const pending = store.loadSummaries(initial.skills);
  expect(useSkillMarketplaceStore.getState().summaryLoadingKeys).toEqual(["owner/skills:review"]);
  await store.loadSummaries(initial.skills);
  expect(getMarketplaceSkillSummaries).toHaveBeenCalledOnce();
  response.resolve([{ repository: "owner/skills", slug: "review", description: "Review changes" }]);
  await pending;
  expect(useSkillMarketplaceStore.getState().summaryLoadingKeys).toEqual([]);
  expect(useSkillMarketplaceStore.getState().results?.skills[0].description).toBe("Review changes");
});

it("clears description placeholders if optional summary loading fails", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    vi.mocked(getMarketplaceSkillSummaries).mockRejectedValueOnce("offline");
    await useSkillMarketplaceStore.getState().loadSummaries([skill("review")]);
    expect(useSkillMarketplaceStore.getState()).toMatchObject({ summaryLoadingKeys: [], loading: false, error: null });
  } finally { log.mockRestore(); }
});

it("shows completed descriptions while a later batch is still loading", async () => {
  const skills = Array.from({ length: 30 }, (_, index) => skill(`review-${index}`));
  useSkillMarketplaceStore.setState({ results: { skills, limited: false, nextPage: null } });
  const last = deferred<{ repository: string; slug: string; description: string }[]>();
  vi.mocked(getMarketplaceSkillSummaries).mockResolvedValueOnce(skills.slice(0, 24).map((entry) => ({ ...entry, description: "Ready" }))).mockReturnValueOnce(last.promise);
  const pending = useSkillMarketplaceStore.getState().loadSummaries(skills);
  await Promise.resolve();
  expect(useSkillMarketplaceStore.getState().results?.skills[0].description).toBe("Ready");
  expect(useSkillMarketplaceStore.getState().summaryLoadingKeys).toHaveLength(6);
  last.resolve([]);
  await pending;
  expect(useSkillMarketplaceStore.getState().summaryLoadingKeys).toEqual([]);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const skill = (slug: string): MarketplaceSkill => ({ repository: "owner/skills", slug, name: slug, description: "", installs: 12 });
const results = (slug: string): SkillMarketSearch => ({ skills: [skill(slug)], limited: false, nextPage: null });
const detail = (slug: string): MarketplaceSkillDetail => ({ skill: skill(slug), content: "instructions", fileCount: 1, files: ["SKILL.md"], totalBytes: 12, sourceUrl: "https://github.com/owner/skills" });

it("ignores old search results after the query changes", async () => {
  const old = deferred<SkillMarketSearch>();
  vi.mocked(searchSkillMarketplace).mockReturnValueOnce(old.promise).mockResolvedValueOnce(results("new"));
  const store = useSkillMarketplaceStore.getState();
  store.setQuery("old");
  const pending = store.search();
  store.setQuery("new");
  await store.search();
  old.resolve(results("old"));
  await pending;
  expect(useSkillMarketplaceStore.getState().results?.skills[0].slug).toBe("new");
});

it("ignores details for a selection replaced by another skill", async () => {
  const old = deferred<MarketplaceSkillDetail>();
  vi.mocked(getMarketplaceSkillDetail).mockReturnValueOnce(old.promise).mockResolvedValueOnce(detail("new"));
  const store = useSkillMarketplaceStore.getState();
  const pending = store.selectSkill(skill("old"));
  await store.selectSkill(skill("new"));
  old.resolve(detail("old"));
  await pending;
  expect(useSkillMarketplaceStore.getState().detail?.skill.slug).toBe("new");
});

it("invalidates pending details when returning to the list", async () => {
  const pendingDetail = deferred<MarketplaceSkillDetail>();
  vi.mocked(getMarketplaceSkillDetail).mockReturnValueOnce(pendingDetail.promise);
  const store = useSkillMarketplaceStore.getState();
  const pending = store.selectSkill(skill("review"));
  await store.selectSkill(null);
  pendingDetail.resolve(detail("review"));
  await pending;
  expect(useSkillMarketplaceStore.getState()).toMatchObject({ selected: null, detail: null, detailLoading: false });

});

it("surfaces request failures and allows retrying with the same query", async () => {
  vi.mocked(searchSkillMarketplace).mockRejectedValueOnce("offline").mockResolvedValueOnce(results("react"));
  const store = useSkillMarketplaceStore.getState();
  store.setQuery("react");
  await store.search();
  expect(useSkillMarketplaceStore.getState()).toMatchObject({ error: "offline", loading: false });
  await store.search();
  expect(searchSkillMarketplace).toHaveBeenLastCalledWith("react");
  expect(useSkillMarketplaceStore.getState()).toMatchObject({ error: null, loading: false });
});

it("loads popular skills by default and reuses them when the search is cleared", async () => {
  vi.mocked(searchSkillMarketplace).mockResolvedValueOnce(results("popular"));
  const store = useSkillMarketplaceStore.getState();
  await store.search();
  for (const query of ["", " ", "a", " 🦀 "]) {
    store.setQuery(query);
    await store.search();
  }
  expect(searchSkillMarketplace).toHaveBeenCalledOnce();
  expect(searchSkillMarketplace).toHaveBeenCalledWith("");
  expect(useSkillMarketplaceStore.getState()).toMatchObject({ results: results("popular"), loading: false, error: null });
});

it("fills visible card descriptions without losing the cached browse list", async () => {
  const initial = results("review");
  useSkillMarketplaceStore.setState({ results: initial, browseResults: initial, page: 3 });
  vi.mocked(getMarketplaceSkillSummaries).mockResolvedValueOnce([{ repository: "owner/skills", slug: "review", description: "Review code changes" }]);
  const store = useSkillMarketplaceStore.getState();
  await store.loadSummaries(initial.skills);
  expect(useSkillMarketplaceStore.getState().results?.skills[0].description).toBe("Review code changes");
  expect(useSkillMarketplaceStore.getState().browseResults?.skills[0].description).toBe("Review code changes");
  store.setCategory("development");
  expect(useSkillMarketplaceStore.getState()).toMatchObject({ page: 1, category: "development" });
});

it("forces a repository refresh when retrying an unavailable skill", async () => {
  vi.mocked(getMarketplaceSkillDetail).mockRejectedValueOnce("marketplace_skill_not_found").mockResolvedValueOnce(detail("review"));
  const store = useSkillMarketplaceStore.getState();
  const selected = skill("review");
  await store.selectSkill(selected);
  expect(useSkillMarketplaceStore.getState()).toMatchObject({ detailError: "marketplace_skill_not_found", detailLoading: false });
  await store.selectSkill(selected, true);
  expect(getMarketplaceSkillDetail).toHaveBeenLastCalledWith(selected, true);
  expect(useSkillMarketplaceStore.getState()).toMatchObject({ detailError: null, detailLoading: false });
});

it("batches descriptions for a full category overview within the backend limit", async () => {
  const skills = Array.from({ length: 30 }, (_, i) => skill(`review-${i}`));
  useSkillMarketplaceStore.setState({ results: { skills, limited: false, nextPage: null } });
  vi.mocked(getMarketplaceSkillSummaries).mockImplementation(async (entries) => entries.map((entry) => ({ ...entry, description: `About ${entry.slug}` })));
  await useSkillMarketplaceStore.getState().loadSummaries(skills);
  expect(vi.mocked(getMarketplaceSkillSummaries).mock.calls.map(([entries]) => entries.length)).toEqual([24, 6]);
  expect(useSkillMarketplaceStore.getState().results?.skills.every((entry) => entry.description === `About ${entry.slug}`)).toBe(true);
});

it("appends subsequent batches once and preserves existing descriptions and browse cache", async () => {
  const first = { ...results("react"), limited: true, nextPage: 1 };
  first.skills[0].description = "Existing description";
  useSkillMarketplaceStore.setState({ results: first, browseResults: first });
  const next = deferred<SkillMarketSearch>();
  vi.mocked(searchSkillMarketplace).mockReturnValueOnce(next.promise);
  const store = useSkillMarketplaceStore.getState();
  const pending = store.loadMore();
  await store.loadMore();
  expect(searchSkillMarketplace).toHaveBeenCalledOnce();
  expect(searchSkillMarketplace).toHaveBeenCalledWith("", 1);
  next.resolve({ skills: [skill("react"), skill("python")], limited: true, nextPage: 2 });
  await pending;
  const loaded = useSkillMarketplaceStore.getState();
  expect(loaded.results?.skills.map((entry) => entry.slug)).toEqual(["react", "python"]);
  expect(loaded.results?.skills[0].description).toBe("Existing description");
  expect(loaded.browseResults).toEqual(loaded.results);
  expect(loaded.results?.nextPage).toBe(2);
});

it("keeps loaded cards after a failed batch and retries the same cursor", async () => {
  const first = { ...results("react"), limited: true, nextPage: 1 };
  useSkillMarketplaceStore.setState({ results: first, browseResults: first });
  vi.mocked(searchSkillMarketplace).mockRejectedValueOnce("offline").mockResolvedValueOnce(results("python"));
  const store = useSkillMarketplaceStore.getState();
  await store.loadMore();
  expect(useSkillMarketplaceStore.getState()).toMatchObject({ results: first, loadingMore: false, loadMoreError: "offline" });
  await store.loadMore();
  expect(vi.mocked(searchSkillMarketplace).mock.calls).toEqual([["", 1], ["", 1]]);
  expect(useSkillMarketplaceStore.getState()).toMatchObject({ loadMoreError: null, results: { nextPage: null } });
  await store.loadMore();
  expect(searchSkillMarketplace).toHaveBeenCalledTimes(2);
});

it("ignores an old batch after switching to search and restores the browse cursor on clear", async () => {
  const first = { ...results("react"), limited: true, nextPage: 1 };
  useSkillMarketplaceStore.setState({ results: first, browseResults: first });
  const next = deferred<SkillMarketSearch>();
  vi.mocked(searchSkillMarketplace).mockReturnValueOnce(next.promise).mockResolvedValueOnce(results("query"));
  const store = useSkillMarketplaceStore.getState();
  const pending = store.loadMore();
  store.setQuery("query");
  await store.search();
  next.resolve(results("old-batch"));
  await pending;
  expect(useSkillMarketplaceStore.getState().results?.skills[0].slug).toBe("query");
  await store.loadMore();
  expect(searchSkillMarketplace).toHaveBeenCalledTimes(2);
  store.setQuery("");
  await store.search();
  expect(useSkillMarketplaceStore.getState().results).toEqual(first);
});

it("loads domain source previews through the same read-only detail API", async () => {
  const selected = { ...skill("lark-doc"), repository: "open.feishu.cn" };
  vi.mocked(getMarketplaceSkillDetail).mockResolvedValueOnce({ ...detail("lark-doc"), skill: selected });
  await useSkillMarketplaceStore.getState().selectSkill(selected);
  expect(getMarketplaceSkillDetail).toHaveBeenCalledWith(selected, false);
  expect(useSkillMarketplaceStore.getState()).toMatchObject({ selected, detailLoading: false, detailError: null });
});
