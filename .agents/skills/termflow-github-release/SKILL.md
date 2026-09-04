---
name: termflow-github-release
description: Prepare, publish, and verify Termflow releases with Tauri auto-update artifacts hosted entirely in GitHub Releases. Use when changing a release version, creating or repairing a Termflow GitHub Release, updating the updater manifest, investigating an update check, or modifying the release workflow.
---

# Termflow GitHub Release

Keep all updater artifacts in GitHub Releases. Do not add or depend on a self-hosted update server.

## Release contract

- Keep `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` on the identical SemVer version.
- Publish the signed Windows NSIS installer and its `.sig` file as assets of the matching `v<version>` GitHub Release.
- Generate and upload `latest.json` to that same release.
- Publish substantive, user-facing Release notes that explain what was added or upgraded and what was fixed. The automatically generated `Full Changelog` link alone is not an acceptable release description.
- Keep the updater endpoint in `src-tauri/tauri.conf.json` as `https://github.com/2642475449/Termflow/releases/latest/download/latest.json`.
- Ensure each manifest platform URL uses the immutable release tag: `https://github.com/2642475449/Termflow/releases/download/v<version>/Termflow_<version>_x64-setup.exe`.

## Prepare a release

1. Inspect the working tree and preserve unrelated changes.
2. Choose the next SemVer version; never reuse or mutate an already published version.
3. Update all three version files and confirm they match the planned `v<version>` tag.
4. Run the relevant build and test checks, including the Windows packaging preflight below. A release build must have `TAURI_SIGNING_PRIVATE_KEY` configured so its installer has a fresh matching `.sig` file.
5. Draft the Release notes from the complete diff and commit range between the previous published release tag and the planned tag. Verify important claims against the implementation; do not infer features from commit subjects alone.
6. Run `pnpm update:manifest --notes "<concise user-facing summary>"`. Do not leave the updater notes as only `Termflow v<version>`. Confirm the generated `latest.json` has the intended version, a non-empty signature, the GitHub Release installer URL, and useful notes.

## Release notes

- Write for users rather than as a raw commit log. Describe observable behavior and impact; omit internal refactors unless they affect compatibility, reliability, security, packaging, or maintenance.
- Use `## 新增与升级` for new capabilities, meaningful improvements, dependency/runtime upgrades, and changed behavior.
- Use `## 问题修复` for corrected bugs, regressions, crashes, security issues, and release/build fixes.
- Add `## 升级说明` only when users must take action, such as a one-time manual update, configuration migration, known limitation, or installer-size change. State the required action explicitly.
- If a required section has no entries, say `无` rather than inventing content. Keep entries concrete and deduplicate multiple commits that implement the same user-facing change.
- Include the GitHub compare/Full Changelog link after the curated notes as supporting detail, not as a replacement for them.
- Prepare the notes before creating the tag. During an authorized publication, pass them to the release workflow or update the draft release body before making it public.

## Windows packaging preflight

- Do not treat `pnpm build`, TypeScript checks, or unit tests as proof that a Tauri release can be packaged. Before creating the release tag, complete a local Windows `pnpm tauri build` (a no-sign local preflight is acceptable); require it to produce the NSIS installer successfully.
- Re-run this full preflight whenever frontend dependencies that ship assets are added or upgraded, especially document, PDF, Office, font, WASM, or worker packages.
- Preserve the Vite/Rollup asset naming invariant in `vite.config.ts`: use `assets/[name]-[hash][extname]`. Do not replace `[extname]` with `.[ext]` or another pattern that always inserts a dot.
- Some third-party packages ship extensionless files such as `LICENSE` and `NOTICE`. With a `.[ext]` suffix, Rollup can reference them as `LICENSE-<hash>.` or `NOTICE-<hash>.`. Windows cannot reliably address paths ending in a dot, so `tauri::generate_context!` then fails while embedding `dist`, even though the ordinary Vite build succeeded.
- If the build reports `failed to read asset ... because file not found`, inspect the complete path first. A basename ending in `.` is this asset-naming failure; correct the Rollup naming rule, rebuild `dist`, and repeat the full Tauri packaging preflight before tagging. Do not work around it by deleting the dependency license asset.

## Publish and verify

1. Push the matching `v<version>` tag only when the user has explicitly authorized publication.
2. The `Release Termflow` workflow must publish the installer, signature, generated `latest.json`, and curated Release notes, then mark the release as latest.
3. After the workflow finishes, inspect the public Release page and confirm both `新增与升级` and `问题修复` are present with the intended content; reject a body containing only GitHub's generated changelog.
4. Download `releases/latest/download/latest.json` and validate its JSON, version, signature, installer URL, and user-facing notes. Confirm the installer URL resolves.
5. Test update detection from a previously installed lower version in a packaged Windows build. A source-only build is insufficient.

## Diagnose update checks

- A green “already up to date” message means Tauri `check()` found no version greater than the app's embedded version; it is not proof that the repository's newest tag was consulted.
- Inspect the packaged app's updater endpoint, then inspect the public GitHub `latest.json` asset and compare its version with the installed app.
- Releases built before the GitHub endpoint change retain their old endpoint. They need a one-time manual install of a GitHub-hosted release; a newly built release cannot change an older app's embedded endpoint remotely.
- Treat an updater error separately from “already up to date”; report the actual failure rather than converting it into a success message.

## Safety

Do not create tags, publish releases, upload assets, alter release assets, or overwrite `latest.json` without explicit user authorization. Validate locally and report the proposed release state first when publication was not requested.
