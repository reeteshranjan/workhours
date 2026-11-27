<script lang="ts">
  import type { ProjectHistory } from '../../../shared/types.js';
  import * as api from '../lib/api';
  import { entryLabel, entryWhen } from '../lib/history';
  import { store } from '../lib/state.svelte';

  let { projectId }: { projectId: number } = $props();

  let history = $state<ProjectHistory | null>(null);
  let failure = $state<string | null>(null);

  // Loads on mount, and again whenever the app state changes (a reset or an adjustment).
  $effect(() => {
    void store.state;
    const id = projectId;
    let stale = false;
    api
      .getHistory(id)
      .then((loaded) => {
        if (!stale) {
          history = loaded;
          failure = null;
        }
      })
      .catch((err: unknown) => {
        if (!stale) {
          failure = err instanceof api.ApiFailure ? err.message : 'Something went wrong.';
        }
      });
    return () => {
      stale = true;
    };
  });
</script>

{#if failure}
  <p class="muted" role="alert">{failure}</p>
{:else if history === null}
  <p class="muted">Loading history…</p>
{:else if history.entries.length === 0}
  <p class="muted">No resets or adjustments yet.</p>
{:else}
  <ul class="entries" aria-label="History">
    {#each history.entries as entry (`${entry.kind}-${entry.id}`)}
      <li>
        <span class="when">{entryWhen(entry.at)}</span>
        <span class="sep" aria-hidden="true">·</span>
        <span class="label" class:reset={entry.kind === 'reset'}>{entryLabel(entry)}</span>
        {#if entry.kind === 'adjustment'}
          <span class="sep" aria-hidden="true">·</span>
          <span class="reason">{entry.reason}</span>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .muted {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .entries {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 0.875rem;
  }

  li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 var(--space-2);
    padding: var(--space-2) 0;
    border-top: 1px solid var(--border);
  }

  li:first-child {
    padding-top: 0;
    border-top: 0;
  }

  li:last-child {
    padding-bottom: 0;
  }

  .when {
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .sep {
    color: var(--text-muted);
  }

  .label {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .reason {
    min-width: 0;
    overflow-wrap: anywhere;
  }
</style>
