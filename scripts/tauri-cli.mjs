import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tauriCliPath = require.resolve("@tauri-apps/cli/tauri.js");

function normalizeCiValue(value) {
  if (value == null) {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();

  if (normalized === "1") {
    return "true";
  }

  if (normalized === "0") {
    return "false";
  }

  if (normalized === "true" || normalized === "false") {
    return normalized;
  }

  return value;
}

const env = { ...process.env };
const normalizedCi = normalizeCiValue(env.CI);

if (normalizedCi == null) {
  delete env.CI;
} else {
  env.CI = normalizedCi;
}

const tauriArgs = process.argv.slice(2);
const signingPrivateKey = env.TAURI_SIGNING_PRIVATE_KEY?.trim();

if (tauriArgs[0] === "dev") {
  // 开发版使用独立应用标识，避免与已安装的正式版争用单实例锁，
  // 同时隔离 WebView 与 Tauri 应用数据目录。
  tauriArgs.splice(1, 0, "--config", "src-tauri/tauri.dev.conf.json");
}

if (
  tauriArgs[0] === "build" &&
  !signingPrivateKey &&
  !tauriArgs.includes("--no-sign")
) {
  tauriArgs.splice(1, 0, "--no-sign");
  console.info("No signing private key configured; skipping updater artifact signing for this local build.");
}

const child = spawn(process.execPath, [tauriCliPath, ...tauriArgs], {
  env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
