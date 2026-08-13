import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const version = process.argv[2]?.replace(/^v/, "");

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: pnpm release <version>  (example: pnpm release 1.8.20)");
  process.exit(1);
}

function git(args, { capture = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });

  if (result.status !== 0) {
    if (capture) process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }

  return (result.stdout ?? "").trim();
}

const status = git(["status", "--porcelain"], { capture: true });
if (status) {
  console.error("The working tree is not clean. Commit or stash changes before releasing:");
  console.error(status);
  process.exit(1);
}

const tag = `v${version}`;
const existingTag = spawnSync("git", ["rev-parse", "--verify", `refs/tags/${tag}`], {
  cwd: PROJECT_ROOT,
  stdio: "ignore",
});
if (existingTag.status === 0) {
  console.error(`Tag ${tag} already exists.`);
  process.exit(1);
}

const packagePath = resolve(PROJECT_ROOT, "package.json");
const tauriConfigPath = resolve(PROJECT_ROOT, "src-tauri/tauri.conf.json");
const cargoTomlPath = resolve(PROJECT_ROOT, "src-tauri/Cargo.toml");
const cargoLockPath = resolve(PROJECT_ROOT, "src-tauri/Cargo.lock");

async function replaceVersion(path, pattern, label) {
  const contents = await readFile(path, "utf8");
  if (!pattern.test(contents)) {
    console.error(`Could not find the version in ${label}.`);
    process.exit(1);
  }
  await writeFile(path, contents.replace(pattern, `$1${version}$2`), "utf8");
}

await replaceVersion(packagePath, /(\"version\"\s*:\s*\")[^\"]+(\")/, "package.json");
await replaceVersion(tauriConfigPath, /(\"version\"\s*:\s*\")[^\"]+(\")/, "tauri.conf.json");

await replaceVersion(
  cargoTomlPath,
  /(\[package\][\s\S]*?\nversion\s*=\s*")[^"]+("\s*)/,
  "Cargo.toml",
);
await replaceVersion(
  cargoLockPath,
  /(\[\[package\]\]\r?\nname = "termflow"\r?\nversion = ")[^"]+("\r?\n)/,
  "Cargo.lock",
);

git(["add", "package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"]);
git(["commit", "-m", `release: prepare ${tag}`]);
git(["tag", "-a", tag, "-m", `Termflow ${tag}`]);
git(["push", "--atomic", "origin", "HEAD", tag]);

console.log(`\n${tag} pushed. GitHub Actions is building and publishing the release.`);
