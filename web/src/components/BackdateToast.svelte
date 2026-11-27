<script lang="ts">
  import { tick } from 'svelte';
  import * as api from '../lib/api';
  import { fromTimeInput, normalizeTimeOfDay, timeOfDay, toTimeInput } from '../lib/format';
  import { store } from '../lib/state.svelte';

  const WINDOW_MS = 30_000; // DESIGN §5: the offer lasts 30 seconds.
  const MS_PER_MINUTE = 60_000;

  /** The `at` of the last action whose toast the user closed with ✕. */
  let dismissedAt = $state<number | null>(null);
  /** The `at` of the last action whose editor is open, so a newer action closes it. */
  let editingAt = $state<number | null>(null);
  let value = $state('');
  let failure = $state<string | null>(null);
  let busy = $state(false);
  let link = $state<HTMLButtonElement>();
  let timeInput = $state<HTMLInputElement>();

  const last = $derived(store.state?.lastAction ?? null);
  const editing = $derived(last !== null && editingAt === last.at);
  /** Start and switch name the running project; Pause names the one that just stopped. */
  const project = $derived(last?.kind === 'pause' ? store.lastProject : store.runningProject);
  const visible = $derived(
    last !== null &&
      project !== null &&
      dismissedAt !== last.at &&
      (editing || store.now - last.at < WINDOW_MS),
  );

  const isPause = $derived(last?.kind === 'pause');
  const verb = $derived.by(() => {
    if (last?.kind === 'switch') return 'Switched to';
    if (last?.kind === 'pause') return 'Paused';
    return 'Started';
  });
  const question = $derived(isPause ? 'Stopped earlier?' : 'Started earlier?');
  const editorLabel = $derived(isPause ? 'Actually stopped at' : 'Actually started at');

  /**
   * The time box has whole minutes, so the earliest choice is the first minute that isn't before
   * `earliest`, and a quick button is allowed only if its minute is at or after that.
   */
  const earliestMs = $derived(last ? Math.ceil(last.earliest / MS_PER_MINUTE) * MS_PER_MINUTE : 0);

  function canGoBack(minutes: number): boolean {
    if (!last) {
      return false;
    }
    const minute = Math.floor((last.at - minutes * MS_PER_MINUTE) / MS_PER_MINUTE) * MS_PER_MINUTE;
    return minute >= earliestMs;
  }

  async function openEditor(): Promise<void> {
    if (!last) {
      return;
    }
    // Five minutes back, but not before the earliest allowed minute.
    value = toTimeInput(Math.max(last.at - 5 * MS_PER_MINUTE, earliestMs));
    failure = null;
    editingAt = last.at;
    await tick();
    timeInput?.focus();
  }

  async function closeEditor(): Promise<void> {
    editingAt = null;
    failure = null;
    await tick();
    link?.focus();
  }

  function goBack(minutes: number): void {
    if (last) {
      value = toTimeInput(last.at - minutes * MS_PER_MINUTE);
      failure = null;
    }
  }

  /** Tidies what was typed ("905" becomes "09:05") when the box loses focus. */
  function onblur(): void {
    const normalized = normalizeTimeOfDay(value);
    if (normalized !== null && normalized !== value) {
      value = normalized;
    }
  }

  /** Up and Down step the time by a minute, or ten with Shift, within the allowed range. */
  function onkeydown(event: KeyboardEvent): void {
    if (!last || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) {
      return;
    }
    event.preventDefault();
    const latest = Math.floor(last.at / MS_PER_MINUTE) * MS_PER_MINUTE;
    const normalized = normalizeTimeOfDay(value);
    const current = (normalized === null ? null : fromTimeInput(normalized, last.at)) ?? latest;
    const step = (event.shiftKey ? 10 : 1) * MS_PER_MINUTE;
    const next = current + (event.key === 'ArrowUp' ? step : -step);
    value = toTimeInput(Math.min(Math.max(next, earliestMs), latest));
    failure = null;
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!last || busy) {
      return;
    }
    const normalized = normalizeTimeOfDay(value);
    if (normalized === null) {
      failure = 'Enter a 24-hour time such as 14:05.';
      return;
    }
    const ms = fromTimeInput(normalized, last.at);
    if (ms === null || ms < earliestMs || ms > last.at) {
      failure =
        earliestMs > last.at
          ? 'There is no earlier time to choose yet.'
          : `Choose a time between ${timeOfDay(earliestMs)} and ${timeOfDay(last.at)}.`;
      return;
    }
    busy = true;
    failure = null;
    try {
      // A failure shows in the app's error bar.
      if ((await store.run(() => api.backdate(ms))) !== undefined) {
        await closeEditor();
      }
    } finally {
      busy = false;
    }
  }

  /** Escape closes the editor, unless a dialog is open (Escape belongs to it then). */
  function onwindowkeydown(event: KeyboardEvent): void {
    if (editing && event.key === 'Escape' && !document.querySelector('dialog[open]')) {
      void closeEditor();
    }
  }
</script>

<svelte:window onkeydown={onwindowkeydown} />

{#if visible && last && project}
  {@const at = last.at}
  <!-- Keeps the last card clear of the toast when the page is scrolled to the bottom. -->
  <div class="spacer" aria-hidden="true"></div>

  <div class="toast">
    <div class="message" role="status">
      <p class="text">
        <span class="name">{verb} {project.name}</span>
        <span class="at">at {timeOfDay(at)}</span>
      </p>
      <span class="sep" aria-hidden="true">·</span>
      <button type="button" class="link" bind:this={link} onclick={openEditor}>{question}</button>
      <button
        type="button"
        class="btn btn-ghost btn-icon close"
        aria-label="Close"
        onclick={() => (dismissedAt = at)}
      >
        ✕
      </button>
    </div>

    {#if editing}
      <form class="editor" onsubmit={save}>
        <label class="field">
          <span>{editorLabel}</span>
          <input
            bind:this={timeInput}
            bind:value
            class="mono"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            spellcheck="false"
            maxlength="5"
            placeholder="HH:MM"
            title="24-hour time, for example 14:05"
            required
            aria-invalid={failure ? 'true' : undefined}
            aria-describedby={failure ? 'backdate-error' : 'backdate-hint'}
            oninput={() => (failure = null)}
            {onblur}
            {onkeydown}
          />
        </label>
        <button
          type="button"
          class="btn"
          disabled={busy || !canGoBack(5)}
          onclick={() => goBack(5)}
        >
          −5 min
        </button>
        <button
          type="button"
          class="btn"
          disabled={busy || !canGoBack(10)}
          onclick={() => goBack(10)}
        >
          −10 min
        </button>
        <button type="submit" class="btn btn-primary" disabled={busy}>Save</button>
        <p class="hint" id="backdate-hint">Earliest: {timeOfDay(earliestMs)}</p>
        {#if failure}
          <p class="problem" id="backdate-error" role="alert">{failure}</p>
        {/if}
      </form>
    {/if}
  </div>
{/if}

<style>
  .spacer {
    height: 96px;
  }

  .toast {
    position: fixed;
    bottom: var(--space-4);
    left: 50%;
    z-index: 20;
    width: max-content;
    max-width: min(600px, calc(100vw - 2 * var(--space-4)));
    transform: translateX(-50%);
    padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.18);
    font-size: 0.875rem;
  }

  .message {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 32px;
  }

  /* A long project name wraps rather than being cut, so the toast still says which project it is. */
  .text {
    flex: 0 1 auto;
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .name {
    font-weight: 600;
  }

  .at {
    white-space: nowrap;
  }

  .sep {
    color: var(--text-muted);
  }

  .link {
    flex: none;
    padding: 0;
    color: var(--focus);
    background: none;
    border: 0;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .link:hover {
    text-decoration-thickness: 2px;
  }

  .close {
    flex: none;
    width: 28px;
    min-height: 28px;
    margin-left: auto;
    font-size: 0.875rem;
  }

  .editor {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin: var(--space-2) var(--space-2) var(--space-1) 0;
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }

  .field {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  input {
    min-height: 36px;
    padding: 0 var(--space-2);
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    /* Wide enough for "00:00" with room to spare. */
    width: 7ch;
    text-align: center;
  }

  input::placeholder {
    color: var(--text-muted);
  }

  input[aria-invalid='true'] {
    border-color: var(--warning);
  }

  .hint,
  .problem {
    flex: 1 0 100%;
    margin: 0;
    font-size: 0.8125rem;
  }

  .hint {
    color: var(--text-muted);
  }

  .problem {
    color: var(--warning);
    font-weight: 500;
  }
</style>
