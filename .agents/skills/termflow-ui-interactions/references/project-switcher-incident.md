# Project switcher incident: menu closed, no dialog appeared

## Symptom

Clicking another recent project closed the title-bar Popover, but no project opened and no location-selection dialog appeared.

## Causal chain

The first implementation treated the whole interaction as one awaited click callback:

1. The Popover item awaited `openProject()`.
2. `openProject()` performed a preflight `is_project_window_open` IPC before showing feedback.
3. It then created a static `Modal.confirm()` from the callback associated with the Popover content.
4. The Popover was controlled by different React state and was unmounted during the same transition.

In the packaged Tauri WebView, this composition did not reliably produce the static Modal. The click itself worked—the closing Popover proved that—but the destination overlay was not represented in the component tree, so React had no durable state describing the pending dialog.

The exact WebView/Ant Design internal failure was not emitted as an exception. The diagnosis is based on the behavioral boundary: removing the preflight IPC and replacing the static Modal with a controlled Modal fixed the packaged application. Therefore treat the fragile overlay composition, not the project-window Rust command, as the root cause.

Two design choices amplified the failure:

- The preflight IPC introduced a no-feedback await before the dialog.
- Waiting for two animation frames tied correctness to rendering cadence and could stall in throttled or transitioning WebViews.

## Durable fix

Store `pendingProjectPath` in `TitleBarProjectSwitcher` and render a normal controlled `<Modal>` beside the Popover. The list click closes the Popover and sets pending state. Modal buttons call `openProject(path, disposition)`. The backend final open command remains responsible for focusing an already-open project window.

## Why automated checks missed it

TypeScript, Vitest store tests, Rust unit tests, and Vite builds validate types, state helpers, commands, and compilation. None mounts Ant Design overlays inside the packaged Tauri WebView or exercises the Popover-to-Modal transition. This class of change requires packaged-app interaction testing or a dedicated component integration test with both overlays mounted.

## Review checklist

- Is the second overlay controlled by React state?
- Does the first overlay close before long-running work begins?
- Is there any awaited IPC before the user sees feedback?
- Can the final backend command absorb duplicate detection or focusing?
- Are cancel and error paths visible and side-effect free?
- Was the flow tested in the packaged Tauri application?

## Follow-up: idle PTY misreported as a running session

The first warning implementation counted `session.active || status === "starting" || status === "running"`. This was semantically wrong: `active` records that the PTY process exists, so an agent sitting at its input prompt is still active. The UI therefore warned that one session was running when the turn had already completed.

Use `isSessionTurnRunning(session)`, which returns true only for `starting` and `running`. Keep `active` for terminal availability, resume behavior, and input routing. Do not use it for task-execution warnings, busy badges, or destructive-action risk counts.
