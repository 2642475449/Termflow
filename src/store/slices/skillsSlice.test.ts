import { afterEach, expect, it } from "vitest";
import { useSkillsStore } from "./skillsSlice";

afterEach(() => {
  useSkillsStore.getState().setProject(null);
  useSkillsStore.setState({ editors: {} });
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
