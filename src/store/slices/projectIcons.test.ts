import { beforeEach, expect, it, vi } from "vitest";
import { detectProjectIcon, ensureProjectIconPreference, loadProjectIconPreferences, saveProjectIconPreference, chooseProjectIconImage } from "@/lib/api";
import { useProjectIconsStore } from "./projectIcons";

vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } });
});

vi.mock("@/lib/api", () => ({ detectProjectIcon: vi.fn(), ensureProjectIconPreference: vi.fn(), loadProjectIconPreferences: vi.fn(), saveProjectIconPreference: vi.fn(), chooseProjectIconImage: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(ensureProjectIconPreference).mockResolvedValue({ color: 1, mode: "auto", revision: 1 });
  useProjectIconsStore.setState({ icons: {}, loading: {}, preferences: {}, colors: {}, initialized: true, editor: null });
});

it("migrates old colors before allowing twelve-color initialization and ignores stale events", async () => {
  useProjectIconsStore.setState({ initialized: false });
  vi.mocked(loadProjectIconPreferences).mockResolvedValue({ "e:/project": { color: 2, mode: "auto", revision: 3 } });
  await useProjectIconsStore.getState().setInitialized(["E:\\Project"]);
  expect(loadProjectIconPreferences).toHaveBeenCalledWith([{ path: "E:\\Project", color: expect.any(Number) }]);
  expect(useProjectIconsStore.getState().initialized).toBe(true);
  useProjectIconsStore.getState().setPreference("E:\\Project", { color: 9, mode: "auto", revision: 5 });
  useProjectIconsStore.getState().setPreference("e:/project", { color: 1, mode: "auto", revision: 4 });
  expect(useProjectIconsStore.getState().colors["e:/project"]).toBe(9);
});

it("keeps edits in a draft and cancel leaves the saved preference unchanged", async () => {
  vi.mocked(ensureProjectIconPreference).mockResolvedValue({ color: 1, mode: "auto", revision: 1 });
  await useProjectIconsStore.getState().setEditor({ path: "/project", name: "Project" });
  useProjectIconsStore.getState().setEditorDraft({ color: 8, mode: "emoji", emoji: "🚀" });
  expect(useProjectIconsStore.getState().preferences["/project"].color).toBe(1);
  useProjectIconsStore.getState().setEditorClosed();
  expect(useProjectIconsStore.getState().preferences["/project"].mode).toBe("auto");
  expect(saveProjectIconPreference).not.toHaveBeenCalled();
});

it("preserves a failed save for retry and applies only the successful result", async () => {
  vi.mocked(ensureProjectIconPreference).mockResolvedValue({ color: 1, mode: "auto", revision: 1 });
  vi.mocked(saveProjectIconPreference).mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce({ color: 7, mode: "initials", revision: 2 });
  await useProjectIconsStore.getState().setEditor({ path: "/project", name: "Project" });
  useProjectIconsStore.getState().setEditorDraft({ color: 7, mode: "initials" });
  await useProjectIconsStore.getState().setEditorSaved();
  expect(useProjectIconsStore.getState().editor?.error).toBeTruthy();
  expect(useProjectIconsStore.getState().preferences["/project"].color).toBe(1);
  await useProjectIconsStore.getState().setEditorSaved();
  expect(useProjectIconsStore.getState().editor).toBeNull();
  expect(useProjectIconsStore.getState().preferences["/project"].color).toBe(7);
});

it("blocks editing and saving when the original preference could not be read", async () => {
  vi.mocked(ensureProjectIconPreference).mockRejectedValue(new Error("database unavailable"));
  await useProjectIconsStore.getState().setEditor({ path: "/project", name: "Project" });
  expect(useProjectIconsStore.getState().editor?.loaded).toBe(false);
  useProjectIconsStore.getState().setEditorDraft({ color: 10 });
  await useProjectIconsStore.getState().setEditorSaved();
  expect(saveProjectIconPreference).not.toHaveBeenCalled();
  useProjectIconsStore.getState().setEditorClosed();
  expect(useProjectIconsStore.getState().editor).toBeNull();
});

it("rejects a stale editor after another window saves and requires reading the latest setting", async () => {
  await useProjectIconsStore.getState().setEditor({ path: "/project", name: "Project" });
  useProjectIconsStore.getState().setPreference("/project", { color: 10, mode: "auto", revision: 2 });
  vi.mocked(saveProjectIconPreference).mockRejectedValue("PROJECT_ICON_CONFLICT");
  await useProjectIconsStore.getState().setEditorSaved();
  expect(useProjectIconsStore.getState().editor?.loaded).toBe(false);
  expect(useProjectIconsStore.getState().preferences["/project"].color).toBe(10);
  await useProjectIconsStore.getState().setEditorSaved();
  expect(saveProjectIconPreference).toHaveBeenCalledTimes(1);
});

it("does not save invalid emoji or missing images and discards uploads after cancel", async () => {
  vi.mocked(ensureProjectIconPreference).mockResolvedValue({ color: 1, mode: "auto", revision: 1 });
  await useProjectIconsStore.getState().setEditor({ path: "/project", name: "Project" });
  useProjectIconsStore.getState().setEditorDraft({ mode: "emoji", emoji: "AB" });
  await useProjectIconsStore.getState().setEditorSaved();
  expect(saveProjectIconPreference).not.toHaveBeenCalled();
  let resolve!: (value: string) => void;
  vi.mocked(chooseProjectIconImage).mockReturnValue(new Promise((done) => { resolve = done; }));
  const importing = useProjectIconsStore.getState().setEditorImage();
  useProjectIconsStore.getState().setEditorClosed();
  resolve("data:image/png;base64,old-image");
  await importing;
  expect(useProjectIconsStore.getState().editor).toBeNull();
});

it("shares cached icons across Windows path spellings and refreshes after expiry", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  vi.mocked(detectProjectIcon).mockResolvedValue("data:image/png;base64,logo");
  await useProjectIconsStore.getState().setProjectIcon("E:\\Project");
  await useProjectIconsStore.getState().setProjectIcon("e:/project/");
  expect(detectProjectIcon).toHaveBeenCalledTimes(1);
  expect(useProjectIconsStore.getState().icons["e:/project"].src).toContain("logo");
  clock.mockReturnValue(62_000);
  await useProjectIconsStore.getState().setProjectIcon("E:\\Project");
  expect(detectProjectIcon).toHaveBeenCalledTimes(2);
  clock.mockRestore();
});

it("deduplicates pending requests and caches absent icons", async () => {
  let resolve!: (value: null) => void;
  vi.mocked(detectProjectIcon).mockReturnValue(new Promise((done) => { resolve = done; }));
  const first = useProjectIconsStore.getState().setProjectIcon("/project");
  await useProjectIconsStore.getState().setProjectIcon("/project");
  expect(detectProjectIcon).toHaveBeenCalledTimes(1);
  resolve(null);
  await first;
  await useProjectIconsStore.getState().setProjectIcon("/project");
  expect(detectProjectIcon).toHaveBeenCalledTimes(1);
  expect(useProjectIconsStore.getState().loading["/project"]).toBe(false);
});

it("permits retry after IPC errors and ignores stale image failures", async () => {
  vi.mocked(detectProjectIcon).mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce("new-image");
  await useProjectIconsStore.getState().setProjectIcon("/project");
  await useProjectIconsStore.getState().setProjectIcon("/project");
  useProjectIconsStore.getState().setProjectIconFailed("/project", "old-image");
  expect(useProjectIconsStore.getState().icons["/project"].src).toBe("new-image");
  useProjectIconsStore.getState().setProjectIconFailed("/project", "new-image");
  expect(useProjectIconsStore.getState().icons["/project"].src).toBeNull();
});
