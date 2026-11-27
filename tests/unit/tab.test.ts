import { describe, expect, test } from 'vitest';
import type { AppState, EndReason } from '../../shared/types.js';
import {
  APP_TITLE,
  ICON_COLOR_IDLE,
  ICON_COLOR_RUNNING,
  faviconHref,
  tabTitle,
} from '../../web/src/lib/tab.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 10, 23, 14, 0);

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    now: NOW,
    running: null,
    paused: null,
    projects: [
      {
        id: 1,
        name: 'Acme Website',
        createdAt: NOW - 9 * HOUR,
        currentMs: 0,
        totalMs: 0,
        lastPause: null,
      },
      {
        id: 2,
        name: 'Data pipeline migration',
        createdAt: NOW - 8 * HOUR,
        currentMs: HOUR + 40 * MINUTE,
        totalMs: 12 * HOUR,
        lastPause: null,
      },
    ],
    awayNotices: [],
    lastAction: null,
    settings: { checkinMinutes: 10, volume: 0.6 },
    ...overrides,
  };
}

function paused(reason: EndReason): AppState['paused'] {
  return { since: NOW - 42 * MINUTE, reason, lastProjectId: 2 };
}

describe('tabTitle', () => {
  test('running shows the live time and the project name', () => {
    const state = makeState({ running: { projectId: 2, sessionId: 5, startedAt: NOW - HOUR } });
    // 1h40m as of state.now, plus 2m of ticking since then.
    expect(tabTitle(state, NOW + 2 * MINUTE, false)).toBe('01:42 · Data pipeline migration');
  });

  test('running uses the time as of the state when the clock has not moved', () => {
    const state = makeState({ running: { projectId: 2, sessionId: 5, startedAt: NOW - HOUR } });
    expect(tabTitle(state, NOW, false)).toBe('01:40 · Data pipeline migration');
  });

  test('a clock behind the state never goes backwards', () => {
    const state = makeState({ running: { projectId: 2, sessionId: 5, startedAt: NOW - HOUR } });
    expect(tabTitle(state, NOW - 5 * MINUTE, false)).toBe('01:40 · Data pipeline migration');
  });

  test('running a project with no time yet shows 00:00', () => {
    const state = makeState({ running: { projectId: 1, sessionId: 6, startedAt: NOW } });
    expect(tabTitle(state, NOW + 30 * SECOND, false)).toBe('00:00 · Acme Website');
  });

  test('on break says so', () => {
    expect(tabTitle(makeState({ paused: paused('break') }), NOW, false)).toBe(
      'On break · Work Hours',
    );
  });

  test.each(['tab_closed', 'sleep', 'stopped', 'locked', 'idle'] as const)(
    'paused automatically (%s) shows the plain title',
    (reason) => {
      expect(tabTitle(makeState({ paused: paused(reason) }), NOW, false)).toBe(APP_TITLE);
    },
  );

  test.each(['switch', 'reset', 'close'] as const)(
    'a pause for %s shows the plain title',
    (reason) => {
      expect(tabTitle(makeState({ paused: paused(reason) }), NOW, false)).toBe(APP_TITLE);
    },
  );

  test('nothing started yet shows the plain title', () => {
    expect(tabTitle(makeState(), NOW, false)).toBe('Work Hours');
  });

  test('before the first state arrives it shows the plain title', () => {
    expect(tabTitle(null, NOW, false)).toBe('Work Hours');
  });

  test('a running project missing from the list shows the plain title', () => {
    const state = makeState({ running: { projectId: 99, sessionId: 7, startedAt: NOW } });
    expect(tabTitle(state, NOW, false)).toBe('Work Hours');
  });

  test('a warning puts ⚠ in front of every kind of title', () => {
    const running = makeState({ running: { projectId: 1, sessionId: 6, startedAt: NOW } });
    expect(tabTitle(running, NOW, true)).toBe('⚠ 00:00 · Acme Website');
    expect(tabTitle(makeState({ paused: paused('break') }), NOW, true)).toBe(
      '⚠ On break · Work Hours',
    );
    expect(tabTitle(makeState(), NOW, true)).toBe('⚠ Work Hours');
    expect(tabTitle(null, NOW, true)).toBe('⚠ Work Hours');
  });
});

describe('faviconHref', () => {
  function decode(href: string): string {
    const prefix = 'data:image/svg+xml,';
    expect(href.startsWith(prefix)).toBe(true);
    return decodeURIComponent(href.slice(prefix.length));
  }

  test('is a green circle while running', () => {
    const svg = decode(faviconHref(true));
    expect(svg).toContain('<circle');
    expect(svg).toContain(`fill="${ICON_COLOR_RUNNING}"`);
    expect(ICON_COLOR_RUNNING).toBe('#16a34a');
  });

  test('is a grey circle otherwise', () => {
    const svg = decode(faviconHref(false));
    expect(svg).toContain(`fill="${ICON_COLOR_IDLE}"`);
    expect(ICON_COLOR_IDLE).toBe('#9ca3af');
  });

  test('has no characters that need escaping in a data URL', () => {
    expect(faviconHref(true)).not.toMatch(/[<>"#\s]/);
  });
});
