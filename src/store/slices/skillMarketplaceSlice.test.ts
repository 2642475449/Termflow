import { afterEach, expect, it, vi } from "vitest";
import { getMarketplaceSkillDetail, searchSkillMarketplace } from "@/lib/api";
import type { MarketplaceSkill, MarketplaceSkillDetail, SkillMarketSearch } from "@/types";
import { useSkillMarketplaceStore } from "./skillMarketplaceSlice";

vi.mock("@/lib/api", () => ({ getMarketplaceSkillDetail: vi.fn(), searchSkillMarketplace: vi.fn() }));

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

it("invalidates pending details when closing and blocks selection changes during installation", async () => {
  const pendingDetail = deferred<MarketplaceSkillDetail>();
  vi.mocked(getMarketplaceSkillDetail).mockReturnValueOnce(pendingDetail.promise);
  const store = useSkillMarketplaceStore.getState();
  store.setOpen(true);
  const pending = store.selectSkill(skill("review"));
  store.setOpen(false);
  pendingDetail.resolve(detail("review"));
  await pending;
  expect(useSkillMarketplaceStore.getState()).toMatchObject({ open: false, detail: null, detailLoading: false });
  store.setOpen(true);
  store.setInstalling(true);
  store.setOpen(false);
  await store.selectSkill(skill("other"));
  expect(useSkillMarketplaceStore.getState()).toMatchObject({ open: true, selected: null, installing: true });
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

it("does not contact the marketplace for empty or one-character queries", async () => {
  const store = useSkillMarketplaceStore.getState();
  for (const query of ["", " ", "a", " 🦀 "]) {
    store.setQuery(query);
    await store.search();
  }
  expect(searchSkillMarketplace).not.toHaveBeenCalled();
  expect(useSkillMarketplaceStore.getState()).toMatchObject({ results: null, loading: false, error: null });
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
