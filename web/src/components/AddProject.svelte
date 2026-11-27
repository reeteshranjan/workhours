<script lang="ts">
  import * as api from '../lib/api';
  import { store } from '../lib/state.svelte';

  let name = $state('');
  let busy = $state(false);
  /** What to tell the user, and for a closed project's name, the project to offer Reopen for. */
  let failure = $state<{ message: string; reopenId: number | null } | null>(null);
  let input = $state<HTMLInputElement>();

  /** Puts the cursor in the name box (the N shortcut). */
  export function focus(): void {
    input?.focus();
    input?.select();
  }

  function clear(): void {
    name = '';
    failure = null;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) {
      return;
    }
    busy = true;
    try {
      store.apply(await api.addProject(trimmed));
      store.error = null;
      clear();
      input?.focus();
    } catch (err) {
      if (err instanceof api.ApiFailure) {
        failure = {
          message: err.message,
          reopenId: err.code === 'name_taken_closed' ? err.projectId : null,
        };
      } else {
        failure = { message: 'Something went wrong.', reopenId: null };
      }
    } finally {
      busy = false;
    }
  }

  async function reopen(projectId: number): Promise<void> {
    if (busy) {
      return;
    }
    busy = true;
    try {
      // store.run shows a failure in the app's error bar.
      if ((await store.run(() => api.reopen(projectId))) !== undefined) {
        clear();
      }
    } finally {
      busy = false;
    }
  }
</script>

<form class="add" onsubmit={submit}>
  <div class="field">
    <input
      bind:this={input}
      bind:value={name}
      oninput={() => (failure = null)}
      type="text"
      placeholder="New project name…"
      aria-label="New project name"
      aria-invalid={failure ? 'true' : undefined}
      aria-describedby={failure ? 'add-project-error' : undefined}
      title="New project name (N)"
      autocomplete="off"
      spellcheck="false"
    />
    <button type="submit" class="btn" disabled={busy || name.trim() === ''}>+ Add</button>
  </div>

  {#if failure}
    <p class="error" id="add-project-error" role="alert">
      <span>{failure.message}</span>
      {#if failure.reopenId !== null}
        {@const projectId = failure.reopenId}
        <button type="button" class="btn reopen" disabled={busy} onclick={() => reopen(projectId)}>
          Reopen it
        </button>
      {/if}
    </p>
  {/if}
</form>

<style>
  .add {
    margin-bottom: var(--space-5);
  }

  .field {
    display: flex;
    gap: var(--space-2);
  }

  input {
    flex: 1;
    min-width: 0;
    min-height: 40px;
    padding: 0 var(--space-4);
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

  .field .btn {
    min-height: 40px;
  }

  .error {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    margin: var(--space-2) 0 0;
    color: var(--warning);
    font-size: 0.8125rem;
  }

  .reopen {
    min-height: 28px;
    padding: 0 var(--space-3);
    font-size: 0.8125rem;
  }
</style>
