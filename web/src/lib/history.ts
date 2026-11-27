// Pure helpers for the History view and the Adjust time dialog (R3.5, R4). No DOM.
import type { HistoryEntry } from '../../../shared/types.js';
import { dateLabel, splitMinutes, timeOfDay } from './format.js';

const MS_PER_MINUTE = 60_000;

/** The most minutes one adjustment may add or remove (the server's limit). */
export const MAX_ADJUST_MINUTES = 100_000;
/** The longest reason the server accepts, in characters. */
export const MAX_REASON_LENGTH = 200;

/** `"+30 min"` or `"−10 min"`, with the real minus sign. */
export function signedMinutes(minutes: number): string {
  return `${minutes < 0 ? '−' : '+'}${Math.abs(minutes)} min`;
}

/** `"14 Nov 2026 14:02"`: the local date and time of a history entry. */
export function entryWhen(at: number): string {
  return `${dateLabel(at)} ${timeOfDay(at)}`;
}

/** `"Reset 12 h 34 min"` for a reset, `"+30 min"` for an adjustment. */
export function entryLabel(entry: HistoryEntry): string {
  if (entry.kind === 'reset') {
    const { hours, minutes } = splitMinutes(entry.minutes);
    return `Reset ${hours} h ${minutes} min`;
  }
  return signedMinutes(entry.minutes);
}

/** What the Adjust time dialog shows for the minutes typed so far. */
export type AdjustCheck =
  /** Nothing usable typed yet: not a whole number from 1 to the limit. */
  | { kind: 'incomplete' }
  /** Fine: Current becomes `afterMs`. */
  | { kind: 'ok'; minutes: number; afterMs: number }
  /** Removing this much would take Current below zero (R4.3). */
  | { kind: 'too_much' };

/** Checks an adjustment of `minutes` (always positive) against the project's current time. */
export function checkAdjust(
  currentMs: number,
  direction: 'add' | 'remove',
  minutes: number | null,
): AdjustCheck {
  if (
    minutes === null ||
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > MAX_ADJUST_MINUTES
  ) {
    return { kind: 'incomplete' };
  }
  const afterMs = currentMs + (direction === 'add' ? 1 : -1) * minutes * MS_PER_MINUTE;
  return afterMs < 0 ? { kind: 'too_much' } : { kind: 'ok', minutes, afterMs };
}
