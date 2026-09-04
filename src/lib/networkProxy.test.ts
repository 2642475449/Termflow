import { expect, it } from "vitest";
import {
  DEFAULT_NETWORK_PROXY_MODE,
  normalizeNetworkProxyMode,
  normalizeNetworkProxySettings,
} from "./networkProxy";

it("defaults network proxy mode to system", () => {
  expect(normalizeNetworkProxyMode(undefined)).toBe(DEFAULT_NETWORK_PROXY_MODE);
});

it("normalizes custom proxy settings and preserves local bypasses", () => {
  expect(normalizeNetworkProxySettings({
    mode: "custom",
    customProxyUrl: "  http://127.0.0.1:7897  ",
    noProxy: "example.test",
  })).toEqual({
    mode: "custom",
    customProxyUrl: "http://127.0.0.1:7897",
    noProxy: "example.test,localhost,127.0.0.1,::1",
  });
});
