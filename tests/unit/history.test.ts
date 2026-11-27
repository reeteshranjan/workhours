import { describe, expect, test } from 'vitest';
import {
  MAX_ADJUST_MINUTES,
  checkAdjust,
  entryLabel,
  entryWhen,
  signedMinutes,
} from '../../web/src/lib/history.js';

const MINUTE = 60_000;

/** Local time, so the tests pass in any time zone. */
function local(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

describe('signedMinutes', () => {
  test('shows the sign, with a real minus for negatives', () => {
    expect(signedMinutes(30)).toBe('+30 min');
    expect(signedMinutes(-10)).toBe('−10 min');
    expect(signedMinutes(1)).toBe('+1 min');
  });
});

describe('entryWhen', () => {
  test('is the local date and time', () => {
    expect(entryWhen(local(2026, 11, 14, 14, 2))).toBe('14 Nov 2026 14:02');
    expect(entryWhen(local(2026, 1, 3, 9, 5))).toBe('03 Jan 2026 09:05');
  });
});

describe('entryLabel', () => {
  test('a reset shows hours and minutes', () => {
    expect(entryLabel({ kind: 'reset', id: 1, at: 0, minutes: 754 })).toBe('Reset 12 h 34 min');
    expect(entryLabel({ kind: 'reset', id: 1, at: 0, minutes: 45 })).toBe('Reset 0 h 45 min');
  });

  test('an adjustment shows its signed minutes', () => {
    expect(entryLabel({ kind: 'adjustment', id: 2, at: 0, minutes: 30, reason: 'x' })).toBe(
      '+30 min',
    );
    expect(entryLabel({ kind: 'adjustment', id: 2, at: 0, minutes: -5, reason: 'x' })).toBe(
      '−5 min',
    );
  });
});

describe('checkAdjust', () => {
  const current = 30 * MINUTE + 40_000;

  test('adding gives the new current time', () => {
    expect(checkAdjust(current, 'add', 15)).toEqual({
      kind: 'ok',
      minutes: 15,
      afterMs: current + 15 * MINUTE,
    });
  });

  test('removing gives the new current time, down to exactly zero', () => {
    expect(checkAdjust(current, 'remove', 10)).toEqual({
      kind: 'ok',
      minutes: 10,
      afterMs: current - 10 * MINUTE,
    });
    expect(checkAdjust(30 * MINUTE, 'remove', 30)).toEqual({ kind: 'ok', minutes: 30, afterMs: 0 });
  });

  test("removing more than the current time isn't allowed (R4.3)", () => {
    expect(checkAdjust(current, 'remove', 31)).toEqual({ kind: 'too_much' });
    expect(checkAdjust(0, 'remove', 1)).toEqual({ kind: 'too_much' });
  });

  test('adding is never limited by the current time', () => {
    expect(checkAdjust(0, 'add', 1)).toEqual({ kind: 'ok', minutes: 1, afterMs: MINUTE });
  });

  test('anything but a whole number from 1 to the limit is incomplete', () => {
    for (const minutes of [null, 0, -3, 1.5, Number.NaN, MAX_ADJUST_MINUTES + 1]) {
      expect(checkAdjust(current, 'add', minutes)).toEqual({ kind: 'incomplete' });
    }
    expect(checkAdjust(current, 'add', MAX_ADJUST_MINUTES).kind).toBe('ok');
  });
});
