import { describe, expect, it, test } from 'vitest';
import { AUTO_REASONS } from '../../shared/types.js';
import type { AppState, EndReason, ProjectSummary } from '../../shared/types.js';
import { cardOrder, topProjectId } from '../../web/src/lib/order.js';

function project(id: number): ProjectSummary {
  return { id, name: `Project ${id}`, createdAt: id, currentMs: 0, totalMs: 0, lastPause: null };
}

const projects = [project(1), project(2), project(3)];

function running(projectId: number): AppState['running'] {
  return { projectId, sessionId: 1, startedAt: 0 };
}

function paused(reason: EndReason, lastProjectId: number | null): AppState['paused'] {
  return { since: 0, reason, lastProjectId };
}

/** The ids on screen, in order, with each card's place in the order added. */
function ids(state: Pick<AppState, 'running' | 'paused' | 'projects'>): [number, number][] {
  return cardOrder(state).map((slot) => [slot.project.id, slot.index]);
}

const ADDED: [number, number][] = [
  [1, 0],
  [2, 1],
  [3, 2],
];

describe('cardOrder', () => {
  test('keeps the order added when nothing has run', () => {
    expect(ids({ running: null, paused: null, projects })).toEqual(ADDED);
  });

  test('puts the running project first, and the rest in the order added', () => {
    expect(ids({ running: running(3), paused: null, projects })).toEqual([
      [3, 2],
      [1, 0],
      [2, 1],
    ]);
  });

  test('leaves the order alone when the first project runs', () => {
    expect(ids({ running: running(1), paused: null, projects })).toEqual(ADDED);
  });

  test('keeps the project paused by a break first', () => {
    expect(ids({ running: null, paused: paused('break', 2), projects })).toEqual([
      [2, 1],
      [1, 0],
      [3, 2],
    ]);
  });

  it.each(AUTO_REASONS)('keeps the project paused automatically (%s) first', (reason) => {
    expect(ids({ running: null, paused: paused(reason, 3), projects })).toEqual([
      [3, 2],
      [1, 0],
      [2, 1],
    ]);
  });

  test('goes back to the order added after a Reset', () => {
    expect(ids({ running: null, paused: paused('reset', 3), projects })).toEqual(ADDED);
  });

  test('goes back to the order added after a Close', () => {
    expect(ids({ running: null, paused: paused('close', null), projects })).toEqual(ADDED);
  });

  test('ignores a last project that is not in the list', () => {
    expect(ids({ running: null, paused: paused('break', 99), projects })).toEqual(ADDED);
    expect(ids({ running: running(99), paused: null, projects })).toEqual(ADDED);
  });

  test('is empty without projects', () => {
    expect(cardOrder({ running: null, paused: null, projects: [] })).toEqual([]);
  });
});

describe('topProjectId', () => {
  test('is null when nothing has run', () => {
    expect(topProjectId({ running: null, paused: null })).toBeNull();
  });

  test('is the running project, ahead of any pause', () => {
    expect(topProjectId({ running: running(2), paused: paused('break', 1) })).toBe(2);
  });
});
