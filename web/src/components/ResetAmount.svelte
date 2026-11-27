<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { ResetResult } from '../../../shared/types.js';

  const COPIED_MS = 1500;

  type Part = 'hours' | 'minutes';

  /** The amount to enter in the client's system, in hours and minutes boxes with Copy (R3.2). */
  let { amount }: { amount: ResetResult } = $props();

  const uid = $props.id();
  let inputs = $state<Record<Part, HTMLInputElement | undefined>>({
    hours: undefined,
    minutes: undefined,
  });
  let copied = $state<Part | null>(null);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  onDestroy(() => clearTimeout(copiedTimer));

  async function copy(part: Part): Promise<void> {
    try {
      await navigator.clipboard.writeText(String(amount[part]));
    } catch {
      // No clipboard access: leave the digits selected so Cmd/Ctrl+C works.
      inputs[part]?.focus();
      inputs[part]?.select();
      return;
    }
    copied = part;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied = null), COPIED_MS);
  }
</script>

<div class="boxes">
  {#each ['hours', 'minutes'] as const as part (part)}
    <div class="part" role="group" aria-labelledby="{uid}-{part}-label">
      <div class="entry">
        <input
          bind:this={inputs[part]}
          class="mono value"
          type="text"
          readonly
          value={amount[part]}
          aria-labelledby="{uid}-{part}-label"
        />
        <span id="{uid}-{part}-label" class="label">{part}</span>
      </div>
      <button type="button" class="btn copy" onclick={() => copy(part)}>
        {copied === part ? 'Copied' : 'Copy'}
      </button>
    </div>
  {/each}
</div>

<style>
  .boxes {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4);
    margin: var(--space-4) 0;
  }

  .part {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
  }

  .entry {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }

  .value {
    width: 5rem;
    min-height: 56px;
    padding: 0 var(--space-2);
    color: var(--text);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 2rem;
    font-weight: 500;
    text-align: center;
  }

  .label {
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .copy {
    min-height: 32px;
    min-width: 5rem;
    padding: 0 var(--space-3);
    font-size: 0.8125rem;
  }
</style>
