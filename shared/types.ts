// API types shared by the server and the UI. See DESIGN.md §9.
// Times are milliseconds since the epoch (UTC). Durations are milliseconds.

export const APP_ID = 'work-hours';

/** Why a session ended because the user did something. */
export type UserEndReason = 'switch' | 'break' | 'reset' | 'close';
/** Why a session ended automatically (R6.1). */
export type AutoReason = 'tab_closed' | 'sleep' | 'stopped' | 'locked' | 'idle';
export type EndReason = UserEndReason | AutoReason;

/** The reasons the app pauses by itself (R6.1), to tell them apart from the user's own. */
export const AUTO_REASONS: readonly AutoReason[] = [
  'tab_closed',
  'sleep',
  'stopped',
  'locked',
  'idle',
];

export function isAutoReason(reason: EndReason): reason is AutoReason {
  return (AUTO_REASONS as readonly EndReason[]).includes(reason);
}

export const CHECKIN_OPTIONS = [5, 10, 15] as const;
export type CheckinMinutes = (typeof CHECKIN_OPTIONS)[number];

/** Volume is 0–1. It can be lowered but not below this (R7.7). Tuned with the user later. */
export const MIN_VOLUME = 0.2;

export interface Settings {
  checkinMinutes: CheckinMinutes;
  volume: number;
}

export const DEFAULT_SETTINGS: Settings = { checkinMinutes: 10, volume: 0.6 };

export interface ProjectSummary {
  id: number;
  name: string;
  createdAt: number;
  /** Time not yet reset (R2.3), as of AppState.now. */
  currentMs: number;
  /** All time ever, including time already reset (R2.3), as of AppState.now. */
  totalMs: number;
  /**
   * When and why the project's latest session ended (R2.6), or null while it runs or if it has
   * never run. An automatic pause that was counted after another session had started reads as
   * 'switch', because it now ends where that session started.
   */
  lastPause: { at: number; reason: EndReason } | null;
}

/** A pending automatic pause, waiting for Count / Resume / Dismiss (R6.3, R6.4). */
export interface AwayNotice {
  sessionId: number;
  projectId: number;
  projectName: string;
  reason: AutoReason;
  /** The backdated moment the session ended. */
  pausedAt: number;
  /** When the user came back, or null while still away. */
  returnedAt: number | null;
  /**
   * The start of the first session after this one, which is where Count ends the time away, or
   * null if nothing has started since (Count then carries the timer on). The page uses it to say
   * how much Count adds.
   */
  nextStartedAt: number | null;
}

/** The latest Start, switch or Pause, which can still be backdated (R2.5). */
export interface LastAction {
  kind: 'start' | 'switch' | 'pause';
  /** When the user clicked. */
  at: number;
  /** The earliest time it can be backdated to. */
  earliest: number;
}

export interface AppState {
  /** Server time; the page computes its clock offset from it. */
  now: number;
  running: { projectId: number; sessionId: number; startedAt: number } | null;
  /**
   * Set when nothing is running but something ran before. `lastProjectId` is the
   * project of the most recent session, or null if that project is now closed.
   */
  paused: { since: number; reason: EndReason; lastProjectId: number | null } | null;
  /** Active projects, in the order they were added (R1.4). */
  projects: ProjectSummary[];
  awayNotices: AwayNotice[];
  lastAction: LastAction | null;
  settings: Settings;
}

export interface ClosedProject {
  id: number;
  name: string;
  closedAt: number;
  totalMs: number;
}

export type HistoryEntry =
  | { kind: 'reset'; id: number; at: number; minutes: number }
  | { kind: 'adjustment'; id: number; at: number; minutes: number; reason: string };

export interface ProjectHistory {
  projectId: number;
  name: string;
  /** Newest first. */
  entries: HistoryEntry[];
}

/** What a reset recorded, split for the hours and minutes boxes (R3.2). */
export interface ResetResult {
  hours: number;
  minutes: number;
}

/** What a close reset first (R5.1): null when under a minute was left, so nothing was reset. */
export interface CloseResult {
  reset: ResetResult | null;
}

// ---- Requests ----

export interface AddProjectRequest {
  name: string;
}
export interface BackdateRequest {
  at: number;
}
export interface AdjustRequest {
  /** Whole minutes; positive adds, negative removes; never 0. */
  minutes: number;
  reason: string;
}
export interface PresenceRequest {
  user: 'active' | 'idle';
  screen: 'locked' | 'unlocked';
  at: number;
}
export interface AwayActionRequest {
  action: 'count' | 'resume' | 'dismiss';
}

// ---- Responses ----

export interface HealthResponse {
  app: typeof APP_ID;
  version: string;
  /** The absolute path of the data folder, for the Settings page (R8.4). */
  dataDir: string;
}

export type ErrorCode =
  | 'invalid_input'
  | 'invalid_name'
  | 'name_taken'
  | 'name_taken_closed'
  | 'not_found'
  | 'not_active'
  | 'not_closed'
  | 'too_little_time'
  | 'would_go_negative'
  | 'backdate_unavailable'
  | 'backdate_out_of_range'
  | 'not_pending'
  | 'forbidden_host'
  | 'json_required';

export interface ApiError {
  error: {
    code: ErrorCode;
    message: string;
    /** For name_taken_closed: the closed project to offer "Reopen it" for. */
    projectId?: number;
  };
}

// ---- Live events (GET /api/events, DESIGN.md §9.1) ----

export interface EventPayloads {
  /** Something changed; tabs fetch /api/state again. */
  state: Record<string, never>;
  /** A new automatic pause is waiting for the user's choice. */
  autopause: AwayNotice;
  /** The user is back (§6.4). */
  returned: { at: number; sessionIds: number[] };
  /** Time to play the check-in chime. */
  checkin: { projectId: number; sessionId: number };
}
export type EventName = keyof EventPayloads;
