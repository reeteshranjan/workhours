// Pure formatting helpers for times and durations. No DOM, no locale: the output is the same
// in every browser and time zone setting, except that "local" means the machine's time zone.
import type { EndReason } from '../../../shared/types.js';

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Whole non-negative ms, so negative and non-finite inputs count as zero. */
function nonNegative(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/** `"01:42:17"`: whole seconds, hours padded to at least two digits. Negative counts as 0. */
export function clock(ms: number): string {
  const totalSeconds = Math.floor(nonNegative(ms) / MS_PER_SECOND);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

/** `"01:42"`: hours and minutes, for the tab title. */
export function clockShort(ms: number): string {
  const totalMinutes = Math.floor(nonNegative(ms) / MS_PER_MINUTE);
  return `${pad2(Math.floor(totalMinutes / 60))}:${pad2(totalMinutes % 60)}`;
}

/** `"42m"` under an hour, otherwise `"3h 12m"` (minutes padded to two digits). */
export function duration(ms: number): string {
  const totalMinutes = Math.floor(nonNegative(ms) / MS_PER_MINUTE);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  return `${Math.floor(totalMinutes / 60)}h ${pad2(totalMinutes % 60)}m`;
}

/** Splits whole minutes into the hours and minutes boxes. Negative counts as 0. */
export function splitMinutes(totalMinutes: number): { hours: number; minutes: number } {
  const whole = Math.floor(nonNegative(totalMinutes));
  return { hours: Math.floor(whole / 60), minutes: whole % 60 };
}

/** Local 24-hour `"14:02"`. */
export function timeOfDay(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Local `"02 Oct 2026"`. */
export function dateLabel(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getDate())} ${MONTHS[d.getMonth()] ?? ''} ${d.getFullYear()}`;
}

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * When something happened, as short as is clear on `now`'s day: `"15:00"` on the same local day,
 * `"yesterday 17:45"`, `"Mon 17:45"` up to six days back, then `"02 Oct"`, with the year if it
 * isn't `now`'s year (`"02 Oct 2025"`). A time later than `now` counts as today.
 */
export function dayAndTime(ms: number, now: number): string {
  // Rounded, because a daylight-saving day is 23 or 25 hours long.
  const days = Math.round((startOfLocalDay(now) - startOfLocalDay(ms)) / MS_PER_DAY);
  if (days <= 0) {
    return timeOfDay(ms);
  }
  if (days === 1) {
    return `yesterday ${timeOfDay(ms)}`;
  }
  const d = new Date(ms);
  if (days <= 6) {
    return `${DAYS[d.getDay()] ?? ''} ${timeOfDay(ms)}`;
  }
  const date = `${pad2(d.getDate())} ${MONTHS[d.getMonth()] ?? ''}`;
  return d.getFullYear() === new Date(now).getFullYear() ? date : `${date} ${d.getFullYear()}`;
}

const REASON_LABELS: Record<EndReason, string> = {
  tab_closed: 'tab closed',
  sleep: 'computer slept',
  stopped: 'Work Hours stopped',
  locked: 'screen locked',
  idle: 'no input for 10 minutes',
  break: 'on break',
  switch: 'switched',
  reset: 'reset',
  close: 'closed',
};

export function reasonLabel(reason: EndReason): string {
  return REASON_LABELS[reason];
}

/** Local 24-hour `"HH:MM"`, for the backdate time box. */
export function toTimeInput(ms: number): string {
  return timeOfDay(ms);
}

/**
 * The latest moment at or before `reference` whose local time is `value` (`"HH:MM"`): on the same
 * local day as `reference`, or the day before if that would be later than `reference`. Seconds and
 * milliseconds are 0. Returns null if `value` isn't a valid `HH:MM`.
 */
export function fromTimeInput(value: string, reference: number): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match || !Number.isFinite(reference)) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return null;
  }
  const candidate = new Date(reference);
  candidate.setHours(hours, minutes, 0, 0);
  if (candidate.getTime() > reference) {
    // Set the date first and the time after it, so a daylight-saving change doesn't shift the time.
    candidate.setDate(candidate.getDate() - 1);
    candidate.setHours(hours, minutes, 0, 0);
  }
  return candidate.getTime();
}

/**
 * A 24-hour time typed by hand, as zero-padded `"HH:MM"`: accepts `H:MM`, `HH:MM`, `HMM` and
 * `HHMM` around optional spaces. Returns null for anything else, or an hour above 23 or a minute
 * above 59.
 */
export function normalizeTimeOfDay(text: string): string | null {
  const match = /^(\d{1,2}):?(\d{2})$/.exec(text.trim());
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return null;
  }
  return `${pad2(hours)}:${pad2(minutes)}`;
}
