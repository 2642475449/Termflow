---
name: termflow-component-docs
description: Create or update reusable implementation documentation for Termflow system components, including source-backed mechanisms, data flows, screenshots, official links, code indexes, limitations, and maintenance guidance. Use when documenting a completed component or integration; do not use for general README edits or product marketing copy.
---

# Termflow Component Docs

Create a self-contained local documentation package for the component under `docs/<component-slug>/`:

```text
docs/<component-slug>/
├── README.md
└── images/                 # only when screenshots or diagrams are supplied
```

## Workflow

1. Inspect the actual implementation before writing. Trace UI entry points, frontend API wrappers, Tauri commands/events, Rust modules, storage or cache behavior, and provider-facing protocols. Distinguish verified code behavior from inference.
2. When upstream products, protocols, field semantics, or official URLs are involved, verify them against current first-party documentation. Cite direct official pages in the document; use an official source repository when the protocol is documented there.
3. Copy supplied screenshots into `images/` with stable lowercase descriptive names. Reference them with paths relative to `README.md`. Prefer a compact borderless centered layout; avoid Markdown/HTML tables solely for image placement because repository previewers may add heavy cell styling.
4. Explain the mechanism at the component's useful abstraction level: purpose, data source, end-to-end flow, field mapping, refresh/cache behavior, error states, security/privacy boundaries, limitations, official addresses, key code files, and upgrade verification. Omit sections that do not apply.
5. Preserve important semantic distinctions such as used versus remaining percentage, seconds versus milliseconds, account quota versus session consumption, and missing fields versus numeric zero.
6. Keep credentials and raw provider payloads out of the document and screenshots. Describe authentication ownership and sanitization boundaries without exposing secrets, tokens, private endpoints, prompts, or account identifiers unless the user explicitly wants non-sensitive examples retained.
7. Treat the documentation package as local by default. Confirm it is covered by the repository's existing `docs/` ignore rule. Do not modify `.gitignore` when it is already ignored; only add a narrow directory rule if the package is not ignored and the user wants it local.

## Writing and layout

- Write in the user's requested language; otherwise follow the repository's primary documentation language.
- Lead with a compact comparison or overview when multiple providers or variants are involved.
- Use a small ASCII flow only when it materially clarifies the data path.
- Use tables for exact field mappings and code indexes, not for decorative layout.
- Add a documentation verification date when external contracts are time-sensitive.
- State that upstream CLI/API contracts may evolve and identify the mapping or tests that need revalidation.

## Verification

- Check that every referenced local path and image exists.
- Check Markdown whitespace and repository diff hygiene.
- Confirm `git check-ignore -v docs/<component-slug>/README.md` matches the intended local-only policy.
- Report the documentation entry path, asset layout, sources verified, and any unresolved protocol uncertainty.
