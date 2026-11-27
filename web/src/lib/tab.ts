// Pure helpers for the browser tab's title and icon (R2.4, R11.3, DESIGN §10.7).
import type { AppState } from '../../../shared/types.js';
import { clockShort } from './format.js';

export const APP_TITLE = 'Work Hours';

/** Green while running, grey otherwise (R11.3). */
export const ICON_COLOR_RUNNING = '#16a34a';
export const ICON_COLOR_IDLE = '#9ca3af';

/**
 * The tab title: `01:42 · Acme Website` while running, `On break · Work Hours` on break,
 * otherwise `Work Hours`. A failing health check puts `⚠ ` in front. `now` is the server-aligned
 * clock, so the running time is the project's `currentMs` plus the time since `state.now`.
 */
export function tabTitle(state: AppState | null, now: number, warning: boolean): string {
  return (warning ? '⚠ ' : '') + baseTitle(state, now);
}

function baseTitle(state: AppState | null, now: number): string {
  if (!state) {
    return APP_TITLE;
  }
  const running = state.running;
  if (running) {
    const project = state.projects.find((p) => p.id === running.projectId);
    if (project) {
      const current = project.currentMs + Math.max(0, now - state.now);
      return `${clockShort(current)} · ${project.name}`;
    }
  } else if (state.paused?.reason === 'break') {
    return `On break · ${APP_TITLE}`;
  }
  return APP_TITLE;
}

/** An inline SVG data URL: a filled circle, green while running and grey otherwise. */
export function faviconHref(running: boolean): string {
  const color = running ? ICON_COLOR_RUNNING : ICON_COLOR_IDLE;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<circle cx="16" cy="16" r="14" fill="${color}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
