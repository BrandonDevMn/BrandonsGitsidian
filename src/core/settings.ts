import { DEFAULT_EXCLUDES } from "./paths";

/** Only owner/repo/branch/token are chosen by Brandon; everything else is a fixed default (specs/01). */
export interface Settings {
  owner: string;
  repo: string;
  branch: string;
  tokenSecretId: string;
  paused: boolean;
  deviceName: string;
  syncOnStartup: boolean;
  syncOnReturn: boolean;
  intervalMinutes: number;
  pushAfterEdits: boolean;
  pushDelaySeconds: number;
  excludes: string[];
  maxFileMB: number;
  logDebug: boolean;
  autoSaveLogNote: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  owner: "BrandonDevMn",
  repo: "Claudian",
  branch: "main",
  tokenSecretId: "",
  paused: false,
  deviceName: "Brandon's iPhone",
  syncOnStartup: true,
  syncOnReturn: true,
  intervalMinutes: 5,
  pushAfterEdits: true,
  pushDelaySeconds: 20,
  excludes: [...DEFAULT_EXCLUDES],
  maxFileMB: 20,
  logDebug: true,
  autoSaveLogNote: false,
};

/** The settings Brandon actually picks. Everything else always comes from DEFAULT_SETTINGS. */
export const CHOSEN_SETTINGS = ["owner", "repo", "branch", "tokenSecretId", "paused"] as const;

export function loadSettings(saved: Partial<Settings> | undefined): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS, excludes: [...DEFAULT_EXCLUDES] };
  for (const k of CHOSEN_SETTINGS) {
    const v = saved?.[k];
    if (v !== undefined) (s as unknown as Record<string, unknown>)[k] = v;
  }
  return s;
}
