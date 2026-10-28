import { afterEach, expect, it } from "vitest";
import { useSkillsStore } from "./skillsSlice";

afterEach(() => useSkillsStore.getState().setProject(null));

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
