// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TreeDisclosure } from "./TreeDisclosure";

it("delays slow loading feedback and cancels fast or completed requests", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  const host = document.createElement("div");
  const root = createRoot(host);
  const render = async (loading: boolean) => act(async () => root.render(React.createElement(TreeDisclosure, { expanded: true, loading })));
  try {
    await render(true);
    await act(async () => vi.advanceTimersByTime(100));
    expect(host.querySelector(".anticon-loading")).toBeNull();
    await render(false);
    await act(async () => vi.advanceTimersByTime(200));
    expect(host.querySelector(".anticon-loading")).toBeNull();
    await render(true);
    await act(async () => vi.advanceTimersByTime(200));
    expect(host.querySelector(".anticon-loading")).not.toBeNull();
    await render(false);
    expect(host.querySelector(".anticon-loading")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
