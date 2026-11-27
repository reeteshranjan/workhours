import type { ResetResult } from '../../shared/types.js';

export const MS_PER_MINUTE = 60_000;

/** Splits whole minutes into the hours and minutes boxes of a reset (R3.2). */
export function splitMinutes(totalMinutes: number): ResetResult {
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}

/** `YYYY-MM-DD HH:MM` in the server's local time zone (used by the CSV export). */
export function formatLocalDateTime(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
    `${two(d.getHours())}:${two(d.getMinutes())}`
  );
}
