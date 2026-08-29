import { beforeEach, expect, test } from "vitest";
import {
  createInitialApplicationUpdateSnapshot,
  useApplicationUpdateStore,
} from "./applicationUpdate";

beforeEach(() => {
  useApplicationUpdateStore.getState().reset("1.8.22");
});

test("creates an idle transient update snapshot", () => {
  expect(createInitialApplicationUpdateSnapshot("1.8.22")).toEqual({
    phase: "idle",
    currentVersion: "1.8.22",
    availableVersion: null,
    releaseNotes: null,
    downloadedBytes: 0,
    totalBytes: null,
    percent: null,
    error: null,
    errorStage: null,
    modalOpen: false,
  });
});

test("keeps an installing modal open", () => {
  useApplicationUpdateStore.getState().patch({ phase: "installing", modalOpen: true });
  useApplicationUpdateStore.getState().closeModal();
  expect(useApplicationUpdateStore.getState().modalOpen).toBe(true);
});

test("allows a background download modal to be dismissed", () => {
  useApplicationUpdateStore.getState().patch({ phase: "downloading", modalOpen: true });
  useApplicationUpdateStore.getState().closeModal();
  expect(useApplicationUpdateStore.getState().modalOpen).toBe(false);
  expect(useApplicationUpdateStore.getState().phase).toBe("downloading");
});
