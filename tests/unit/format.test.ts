import { describe, expect, test } from 'vitest';
import type { EndReason } from '../../shared/types.js';
import {
  clock,
  clockShort,
  dateLabel,
  dayAndTime,
  duration,
  fromTimeInput,
  normalizeTimeOfDay,
  reasonLabel,
  splitMinutes,
  timeOfDay,
  toTimeInput,
} from '../../web/src/lib/format.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Local time, so the tests pass in any time zone. */
function local(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

describe('clock', () => {
  test('formats hours, minutes and seconds', () => {
    expect(clock(0)).toBe('00:00:00');
    expect(clock(HOUR + 42 * MINUTE + 17 * SECOND)).toBe('01:42:17');
  });

  test('floors to whole seconds', () => {
    expect(clock(59.9 * SECOND)).toBe('00:00:59');
    expect(clock(999)).toBe('00:00:00');
    expect(clock(60 * SECOND)).toBe('00:01:00');
  });

  test('pads hours to at least two digits and grows beyond that', () => {
    expect(clock(HOUR)).toBe('01:00:00');
    expect(clock(100 * HOUR)).toBe('100:00:00');
    expect(clock(123 * HOUR + 4 * MINUTE + 5 * SECOND)).toBe('123:04:05');
  });

  test('treats negatives as zero', () => {
    expect(clock(-1)).toBe('00:00:00');
    expect(clock(-5 * HOUR)).toBe('00:00:00');
  });
});

describe('clockShort', () => {
  test('formats hours and minutes', () => {
    expect(clockShort(0)).toBe('00:00');
    expect(clockShort(HOUR + 42 * MINUTE + 17 * SECOND)).toBe('01:42');
    expect(clockShort(59.9 * SECOND)).toBe('00:00');
    expect(clockShort(HOUR)).toBe('01:00');
    expect(clockShort(100 * HOUR)).toBe('100:00');
  });

  test('treats negatives as zero', () => {
    expect(clockShort(-MINUTE)).toBe('00:00');
  });
});

describe('duration', () => {
  test('shows minutes only under an hour', () => {
    expect(duration(0)).toBe('0m');
    expect(duration(59.9 * SECOND)).toBe('0m');
    expect(duration(MINUTE)).toBe('1m');
    expect(duration(42 * MINUTE + 59 * SECOND)).toBe('42m');
    expect(duration(59 * MINUTE + 59.9 * SECOND)).toBe('59m');
  });

  test('shows hours and zero-padded minutes from one hour', () => {
    expect(duration(HOUR)).toBe('1h 00m');
    expect(duration(3 * HOUR + 12 * MINUTE)).toBe('3h 12m');
    expect(duration(38 * HOUR + 5 * MINUTE)).toBe('38h 05m');
    expect(duration(100 * HOUR)).toBe('100h 00m');
  });

  test('treats negatives as zero', () => {
    expect(duration(-1)).toBe('0m');
    expect(duration(-3 * HOUR)).toBe('0m');
  });
});

describe('splitMinutes', () => {
  test('splits into hours and minutes', () => {
    expect(splitMinutes(0)).toEqual({ hours: 0, minutes: 0 });
    expect(splitMinutes(59)).toEqual({ hours: 0, minutes: 59 });
    expect(splitMinutes(60)).toEqual({ hours: 1, minutes: 0 });
    expect(splitMinutes(754)).toEqual({ hours: 12, minutes: 34 });
    expect(splitMinutes(6000)).toEqual({ hours: 100, minutes: 0 });
  });

  test('treats negatives as zero', () => {
    expect(splitMinutes(-30)).toEqual({ hours: 0, minutes: 0 });
  });
});

describe('timeOfDay', () => {
  test('is 24-hour and zero-padded', () => {
    expect(timeOfDay(local(2026, 11, 23, 14, 2))).toBe('14:02');
    expect(timeOfDay(local(2026, 11, 23, 0, 0))).toBe('00:00');
    expect(timeOfDay(local(2026, 11, 23, 9, 5))).toBe('09:05');
    expect(timeOfDay(local(2026, 11, 23, 23, 59, 59))).toBe('23:59');
  });
});

describe('dateLabel', () => {
  test('uses a two-digit day, an English short month and the year', () => {
    expect(dateLabel(local(2026, 10, 2, 12))).toBe('02 Oct 2026');
    expect(dateLabel(local(2026, 11, 23, 14, 2))).toBe('23 Nov 2026');
    expect(dateLabel(local(2027, 1, 1, 0, 0))).toBe('01 Jan 2027');
    expect(dateLabel(local(2026, 12, 31, 23, 59, 59))).toBe('31 Dec 2026');
  });

  test('has an English name for every month', () => {
    const names = Array.from({ length: 12 }, (_, month) =>
      dateLabel(local(2026, month + 1, 15, 12)).slice(3, 6),
    );
    expect(names).toEqual([
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ]);
  });
});

describe('dayAndTime', () => {
  // A Wednesday.
  const now = local(2026, 11, 25, 9, 0);

  test('is just the time on the same local day, even if it is later than now', () => {
    expect(dayAndTime(local(2026, 11, 25, 8, 5), now)).toBe('08:05');
    expect(dayAndTime(local(2026, 11, 25, 0, 0), now)).toBe('00:00');
    expect(dayAndTime(local(2026, 11, 25, 10, 0), now)).toBe('10:00');
  });

  test('says yesterday for the previous local day, at either end of it', () => {
    expect(dayAndTime(local(2026, 11, 24, 23, 59), now)).toBe('yesterday 23:59');
    expect(dayAndTime(local(2026, 11, 24, 0, 0), now)).toBe('yesterday 00:00');
  });

  test('uses the weekday up to six days back', () => {
    expect(dayAndTime(local(2026, 11, 23, 8, 5), now)).toBe('Mon 08:05');
    expect(dayAndTime(local(2026, 11, 19, 17, 45), now)).toBe('Thu 17:45');
  });

  test('uses the date from seven days back, with the year only if it differs', () => {
    expect(dayAndTime(local(2026, 11, 18, 17, 45), now)).toBe('18 Nov');
    expect(dayAndTime(local(2026, 1, 2, 10, 0), now)).toBe('02 Jan');
    expect(dayAndTime(local(2025, 12, 30, 10, 0), now)).toBe('30 Dec 2025');
  });

  test('counts days across a new year', () => {
    expect(dayAndTime(local(2026, 12, 31, 23, 0), local(2027, 1, 1, 0, 30))).toBe(
      'yesterday 23:00',
    );
    expect(dayAndTime(local(2026, 12, 31, 17, 45), local(2027, 1, 2, 9, 0))).toBe('Thu 17:45');
  });
});

describe('reasonLabel', () => {
  test('has the wording for every reason', () => {
    const expected: Record<EndReason, string> = {
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
    for (const [reason, label] of Object.entries(expected)) {
      expect(reasonLabel(reason as EndReason)).toBe(label);
    }
  });
});

describe('toTimeInput', () => {
  test('is local HH:MM', () => {
    expect(toTimeInput(local(2026, 11, 23, 14, 2, 41))).toBe('14:02');
    expect(toTimeInput(local(2026, 11, 23, 0, 7))).toBe('00:07');
  });
});

describe('fromTimeInput', () => {
  const reference = local(2026, 11, 23, 14, 30, 45);

  test('picks the same day when that time has already happened', () => {
    expect(fromTimeInput('14:02', reference)).toBe(local(2026, 11, 23, 14, 2));
    expect(fromTimeInput('00:00', reference)).toBe(local(2026, 11, 23, 0, 0));
  });

  test('picks the previous day when that time is still ahead', () => {
    expect(fromTimeInput('14:31', reference)).toBe(local(2026, 11, 22, 14, 31));
    expect(fromTimeInput('23:59', reference)).toBe(local(2026, 11, 22, 23, 59));
  });

  test('crosses a month and a year boundary', () => {
    expect(fromTimeInput('23:00', local(2026, 12, 1, 8, 0))).toBe(local(2026, 11, 30, 23, 0));
    expect(fromTimeInput('23:00', local(2027, 1, 1, 8, 0))).toBe(local(2026, 12, 31, 23, 0));
  });

  test('allows the reference minute itself, with seconds and milliseconds zeroed', () => {
    expect(fromTimeInput('14:30', reference)).toBe(local(2026, 11, 23, 14, 30));
    const exact = local(2026, 11, 23, 14, 30);
    expect(fromTimeInput('14:30', exact)).toBe(exact);
  });

  test('round-trips with toTimeInput', () => {
    const at = local(2026, 11, 23, 9, 5);
    expect(fromTimeInput(toTimeInput(at), reference)).toBe(at);
  });

  test('returns null for anything that is not a valid HH:MM', () => {
    for (const bad of [
      '25:00',
      '24:00',
      '12:60',
      'ab',
      '9:5',
      '09:5',
      '9:05',
      '',
      '12:00:00',
      ' 12:00',
    ]) {
      expect(fromTimeInput(bad, reference)).toBeNull();
    }
  });

  test('returns null for a reference that is not a time', () => {
    expect(fromTimeInput('12:00', Number.NaN)).toBeNull();
  });
});

describe('normalizeTimeOfDay', () => {
  test('pads and accepts H:MM, HH:MM, HMM and HHMM', () => {
    expect(normalizeTimeOfDay('9:05')).toBe('09:05');
    expect(normalizeTimeOfDay('905')).toBe('09:05');
    expect(normalizeTimeOfDay('0905')).toBe('09:05');
    expect(normalizeTimeOfDay('14:03')).toBe('14:03');
    expect(normalizeTimeOfDay('1403')).toBe('14:03');
  });

  test('ignores spaces around the time and accepts both ends of the day', () => {
    expect(normalizeTimeOfDay(' 7:30 ')).toBe('07:30');
    expect(normalizeTimeOfDay('0:00')).toBe('00:00');
    expect(normalizeTimeOfDay('23:59')).toBe('23:59');
  });

  test('returns null for anything else', () => {
    for (const bad of [
      '24:00',
      '12:60',
      '9:5',
      'ab',
      '',
      '12:00:00',
      '123456',
      '1:2:3',
      '-1:00',
      '12 00',
    ]) {
      expect(normalizeTimeOfDay(bad)).toBeNull();
    }
  });
});
