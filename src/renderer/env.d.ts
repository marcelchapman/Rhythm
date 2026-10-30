import type { RioAPI } from "../shared/types";
declare global {
  interface Window {
    rio: RioAPI;
  }
}
