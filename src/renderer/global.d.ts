import type { AwBridge } from "../shared/types";

declare global {
  interface Window {
    aw: AwBridge;
  }
}

export {};
