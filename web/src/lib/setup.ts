// First-run setup and health warnings, as seen by the UI (R8, DESIGN §8). The flag that says setup
// was done lives in localStorage; the rest is pure, so it can be unit-tested.
import type { Warning, WarningId } from './alerts/rules.js';

/** localStorage key: '1' once the user has been through the setup dialog (or closed it). */
export const SETUP_COMPLETE_KEY = 'workhours:setup-complete';

/** The steps after the welcome screen: sound, notifications, away detection, keep tab active. */
export const STEP_COUNT = 4;

/** 0 is the welcome screen, 1 to 4 are the steps. */
export type SetupStep = 0 | 1 | 2 | 3 | 4;

/** Chrome's page with the Memory Saver exceptions (pages can't open chrome:// links). */
export const MEMORY_SAVER_URL = 'chrome://settings/performance';

export function isSetupComplete(): boolean {
  try {
    return localStorage.getItem(SETUP_COMPLETE_KEY) === '1';
  } catch {
    // Storage blocked: the dialog shows on every load, which is the safe side.
    return false;
  }
}

export function markSetupComplete(): void {
  try {
    localStorage.setItem(SETUP_COMPLETE_KEY, '1');
  } catch {
    // Storage blocked: nothing to remember it with.
  }
}

// ---- Warnings in the status bar ----

export interface WarningSummary {
  /** The most important warning. */
  first: Warning;
  /** "+2 more", or an empty string when `first` is the only one. */
  more: string;
  /** Every warning's text, one per line, for a tooltip. */
  all: string;
}

/** What the status bar shows for the warnings: the first, how many more, and all of them. */
export function summarizeWarnings(warnings: readonly Warning[]): WarningSummary | null {
  const first = warnings[0];
  if (!first) {
    return null;
  }
  const others = warnings.length - 1;
  return {
    first,
    more: others > 0 ? `+${others} more` : '',
    all: warnings.map((w) => w.text).join('\n'),
  };
}

/** What clicking a warning does. */
export type WarningFix = { kind: 'sound' } | { kind: 'setup'; step: SetupStep };

/** The fix a click on a warning can offer, or null when there is none (the server). */
export function fixForWarning(id: WarningId): WarningFix | null {
  switch (id) {
    case 'sound':
      return { kind: 'sound' };
    case 'notifications':
      return { kind: 'setup', step: 2 };
    case 'away':
      return { kind: 'setup', step: 3 };
    case 'discarded':
      return { kind: 'setup', step: 4 };
    case 'server':
      return null;
  }
}
