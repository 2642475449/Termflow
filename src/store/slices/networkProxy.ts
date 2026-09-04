import type { NetworkProxyMode } from "@/types";
import {
  DEFAULT_NETWORK_PROXY_MODE,
  DEFAULT_NO_PROXY,
  normalizeNetworkProxyMode,
} from "@/lib/networkProxy";

export interface NetworkProxySlice {
  networkProxyMode: NetworkProxyMode;
  networkCustomProxyUrl: string;
  networkNoProxy: string;
  setNetworkProxyMode: (mode: NetworkProxyMode) => void;
  setNetworkCustomProxyUrl: (url: string) => void;
  setNetworkNoProxy: (value: string) => void;
}

type SetNetworkProxyState = (partial: Partial<NetworkProxySlice>) => void;

export function createNetworkProxySlice(set: SetNetworkProxyState): NetworkProxySlice {
  return {
    networkProxyMode: DEFAULT_NETWORK_PROXY_MODE,
    networkCustomProxyUrl: "",
    networkNoProxy: DEFAULT_NO_PROXY,
    setNetworkProxyMode: (mode) => set({ networkProxyMode: normalizeNetworkProxyMode(mode) }),
    setNetworkCustomProxyUrl: (url) => set({ networkCustomProxyUrl: url }),
    setNetworkNoProxy: (value) => set({ networkNoProxy: value }),
  };
}
