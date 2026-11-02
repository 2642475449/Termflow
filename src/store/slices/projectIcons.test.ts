import { beforeEach, expect, it, vi } from "vitest";
import { detectProjectIcon } from "@/lib/api";
import { useProjectIconsStore } from "./projectIcons";

vi.mock("@/lib/api", () => ({ detectProjectIcon: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  useProjectIconsStore.setState({ icons: {}, loading: {} });
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
