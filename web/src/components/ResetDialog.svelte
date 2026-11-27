<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { ProjectSummary, ResetResult } from '../../../shared/types.js';
  import * as api from '../lib/api';
  import { duration, splitMinutes } from '../lib/format';
  import { store } from '../lib/state.svelte';
  import ResetAmount from './ResetAmount.svelte';

  const MIN_RESET_MS = 60_000; // R3.6
  const MS_PER_MINUTE = 60_000;

  let { project, onclosed }: { project: ProjectSummary; onclosed: () => void } = $props();

  let dialog = $state<HTMLDialogElement>();
  let cancelButton = $state<HTMLButtonElement>();
  let doneButton = $state<HTMLButtonElement>();

  /** What the server recorded once the reset went through; null before that. */
  let recorded = $state<ResetResult | null>(null);
  let busy = $state(false);
  let failure = $state<string | null>(null);

  const liveCurrent = $derived(store.liveCurrentMs(project));
  const liveTotal = $derived(store.liveTotalMs(project));
  const canReset = $derived(liveCurrent >= MIN_RESET_MS);
  /** The boxes follow the running timer until the reset is confirmed, then freeze. */
  const shown = $derived(recorded ?? splitMinutes(Math.floor(liveCurrent / MS_PER_MINUTE)));

  onMount(() => {
    dialog?.showModal();
    // Cancel, not Reset, takes the first Enter press.
    cancelButton?.focus();
  });

  async function confirm(): Promise<void> {
    if (busy || !canReset) {
      return;
    }
    busy = true;
    failure = null;
    try {
      recorded = await api.reset(project.id);
      await tick();
      doneButton?.focus();
      await store.refresh();
    } catch (err) {
      failure = err instanceof api.ApiFailure ? err.message : 'Something went wrong.';
    } finally {
      busy = false;
    }
  }
</script>

<dialog
  bind:this={dialog}
  class="dialog"
  aria-labelledby="reset-title"
  aria-describedby="reset-note"
  onclose={onclosed}
>
  <h2 id="reset-title" class="title">Reset {project.name}</h2>
  <p class="lead">Enter this in the client's system:</p>

  <ResetAmount amount={shown} />

  <p id="reset-note" class="note">
    {#if recorded}
      Recorded. Copy the values into the client's system.
    {:else}
      The counter goes back to zero; leftover seconds stay. Total time ({duration(liveTotal)}) is
      kept.
    {/if}
  </p>

  {#if !recorded && !canReset}
    <p class="problem" role="status">Reset needs at least 1 minute.</p>
  {/if}
  {#if failure}
    <p class="problem" role="alert">{failure}</p>
  {/if}

  <div class="actions">
    {#if recorded}
      <button
        type="button"
        class="btn btn-primary"
        bind:this={doneButton}
        onclick={() => dialog?.close()}
      >
        Done
      </button>
    {:else}
      <button
        type="button"
        class="btn"
        bind:this={cancelButton}
        disabled={busy}
        onclick={() => dialog?.close()}
      >
        Cancel
      </button>
      <button type="button" class="btn btn-primary" disabled={busy || !canReset} onclick={confirm}>
        Reset
      </button>
    {/if}
  </div>
</dialog>

<style>
  .title {
    margin: 0 0 var(--space-3);
    font-size: 1.125rem;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .lead {
    margin: 0;
  }

  .note {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .problem {
    margin: var(--space-3) 0 0;
    color: var(--warning);
    font-size: 0.875rem;
    font-weight: 500;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-5);
  }
</style>
