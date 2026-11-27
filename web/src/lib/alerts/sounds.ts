// The check-in chime and the alert tone, generated with the Web Audio API (DESIGN §7.1).
// No audio files. The notes are constants so they are easy to tune with the user.
import { DEFAULT_SETTINGS, MIN_VOLUME } from '../../../../shared/types.js';

interface Note {
  /** Pitch in Hz. */
  freq: number;
  /** Seconds from the start of the sound. */
  at: number;
  /** Seconds from the note's start to the end of its fade. */
  length: number;
}

interface Voice {
  wave: OscillatorType;
  /** Gain at the top of the attack, 0–1, before the master volume. */
  peak: number;
  notes: Note[];
}

/** Seconds to fade a note in. */
export const ATTACK_S = 0.02;
/** The exponential decay can't reach 0, so it ends here. */
const SILENCE = 0.0001;
/** Seconds the oscillator runs after its fade, so the end isn't cut off. */
const TAIL_S = 0.05;
/**
 * Seconds of inaudible signal before the first note. After minutes of silence the audio output
 * goes idle, and waking it can swallow the start of a sound, so the notes wait until it is awake.
 */
export const WAKE_S = 0.5;
/** Level of that signal: about −80 dBFS, far below hearing but not digital silence. */
const WAKE_LEVEL = 0.0001;

/** Check-in: two soft sine notes, a little overlapped, under a second (R7.6, R7.8). */
export const CHIME: Voice = {
  wave: 'sine',
  peak: 0.25,
  notes: [
    { freq: 659.25, at: 0, length: 0.35 },
    { freq: 880, at: 0.25, length: 0.35 },
  ],
};

/** Alert: three notes going up, brighter than the chime but still gentle (R7.8). */
export const ALERT: Voice = {
  wave: 'triangle',
  peak: 0.3,
  notes: [
    { freq: 523.25, at: 0, length: 0.18 },
    { freq: 659.25, at: 0.18, length: 0.18 },
    { freq: 783.99, at: 0.36, length: 0.18 },
  ],
};

let context: AudioContext | null = null;
let master: GainNode | null = null;
let volume = DEFAULT_SETTINGS.volume;
let reportedUnlocked = false;
const listeners = new Set<() => void>();

function isUnlocked(): boolean {
  return context !== null && context.state === 'running';
}

/** Tells the listeners, if `unlocked` is not what they were last told. */
function reportChange(): void {
  const now = isUnlocked();
  if (now === reportedUnlocked) {
    return;
  }
  reportedUnlocked = now;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (err) {
      console.error('Sound listener failed', err);
    }
  }
}

/** Plays the inaudible wake-up signal from `from` to `until`, in the context's seconds. */
function wakeOutput(ctx: AudioContext, from: number, until: number): void {
  const signal = ctx.createConstantSource();
  signal.offset.value = WAKE_LEVEL;
  // Straight to the output, so the volume setting doesn't change it.
  signal.connect(ctx.destination);
  signal.start(from);
  signal.stop(until);
  signal.addEventListener('ended', () => signal.disconnect());
}

function play(voice: Voice): void {
  if (!context || !master || !isUnlocked()) {
    return;
  }
  const now = context.currentTime;
  const origin = now + WAKE_S;
  // Kept on until the last note has finished, so the output can't go idle between notes.
  const last = Math.max(...voice.notes.map((note) => note.at + note.length));
  wakeOutput(context, now, origin + last + TAIL_S);
  for (const note of voice.notes) {
    const start = origin + note.at;
    const end = start + note.length;
    const oscillator = context.createOscillator();
    oscillator.type = voice.wave;
    oscillator.frequency.value = note.freq;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(SILENCE, start);
    envelope.gain.exponentialRampToValueAtTime(voice.peak, start + ATTACK_S);
    envelope.gain.exponentialRampToValueAtTime(SILENCE, end);
    oscillator.connect(envelope);
    envelope.connect(master);
    oscillator.start(start);
    oscillator.stop(end + TAIL_S);
    oscillator.addEventListener('ended', () => {
      oscillator.disconnect();
      envelope.disconnect();
    });
  }
}

export const sounds = {
  /** Creates or resumes the AudioContext. Call it from a click. Resolves true if sound is running. */
  async unlock(): Promise<boolean> {
    try {
      if (!context) {
        context = new AudioContext();
        master = context.createGain();
        master.gain.value = volume;
        master.connect(context.destination);
        context.addEventListener('statechange', reportChange);
      }
      if (context.state !== 'running') {
        await context.resume();
      }
    } catch {
      // Chrome refused: the sound stays off and the health check says so.
    }
    reportChange();
    return isUnlocked();
  },

  /** The AudioContext exists and is running. */
  get unlocked(): boolean {
    return isUnlocked();
  },

  /** Calls `fn` when `unlocked` changes. Returns the unsubscribe function. */
  onChange(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },

  /** 0–1, never below the minimum (R7.7). */
  setVolume(v: number): void {
    if (!Number.isFinite(v)) {
      return;
    }
    volume = Math.min(1, Math.max(MIN_VOLUME, v));
    if (master) {
      master.gain.value = volume;
    }
  },

  /** The soft check-in sound. Does nothing until sound is unlocked. */
  chime(): void {
    play(CHIME);
  },

  /** The more noticeable alert sound. Does nothing until sound is unlocked. */
  alertTone(): void {
    play(ALERT);
  },
};
