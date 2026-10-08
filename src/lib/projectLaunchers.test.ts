import { expect, it } from "vitest";
import { createLauncherExample } from "./projectLaunchers";

it("creates portable, independent drafts without an executable default or agent settings", () => {
  const first = createLauncherExample("开发", "终端");
  first.launchers[0].terminals[0].command = "pnpm dev";
  const second = createLauncherExample("Development", "Terminal");
  expect(second).toEqual({ version: 1, launchers: [{ id: "dev", name: "Development", terminals: [{ title: "Terminal", directory: ".", command: "" }] }] });
});
