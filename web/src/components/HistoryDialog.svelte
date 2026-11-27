<script lang="ts">
  import { onMount } from 'svelte';
  import type { ProjectSummary } from '../../../shared/types.js';
  import History from './History.svelte';

  let { project, onclosed }: { project: ProjectSummary; onclosed: () => void } = $props();

  let dialog = $state<HTMLDialogElement>();

  onMount(() => dialog?.showModal());
</script>

<dialog bind:this={dialog} class="dialog" aria-labelledby="history-title" onclose={onclosed}>
  <h2 id="history-title" class="title">History · {project.name}</h2>

  <History projectId={project.id} />

  <div class="actions">
    <button type="button" class="btn" onclick={() => dialog?.close()}>Close</button>
  </div>
</dialog>

<style>
  .title {
    margin: 0 0 var(--space-4);
    font-size: 1.125rem;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    margin-top: var(--space-5);
  }
</style>
