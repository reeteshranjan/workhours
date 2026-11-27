// The order the Active view draws its cards in (R1.4). Pure, so it can be tested without a page.
import { isAutoReason } from '../../../shared/types.js';
import type { AppState, ProjectSummary } from '../../../shared/types.js';

/** A card to draw: the project, and its place in the order added (from 0). */
export interface CardSlot {
  project: ProjectSummary;
  index: number;
}

/**
 * The project shown first (R1.4): the one running, or else the one paused by a break or
 * automatically, since it is expected to carry on. Null when nothing has run, or the last stop
 * was a Reset or Close.
 */
export function topProjectId(state: Pick<AppState, 'running' | 'paused'>): number | null {
  if (state.running) return state.running.projectId;
  const { paused } = state;
  if (paused && (paused.reason === 'break' || isAutoReason(paused.reason))) {
    return paused.lastProjectId;
  }
  return null;
}

/**
 * The cards in screen order: the top project first, the rest in the order added. Each keeps its
 * place in the order added, which the 1–9 shortcuts follow (R11.2).
 */
export function cardOrder(state: Pick<AppState, 'running' | 'paused' | 'projects'>): CardSlot[] {
  const slots = state.projects.map((project, index) => ({ project, index }));
  const top = topProjectId(state);
  const at = top === null ? -1 : slots.findIndex((slot) => slot.project.id === top);
  if (at > 0) slots.unshift(...slots.splice(at, 1));
  return slots;
}
