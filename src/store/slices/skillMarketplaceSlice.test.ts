import { afterEach, expect, it, vi } from "vitest";
import { getMarketplaceSkillDetail, getMarketplaceSkillSummaries, searchSkillMarketplace } from "@/lib/api";
import type { MarketplaceSkill, MarketplaceSkillDetail, SkillMarketSearch } from "@/types";
import { useSkillMarketplaceStore } from "./skillMarketplaceSlice";

vi.mock("@/lib/api", () => ({ getMarketplaceSkillDetail: vi.fn(), getMarketplaceSkillSummaries: vi.fn(), searchSkillMarketplace: vi.fn() }));

afterEach(() => {
  useSkillMarketplaceStore.setState(useSkillMarketplaceStore.getInitialState(), true);
  vi.resetAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const skill = (slug: string): MarketplaceSkill => ({ repository: "owner/skills", slug, name: slug, description: "", installs: 12 });
const results = (slug: string): SkillMarketSearch => ({ skills: [skill(slug)], limited: false });
const detail = (slug: string): MarketplaceSkillDetail => ({ skill: skill(slug), revision: "a".repeat(40), directory: `skills/${slug}`,
  folderName: slug, content: "instructions", fileCount: 1, files: ["SKILL.md"], totalBytes: 12, sourceUrl: "https://github.com/owner/skills" });

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

it("invalidates pending details when returning to the list and blocks selection changes during installation", async () => {
  const pendingDetail = deferred<MarketplaceSkillDetail>();
  vi.mocked(getMarketplaceSkillDetail).mockReturnValueOnce(pendingDetail.promise);
  const store = useSkillMarketplaceStore.getState();
  const pending = store.selectSkill(skill("review"));
  await store.selectSkill(null);
  pendingDetail.resolve(detail("review"));
  await pending;
  expect(useSkillMarketplaceStore.getState()).toMatchObject({ selected: null, detail: null, detailLoading: false });
  store.setInstalling(true);
  await store.selectSkill(skill("other"));
  expect(useSkillMarketplaceStore.getState()).toMatchObject({ selected: null, installing: true });
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
  useSkillMarketplaceStore.setState({ results: { skills, limited: false } });
  vi.mocked(getMarketplaceSkillSummaries).mockImplementation(async (entries) => entries.map((entry) => ({ ...entry, description: `About ${entry.slug}` })));
  await useSkillMarketplaceStore.getState().loadSummaries(skills);
  expect(vi.mocked(getMarketplaceSkillSummaries).mock.calls.map(([entries]) => entries.length)).toEqual([24, 6]);
  expect(useSkillMarketplaceStore.getState().results?.skills.every((entry) => entry.description === `About ${entry.slug}`)).toBe(true);
});
