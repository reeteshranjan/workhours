<script lang="ts">
  import { onMount } from 'svelte';
  import type { ProjectSummary } from '../../../shared/types.js';
  import * as api from '../lib/api';
  import { clock, duration } from '../lib/format';
  import { MAX_ADJUST_MINUTES, MAX_REASON_LENGTH, checkAdjust } from '../lib/history';
  import { store } from '../lib/state.svelte';

  let { project, onclosed }: { project: ProjectSummary; onclosed: () => void } = $props();

  let dialog = $state<HTMLDialogElement>();
  let minutesInput = $state<HTMLInputElement>();
  let direction = $state<'add' | 'remove'>('add');
  /** What is typed in the minutes box: null while it is empty or not a number. */
  let minutes = $state<number | null>(null);
  let reason = $state('');
  let busy = $state(false);
  let failure = $state<string | null>(null);

  const liveCurrent = $derived(store.liveCurrentMs(project));
  const check = $derived(checkAdjust(liveCurrent, direction, minutes));
  const canSave = $derived(check.kind === 'ok' && reason.trim() !== '' && !busy);

  onMount(() => {
    dialog?.showModal();
    minutesInput?.focus();
  });

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (check.kind !== 'ok' || !canSave) {
      return;
    }
    busy = true;
    failure = null;
    try {
      const state = await api.adjust(
        project.id,
        direction === 'add' ? check.minutes : -check.minutes,
        reason.trim(),
      );
      store.apply(state);
      dialog?.close();
    } catch (err) {
      failure = err instanceof api.ApiFailure ? err.message : 'Something went wrong.';
    } finally {
      busy = false;
    }
  }
</script>

<dialog bind:this={dialog} class="dialog" aria-labelledby="adjust-title" onclose={onclosed}>
  <h2 id="adjust-title" class="title">Adjust {project.name}</h2>

  <form onsubmit={save}>
    <div class="amount">
      <div class="segmented" role="group" aria-label="Add or remove time">
        <button
          type="button"
          class="segment"
          aria-pressed={direction === 'add'}
          onclick={() => (direction = 'add')}
        >
          + Add
        </button>
        <button
          type="button"
          class="segment"
          aria-pressed={direction === 'remove'}
          onclick={() => (direction = 'remove')}
        >
          − Remove
        </button>
      </div>
      <div class="number">
        <input
          bind:this={minutesInput}
          bind:value={minutes}
          class="minutes"
          type="number"
          min="1"
          max={MAX_ADJUST_MINUTES}
          step="1"
          required
          aria-label="Minutes"
          aria-invalid={check.kind === 'too_much' ? 'true' : undefined}
          aria-describedby="adjust-preview"
        />
        <span class="unit" aria-hidden="true">minutes</span>
      </div>
    </div>

    <label class="field">
      <span class="field-label">Reason</span>
      <input
        bind:value={reason}
        type="text"
        required
        maxlength={MAX_REASON_LENGTH}
        placeholder="e.g. worked offline on the train"
        autocomplete="off"
      />
    </label>

    <p id="adjust-preview" class="preview" class:problem={check.kind === 'too_much'}>
      {#if check.kind === 'ok'}
        Current will be <span class="mono">{clock(check.afterMs)}</span>
      {:else if check.kind === 'too_much'}
        Can't remove more than {duration(liveCurrent)}: time already reset has been billed.
      {:else}
        Current is <span class="mono">{clock(liveCurrent)}</span>
      {/if}
    </p>

    {#if failure}
      <p class="problem" role="alert">{failure}</p>
    {/if}

    <div class="actions">
      <button type="button" class="btn" disabled={busy} onclick={() => dialog?.close()}>
        Cancel
      </button>
      <button type="submit" class="btn btn-primary" disabled={!canSave}>Save</button>
    </div>
  </form>
</dialog>

<style>
  .title {
    margin: 0 0 var(--space-4);
    font-size: 1.125rem;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .amount {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
  }

  .segmented {
    display: inline-flex;
    padding: 2px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .segment {
    min-height: 32px;
    padding: 0 var(--space-3);
    color: var(--text-muted);
    background: transparent;
    border: 0;
    border-radius: 6px;
    font-size: 0.875rem;
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
  }

  .segment:hover:not([aria-pressed='true']) {
    color: var(--text);
  }

  .segment[aria-pressed='true'] {
    color: var(--text);
    background: var(--surface);
    box-shadow: 0 0 0 1px var(--border);
  }

  input {
    min-height: 40px;
    padding: 0 var(--space-3);
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  input::placeholder {
    color: var(--text-muted);
  }

  input[aria-invalid='true'] {
    border-color: var(--warning);
  }

  .minutes {
    width: 6rem;
  }

  /* The box and its unit wrap together, so "minutes" never ends up alone on a line. */
  .number {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .unit {
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin-top: var(--space-4);
  }

  .field-label {
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .preview {
    margin: var(--space-4) 0 0;
    min-height: 1.5em;
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .problem {
    color: var(--warning);
    font-weight: 500;
  }

  [role='alert'].problem {
    margin: var(--space-3) 0 0;
    font-size: 0.875rem;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-5);
  }
</style>
