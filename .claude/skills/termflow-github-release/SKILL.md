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
- Keep the updater endpoint in `src-tauri/tauri.conf.json` as `https://github.com/2642475449/Termflow/releases/latest/download/latest.json`.
- Ensure each manifest platform URL uses the immutable release tag: `https://github.com/2642475449/Termflow/releases/download/v<version>/Termflow_<version>_x64-setup.exe`.

## Prepare a release

1. Inspect the working tree and preserve unrelated changes.
2. Choose the next SemVer version; never reuse or mutate an already published version.
3. Update all three version files and confirm they match the planned `v<version>` tag.
4. Run the relevant build and test checks. A release build must have `TAURI_SIGNING_PRIVATE_KEY` configured so its installer has a fresh matching `.sig` file.
5. Run `pnpm update:manifest --notes "Termflow v<version>"`. Confirm the generated `latest.json` has the intended version, a non-empty signature, and the GitHub Release installer URL.

## Publish and verify

1. Push the matching `v<version>` tag only when the user has explicitly authorized publication.
2. The `Release Termflow` workflow must publish the installer, signature, and generated `latest.json` as assets, then mark the release as latest.
3. After the workflow finishes, download `releases/latest/download/latest.json` and validate its JSON, version, signature, and installer URL. Confirm the installer URL resolves.
4. Test update detection from a previously installed lower version in a packaged Windows build. A source-only build is insufficient.

## Diagnose update checks

- A green “already up to date” message means Tauri `check()` found no version greater than the app's embedded version; it is not proof that the repository's newest tag was consulted.
- Inspect the packaged app's updater endpoint, then inspect the public GitHub `latest.json` asset and compare its version with the installed app.
- Releases built before the GitHub endpoint change retain their old endpoint. They need a one-time manual install of a GitHub-hosted release; a newly built release cannot change an older app's embedded endpoint remotely.
- Treat an updater error separately from “already up to date”; report the actual failure rather than converting it into a success message.

## Safety

Do not create tags, publish releases, upload assets, alter release assets, or overwrite `latest.json` without explicit user authorization. Validate locally and report the proposed release state first when publication was not requested.
