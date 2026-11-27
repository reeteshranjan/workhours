<script lang="ts">
  import type { ClosedProject } from '../../../shared/types.js';
  import * as api from '../lib/api';
  import { dateLabel, duration } from '../lib/format';
  import { store } from '../lib/state.svelte';
  import History from './History.svelte';

  let projects = $state<ClosedProject[] | null>(null);
  let failure = $state<string | null>(null);
  /** The rows that are open, by project id. */
  let open = $state<Record<number, boolean>>({});
  /** The project whose Reopen is running. */
  let reopening = $state<number | null>(null);

  // Loads on mount, and again whenever the app state changes: a reopen changes it, and so does
  // anything done in another tab.
  $effect(() => {
    void store.state;
    let stale = false;
    api
      .getClosed()
      .then((loaded) => {
        if (!stale) {
          projects = loaded;
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

  async function reopen(id: number): Promise<void> {
    if (reopening !== null) {
      return;
    }
    reopening = id;
    try {
      // The new state reloads the list above; a failure shows in the app's error bar.
      await store.run(() => api.reopen(id));
    } finally {
      reopening = null;
    }
  }
</script>

<section class="closed" aria-labelledby="closed-title">
  <h2 id="closed-title" class="heading">Closed projects</h2>

  {#if failure}
    <p class="muted" role="alert">{failure}</p>
  {:else if projects === null}
    <p class="muted">Loading…</p>
  {:else if projects.length === 0}
    <p class="muted">No closed projects.</p>
  {:else}
    <ul class="rows">
      {#each projects as project (project.id)}
        <li class="row">
          <div class="head">
            <h3 class="name" title={project.name}>{project.name}</h3>
            <span class="muted closed-on">closed {dateLabel(project.closedAt)}</span>
            <span class="total mono">{duration(project.totalMs)}</span>
            <button
              type="button"
              class="btn btn-ghost btn-icon chevron"
              class:open={open[project.id]}
              aria-label="History of {project.name}"
              aria-expanded={open[project.id] === true}
              aria-controls="closed-detail-{project.id}"
              onclick={() => (open[project.id] = !open[project.id])}
            >
              <span aria-hidden="true">›</span>
            </button>
          </div>

          {#if open[project.id]}
            <div class="detail" id="closed-detail-{project.id}">
              <History projectId={project.id} />
              <div class="actions">
                <button
                  type="button"
                  class="btn"
                  disabled={reopening !== null}
                  onclick={() => reopen(project.id)}
                >
                  Reopen
                </button>
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .closed {
    margin-top: var(--space-5);
  }

  .heading {
    margin: 0 0 var(--space-3);
    font-size: 1rem;
    font-weight: 600;
  }

  .muted {
    margin: 0;
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .rows {
    margin: 0;
    padding: 0;
    list-style: none;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .row + .row {
    border-top: 1px solid var(--border);
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-3) var(--space-3) var(--space-5);
  }

  .name {
    flex: 1;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 1rem;
    font-weight: 600;
  }

  .closed-on {
    flex: none;
    white-space: nowrap;
  }

  .total {
    flex: none;
    /* Wide enough for 100h 05m, so the closed dates line up from row to row. */
    min-width: 8ch;
    text-align: right;
    font-weight: 500;
  }

  .chevron {
    flex: none;
    font-size: 1.25rem;
  }

  .chevron span {
    display: inline-block;
    line-height: 1;
  }

  .chevron.open span {
    transform: rotate(90deg);
  }

  .detail {
    padding: var(--space-1) var(--space-5) var(--space-4);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    margin-top: var(--space-4);
  }

  /* On a narrow screen the closed date drops under the name instead of squeezing it. */
  @media (max-width: 520px) {
    .head {
      flex-wrap: wrap;
      gap: var(--space-1) var(--space-3);
      padding-left: var(--space-4);
    }

    .closed-on {
      order: 3;
      flex-basis: 100%;
    }

    .detail {
      padding-inline: var(--space-4);
    }
  }
</style>
