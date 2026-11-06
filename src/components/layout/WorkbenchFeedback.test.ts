// @vitest-environment happy-dom
import React, { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkbenchFeedback } from "./WorkbenchFeedback";
import { showWorkbenchFeedback, useWorkbenchFeedback } from "@/lib/workbenchFeedback";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  useWorkbenchFeedback.setState({ notice: null });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("keeps the original status mounted and gives the latest feedback a full lifetime", async () => {
  const mount = vi.fn();
  const unmount = vi.fn();
  function OriginalStatus() {
    useEffect(() => { mount(); return unmount; }, []);
    return React.createElement("button", null, "path");
  }
  await act(async () => root.render(React.createElement(WorkbenchFeedback, null, React.createElement(OriginalStatus))));
  await act(async () => showWorkbenchFeedback("first"));
  await act(async () => vi.advanceTimersByTime(2000));
  await act(async () => showWorkbenchFeedback("second"));
  await act(async () => vi.advanceTimersByTime(1000));
  expect(host.querySelector('[role="status"]')?.textContent).toBe("second");
  expect(host.querySelector("button")).not.toBeNull();
  expect(unmount).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(2000));
  expect(host.querySelector('[role="status"]')?.textContent).toBe("");
  expect(mount).toHaveBeenCalledTimes(1);
});
