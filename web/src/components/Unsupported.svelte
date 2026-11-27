<script lang="ts">
  const COPIED_MS = 1500;

  const address = location.origin;

  let input = $state<HTMLInputElement>();
  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      // No clipboard access: leave the address selected so Cmd/Ctrl+C works.
      input?.focus();
      input?.select();
      return;
    }
    copied = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied = false), COPIED_MS);
  }
</script>

<main>
  <h1>Work Hours needs Google Chrome</h1>
  <p>Open this address in Chrome:</p>
  <div class="address">
    <input
      bind:this={input}
      class="mono"
      type="text"
      readonly
      value={address}
      aria-label="Address to open in Chrome"
    />
    <button type="button" class="btn" onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
  </div>
  <p class="why">
    Away detection and the notification buttons are Chrome features, and Work Hours can't keep your
    time log accurate without them.
  </p>
</main>

<style>
  main {
    max-width: 520px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-4);
  }

  h1 {
    margin: var(--space-6) 0 var(--space-3);
    font-size: 1.25rem;
    font-weight: 600;
  }

  p {
    margin: 0 0 var(--space-3);
  }

  .address {
    display: flex;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
  }

  input {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 36px;
    padding: 0 var(--space-3);
    color: var(--text);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 0.875rem;
  }

  .why {
    color: var(--text-muted);
    font-size: 0.875rem;
  }
</style>
