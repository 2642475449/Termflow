---
name: termflow-ui-interactions
description: Implement and debug Termflow React, Ant Design, and Tauri desktop interactions involving Popover, Dropdown, Modal, Drawer, project switching, async click handlers, or multiple overlay transitions. Use when an action closes one overlay and must open another, when a click visibly fires but nothing follows, or when UI behavior works in a browser/build check but fails in the packaged WebView application.
---

# Termflow UI Interactions

Build overlay transitions as explicit React state, especially in the custom title bar.

## Overlay transition rules

1. Keep the destination overlay mounted in a stable component tree.
2. Represent the pending action as state, such as `pendingProjectPath`.
3. Close the source Popover/Dropdown first, then set the pending state that opens the destination Modal.
4. Prefer a controlled `<Modal open={...}>` over static `Modal.confirm()` when the Modal is triggered from another overlay's callback.
5. Do not keep the source overlay open while awaiting the complete destination workflow.
6. Do not depend on two nested `requestAnimationFrame` calls for correctness in a Tauri WebView. Use state transitions; use a zero-delay timer only when a render boundary is necessary.

## Async action rules

- Separate selection from execution. A list click should record intent; Modal buttons should execute it.
- Avoid preflight IPC when the final command can resolve the same condition idempotently. Extra IPC adds a silent failure or stall point before feedback appears.
- Surface every awaited failure with a message or diagnostic log. Never allow an awaited call before visible feedback to fail silently.
- Keep duplicate-window detection and focus behavior in the final Tauri command so frontend and backend state cannot race.

## Session state semantics

- Treat `session.active` as PTY/process availability only. It means the terminal is alive and accepts input; it does not mean an agent turn is executing.
- Treat only `status === "starting"` or `status === "running"` as a running agent turn.
- Treat `waiting` and `completed` as idle even when `active === true`.
- Centralize activity checks in `isSessionTurnRunning()` instead of repeating compound conditions in UI components.
- Phrase warnings according to the state actually measured: running turns, live terminals, unread activity, and unsaved files are different concepts.

## Validation

Type checking and production builds do not validate overlay lifecycle behavior. For overlay-to-overlay changes:

1. Verify the source overlay closes.
2. Verify the destination overlay renders in the packaged Tauri application.
3. Test cancel, current-window, new-window, remembered preference, running-turn warning, idle live PTY, and already-open target behavior.
4. Fully restart the installed application after Rust or bundled frontend changes.

Read [references/project-switcher-incident.md](references/project-switcher-incident.md) when diagnosing a click that closes a menu but produces no next UI.
