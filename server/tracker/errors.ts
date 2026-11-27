import type { ErrorCode } from '../../shared/types.js';

/** A rule was broken. `message` is meant for the user; the API passes `code` and `projectId` on. */
export class TrackerError extends Error {
  readonly code: ErrorCode;
  /** For name_taken_closed: the closed project the UI offers to reopen. */
  readonly projectId?: number;

  constructor(code: ErrorCode, message: string, extra?: { projectId?: number }) {
    super(message);
    this.name = 'TrackerError';
    this.code = code;
    if (extra?.projectId !== undefined) {
      this.projectId = extra.projectId;
    }
  }
}
