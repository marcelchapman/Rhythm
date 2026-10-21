import type { RhythmAPI } from "../shared/types";
declare global {
  interface Window {
    rhythm: RhythmAPI;
  }
}
