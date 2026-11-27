import { describe, expect, test } from 'vitest';
import type { Warning, WarningId } from '../../web/src/lib/alerts/rules.js';
import {
  fixForWarning,
  isSetupComplete,
  markSetupComplete,
  summarizeWarnings,
} from '../../web/src/lib/setup.js';

function warning(id: WarningId, text: string): Warning {
  return { id, text };
}

describe('summarizeWarnings', () => {
  test('is null when nothing is wrong', () => {
    expect(summarizeWarnings([])).toBeNull();
  });

  test('one warning has no "more"', () => {
    const sound = warning('sound', 'Sound is off. Click to turn on.');
    expect(summarizeWarnings([sound])).toEqual({
      first: sound,
      more: '',
      all: 'Sound is off. Click to turn on.',
    });
  });

  test('several: the first one, "+N more", and every text for the tooltip', () => {
    const sound = warning('sound', 'Sound is off.');
    const notifications = warning('notifications', 'Notifications are off.');
    const away = warning('away', 'Away detection is off.');
    expect(summarizeWarnings([sound, notifications, away])).toEqual({
      first: sound,
      more: '+2 more',
      all: 'Sound is off.\nNotifications are off.\nAway detection is off.',
    });
  });
});

describe('fixForWarning', () => {
  test('sound is fixed by a click, the permissions by their setup step', () => {
    expect(fixForWarning('sound')).toEqual({ kind: 'sound' });
    expect(fixForWarning('notifications')).toEqual({ kind: 'setup', step: 2 });
    expect(fixForWarning('away')).toEqual({ kind: 'setup', step: 3 });
    expect(fixForWarning('discarded')).toEqual({ kind: 'setup', step: 4 });
  });

  test('the server has no fix', () => {
    expect(fixForWarning('server')).toBeNull();
  });
});

describe('the setup flag', () => {
  test('is not set, and setting it does not throw, where localStorage is unavailable', () => {
    // The unit tests run in Node, which has no localStorage for a page: access must be guarded.
    expect(isSetupComplete()).toBe(false);
    expect(() => markSetupComplete()).not.toThrow();
  });
});
