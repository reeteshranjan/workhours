// Typed client for the Work Hours API (DESIGN.md §9).
import type {
  AdjustRequest,
  ApiError,
  AppState,
  AwayActionRequest,
  CloseResult,
  ClosedProject,
  ErrorCode,
  HealthResponse,
  PresenceRequest,
  ProjectHistory,
  ResetResult,
  Settings,
} from '../../../shared/types.js';

const GENERIC_MESSAGE = 'Something went wrong.';
const UNREACHABLE_MESSAGE = "Can't reach the Work Hours server.";

/** A failed API call. `status` is 0 when the server couldn't be reached. */
export class ApiFailure extends Error {
  readonly status: number;
  readonly code: ErrorCode | null;
  /** For name_taken_closed: the closed project to offer "Reopen it" for. */
  readonly projectId: number | null;

  constructor(
    status: number,
    code: ErrorCode | null,
    message: string,
    projectId: number | null = null,
  ) {
    super(message);
    this.name = 'ApiFailure';
    this.status = status;
    this.code = code;
    this.projectId = projectId;
  }
}

async function failureFrom(response: Response): Promise<ApiFailure> {
  try {
    const body = (await response.json()) as Partial<ApiError> | null;
    const error = body?.error;
    if (error && typeof error.message === 'string') {
      return new ApiFailure(
        response.status,
        error.code ?? null,
        error.message,
        typeof error.projectId === 'number' ? error.projectId : null,
      );
    }
  } catch {
    // Not JSON: fall through to the generic message.
  }
  return new ApiFailure(response.status, null, GENERIC_MESSAGE);
}

export async function request<T>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw new ApiFailure(0, null, UNREACHABLE_MESSAGE);
  }
  if (!response.ok) {
    throw await failureFrom(response);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiFailure(response.status, null, GENERIC_MESSAGE);
  }
}

// ---- Health ----

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('GET', '/api/health');
}

// ---- State ----

export function getState(): Promise<AppState> {
  return request<AppState>('GET', '/api/state');
}

// ---- Projects ----

export function addProject(name: string): Promise<AppState> {
  return request<AppState>('POST', '/api/projects', { name });
}

export function start(projectId: number): Promise<AppState> {
  return request<AppState>('POST', `/api/projects/${projectId}/start`);
}

export function pause(): Promise<AppState> {
  return request<AppState>('POST', '/api/pause');
}

export function backdate(at: number): Promise<AppState> {
  return request<AppState>('POST', '/api/backdate', { at });
}

export function reset(projectId: number): Promise<ResetResult> {
  return request<ResetResult>('POST', `/api/projects/${projectId}/reset`);
}

export function adjust(projectId: number, minutes: number, reason: string): Promise<AppState> {
  const body: AdjustRequest = { minutes, reason };
  return request<AppState>('POST', `/api/projects/${projectId}/adjust`, body);
}

export function close(projectId: number): Promise<CloseResult> {
  return request<CloseResult>('POST', `/api/projects/${projectId}/close`);
}

export function reopen(projectId: number): Promise<AppState> {
  return request<AppState>('POST', `/api/projects/${projectId}/reopen`);
}

export function getClosed(): Promise<ClosedProject[]> {
  return request<ClosedProject[]>('GET', '/api/projects/closed');
}

export function getHistory(projectId: number): Promise<ProjectHistory> {
  return request<ProjectHistory>('GET', `/api/projects/${projectId}/history`);
}

// ---- Presence and away ----

export function reportPresence(p: PresenceRequest): Promise<void> {
  return request<void>('POST', '/api/presence', p);
}

export function away(sessionId: number, action: AwayActionRequest['action']): Promise<AppState> {
  const body: AwayActionRequest = { action };
  return request<AppState>('POST', `/api/away/${sessionId}`, body);
}

// ---- Settings and export ----

export function getSettings(): Promise<Settings> {
  return request<Settings>('GET', '/api/settings');
}

export function putSettings(partial: Partial<Settings>): Promise<Settings> {
  return request<Settings>('PUT', '/api/settings', partial);
}

export function exportUrl(format: 'json' | 'csv'): string {
  return `/api/export?format=${format}`;
}
