<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import type { ResetResult } from '../../../shared/types.js';
  import * as api from '../lib/api';
  import { splitMinutes } from '../lib/format';
  import { store } from '../lib/state.svelte';
  import ResetAmount from './ResetAmount.svelte';

  const MS_PER_MINUTE = 60_000;

  /**
   * Takes the project's id, not the project: the dialog stays open after the close, when the
   * project has left the active list, to show what the close reset (R5.1).
   */
  let { projectId, onclosed }: { projectId: number; onclosed: () => void } = $props();

  let dialog = $state<HTMLDialogElement>();
  let cancelButton = $state<HTMLButtonElement>();
  let doneButton = $state<HTMLButtonElement>();
  let busy = $state(false);
  let failure = $state<string | null>(null);
  /** The amount on screen when the close was sent, held while the answer is on its way. */
  let sent = $state<ResetResult | null>(null);
  /** What the close reset once it went through; null before that. */
  let recorded = $state<ResetResult | null>(null);

  /** The project from the store while it is active; null once it has closed, here or elsewhere. */
  const project = $derived(store.state?.projects.find((p) => p.id === projectId) ?? null);
  // Projects can't be renamed, so the name taken now lasts after the project has closed.
  const name = untrack(() => project?.name ?? '');
  const liveCurrent = $derived(project ? store.liveCurrentMs(project) : 0);
  /** The whole minutes closing resets: live until Close is pressed, then held, then recorded. */
  const amount = $derived(
    recorded ??
      sent ??
      (liveCurrent >= MS_PER_MINUTE ? splitMinutes(Math.floor(liveCurrent / MS_PER_MINUTE)) : null),
  );

  onMount(() => {
    dialog?.showModal();
    // Cancel, not the close button, takes the first Enter press.
    cancelButton?.focus();
  });

  // A project closed in another tab takes the dialog with it. One closed here keeps it open,
  // to show what was reset.
  $effect(() => {
    if (store.state && !project && !busy && !recorded) {
      dialog?.close();
    }
  });

  async function confirm(): Promise<void> {
    if (busy) {
      return;
    }
    busy = true;
    failure = null;
    sent = amount;
    let reset: ResetResult | null;
    try {
      ({ reset } = await api.close(projectId));
    } catch (err) {
      failure = err instanceof api.ApiFailure ? err.message : 'Something went wrong.';
      sent = null;
      busy = false;
      return;
    }
    // The server resets what is left when the request arrives, which may differ from what was
    // on screen by a minute either way: the boxes show what it recorded.
    recorded = reset;
    busy = false;
    void store.refresh();
    if (recorded) {
      await tick();
      doneButton?.focus();
    } else {
      dialog?.close();
    }
  }
</script>

<dialog
  bind:this={dialog}
  class="dialog"
  aria-labelledby="close-title"
  aria-describedby="close-note"
  onclose={onclosed}
>
  <h2 id="close-title" class="title">Close {name}</h2>

  {#if amount}
    <p class="lead">Enter this in the client's system:</p>
    <ResetAmount {amount} />
    <p id="close-note" class="note">
      {#if recorded}
        Recorded and closed. Copy the values into the client's system.
      {:else}
        Closing resets it first, then moves it to Closed projects.
      {/if}
    </p>
  {:else}
    <p id="close-note" class="lead">It moves to Closed projects.</p>
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
      <button type="button" class="btn btn-danger" disabled={busy} onclick={confirm}>
        {amount ? 'Reset and close' : 'Close project'}
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
