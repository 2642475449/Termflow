import { afterEach, expect, it, vi } from "vitest";
import { listSkills } from "@/lib/api";
import type { SkillCatalog } from "@/types";
import { useSkillsStore } from "./skillsSlice";

vi.mock("@/lib/api", () => ({ listSkills: vi.fn() }));

afterEach(() => {
  useSkillsStore.getState().setProject(null);
  useSkillsStore.setState({ editors: {} });
  vi.resetAllMocks();
});

it("ignores results and loading state from a previous project", () => {
  const store = useSkillsStore.getState();
  store.setProject("old");
  store.setProject("new");
  store.setCatalog("old", { skills: [], roots: [] });
  store.setLoading("old", false, true);
  expect(useSkillsStore.getState()).toMatchObject({ projectPath: "new", catalog: null, loading: true, error: false });
  store.setCatalog("new", { skills: [], roots: [] });
  store.setLoading("new", false);
  expect(useSkillsStore.getState()).toMatchObject({ catalog: { skills: [], roots: [] }, loading: false, error: false });
});

it("retains dirty drafts when reloading metadata or changing projects", () => {
  const store = useSkillsStore.getState();
  store.setEditorLoaded("skill", "Original");
  store.setEditorDraft("skill", "My changes");
  store.setEditorLoaded("skill", "External changes");
  store.setProject("another project");
  expect(useSkillsStore.getState().editors.skill).toMatchObject({ original: "Original", draft: "My changes" });
  store.setEditorLoaded("skill", "External changes", true);
  expect(useSkillsStore.getState().editors.skill).toMatchObject({ original: "External changes", draft: "External changes" });
});

it("ignores stale validation and preserves edits made during a save", () => {
  const store = useSkillsStore.getState();
  store.setEditorLoaded("skill", "Original");
  store.setEditorDraft("skill", "First draft");
  store.setEditorDraft("skill", "Second draft");
  store.setEditorValidation("skill", "First draft", { issues: [], name: "review", description: "Review" });
  expect(useSkillsStore.getState().editors.skill.validation).toBeNull();
  store.setEditorSaved("skill", "First draft", "First draft");
  expect(useSkillsStore.getState().editors.skill).toMatchObject({ original: "First draft", draft: "Second draft" });
  store.setEditorValidation("skill", "Second draft", { issues: [], name: "review", description: "Review" });
  expect(useSkillsStore.getState().editors.skill.validatedContent).toBe("Second draft");
  store.setEditorSaved("skill", "Second draft", "Second draft");
  store.setEditorLoaded("skill", "Second draft");
  expect(useSkillsStore.getState().editors.skill.validatedContent).toBe("Second draft");
  expect(useSkillsStore.getState().editors.skill.original).toBe(useSkillsStore.getState().editors.skill.draft);
});

it("keeps the latest catalog when settings and the marketplace refresh concurrently", async () => {
  let resolve!: (catalog: SkillCatalog) => void;
  const old = new Promise<SkillCatalog>((done) => { resolve = done; });
  const latest: SkillCatalog = { skills: [], roots: [{ agent: "codex", scope: "user", enabledDir: "new" }] };
  vi.mocked(listSkills).mockReturnValueOnce(old).mockResolvedValueOnce(latest);
  const store = useSkillsStore.getState();
  store.setProject("project");
  const pending = store.refreshCatalog("project");
  await store.refreshCatalog("project");
  resolve({ skills: [], roots: [] });
  await pending;
  expect(useSkillsStore.getState()).toMatchObject({ catalog: latest, loading: false, error: false });
});

it("surfaces catalog failures and allows refreshing without reopening settings", async () => {
  vi.mocked(listSkills).mockRejectedValueOnce("offline").mockResolvedValueOnce({ skills: [], roots: [] });
  const store = useSkillsStore.getState();
  store.setProject("project");
  await expect(store.refreshCatalog("project")).rejects.toBe("offline");
  expect(useSkillsStore.getState()).toMatchObject({ loading: false, error: true });
  await store.refreshCatalog("project");
  expect(useSkillsStore.getState()).toMatchObject({ loading: false, error: false, catalog: { skills: [], roots: [] } });
});
