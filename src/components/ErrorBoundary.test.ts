// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

it("contains a failed tab, keeps siblings mounted, and allows retry and close", () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const container = document.createElement("div");
  const root = createRoot(container);
  const close = vi.fn();
  let fail = true;
  function Tab() {
    if (fail) throw new Error("diff failed");
    return createElement("span", null, "Recovered diff");
  }
  try {
    act(() => root.render(createElement("div", null,
      createElement("aside", null, "Sidebar still running"),
      createElement(ErrorBoundary, { scope: "tab", onClose: close, children: createElement(Tab) }),
    )));
    expect(container.textContent).toContain("Sidebar still running");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("diff failed");
    act(() => (container.querySelectorAll("button")[1] as HTMLButtonElement).click());
    expect(close).toHaveBeenCalledOnce();
    fail = false;
    act(() => (container.querySelector("button") as HTMLButtonElement).click());
    expect(container.textContent).toContain("Recovered diff");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    errors.mockRestore();
  }
});

it("contains effect-cleanup failures when a preview is replaced", () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const container = document.createElement("div");
  const root = createRoot(container);
  function BrokenDiff() {
    useEffect(() => () => { throw new Error("cleanup failed"); }, []);
    return null;
  }
  try {
    act(() => root.render(createElement(ErrorBoundary, { scope: "tab", children: createElement(BrokenDiff) })));
    act(() => root.render(createElement(ErrorBoundary, { scope: "tab", children: createElement("img") })));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("cleanup failed");
  } finally {
    act(() => root.unmount());
    errors.mockRestore();
  }
});
