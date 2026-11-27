import { TrackerError } from './errors.js';

export const MAX_NAME_LENGTH = 100;
export const MAX_REASON_LENGTH = 200;

const CONTROL_CHARACTERS = /\p{Cc}/u;

/** Length in Unicode code points, which is what SQLite's length() counts. */
function length(text: string): number {
  return [...text].length;
}

/** Validates and trims a project name (R1.1). Duplicates are checked by the Tracker (R1.2). */
export function normalizeName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name === '') {
    throw new TrackerError('invalid_name', 'Enter a project name.');
  }
  if (length(name) > MAX_NAME_LENGTH) {
    throw new TrackerError(
      'invalid_name',
      `Project names can be at most ${MAX_NAME_LENGTH} characters.`,
    );
  }
  if (CONTROL_CHARACTERS.test(name)) {
    throw new TrackerError(
      'invalid_name',
      "Project names can't contain line breaks or control characters.",
    );
  }
  return name;
}

/** Validates and trims the reason for an adjustment (R4.1). */
export function normalizeReason(raw: unknown): string {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (reason === '' || length(reason) > MAX_REASON_LENGTH || CONTROL_CHARACTERS.test(reason)) {
    throw new TrackerError(
      'invalid_input',
      `Enter a reason (up to ${MAX_REASON_LENGTH} characters).`,
    );
  }
  return reason;
}
