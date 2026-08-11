import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const privateKeyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH;

if (!privateKeyPath) {
  console.error("Set TAURI_SIGNING_PRIVATE_KEY_PATH to your Tauri private key file first.");
  process.exit(1);
}

const privateKey = await readFile(privateKeyPath, "utf8");
const child = spawn(
  process.execPath,
  ["./scripts/tauri-cli.mjs", "build", ...process.argv.slice(2)],
  {
    env: {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY: privateKey,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "",
    },
    stdio: "inherit",
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
