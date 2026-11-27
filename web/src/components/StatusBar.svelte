<script lang="ts">
  import { isAutoReason } from '../../../shared/types.js';
  import type { AwayNotice } from '../../../shared/types.js';
  import * as api from '../lib/api';
  import { clock, dayAndTime, duration, reasonLabel } from '../lib/format';
  import { store } from '../lib/state.svelte';

  type Choice = Parameters<typeof api.away>[1];

  /**
   * The one box at the top of the page: what is running (on views without the cards), or why
   * nothing is. An automatic pause that is still waiting for Count / Resume / Dismiss is part of
   * it (DESIGN §10.3), not a separate banner. The first health warning, in red, is its last line.
   *
   * `warning` is that warning, or null. `more` is "+2 more" when there are others, with
   * `moreTitle` listing all of them. `onfix` makes the warning a button that fixes it, if it can.
   * `showRunning` is false on the Active view, where the running card comes first and says the
   * same, so the running line is left out (DESIGN §10.2).
   */
  let {
    warning = null,
    more = '',
    moreTitle = '',
    onfix = null,
    showRunning = true,
  }: {
    warning?: string | null;
    more?: string;
    moreTitle?: string;
    onfix?: (() => void) | null;
    showRunning?: boolean;
  } = $props();

  const running = $derived(store.runningProject);
  const paused = $derived(store.state?.paused ?? null);
  /** Every pending automatic pause, by session. */
  const notices = $derived(store.state?.awayNotices ?? []);
  /**
   * The pending notice for the pause that is current: nothing is running, and the last session
   * ended automatically. It is the main line. Null once it was dismissed, or if there is none.
   */
  const mainNotice = $derived.by<AwayNotice | null>(() => {
    if (running || !paused || !isAutoReason(paused.reason)) return null;
    const { lastProjectId, since } = paused;
    return notices.find((n) => n.projectId === lastProjectId && n.pausedAt === since) ?? null;
  });
  /** Notices for older pauses, such as a project that was left when another one started. */
  const otherNotices = $derived(notices.filter((n) => n !== mainNotice));
  /**
   * Which main line shows: a project running; a pending automatic pause with its choices; a break;
   * an automatic pause that was dismissed; or nothing.
   */
  const mode = $derived.by<'running' | 'notice' | 'break' | 'auto' | 'idle'>(() => {
    if (running) return 'running';
    if (mainNotice) return 'notice';
    if (paused?.reason === 'break') return 'break';
    if (paused && isAutoReason(paused.reason)) return 'auto';
    return 'idle';
  });
  /** The running line is left out: the first card says the same (see `showRunning`). */
  const lineHidden = $derived(mode === 'running' && !showRunning);
  /** Nothing is left to show: no line, no other pause, no warning. */
  const empty = $derived(lineHidden && otherNotices.length === 0 && !warning);
  const resumeTarget = $derived(mode === 'break' || mode === 'auto' ? store.lastProject : null);

  /** What Count adds right now: up to the next session's start, or to now if none has started. */
  function countMs(n: AwayNotice): number {
    return (n.nextStartedAt ?? store.now) - n.pausedAt;
  }

  /** Notices with a choice in flight, so a double click can't send it twice. */
  let pending = $state<number[]>([]);

  async function choose(sessionId: number, choice: Choice): Promise<void> {
    if (pending.includes(sessionId)) {
      return;
    }
    pending = [...pending, sessionId];
    try {
      await store.run(() => api.away(sessionId, choice));
    } finally {
      pending = pending.filter((id) => id !== sessionId);
    }
  }

  function pause(): void {
    void store.run(() => api.pause());
  }

  function resume(id: number): void {
    void store.run(() => api.start(id));
  }
</script>

{#if !empty}
  <section
    class="status-bar"
    class:running={mode === 'running' && !lineHidden}
    class:away={mode === 'break' ||
      mode === 'auto' ||
      mode === 'notice' ||
      (lineHidden && otherNotices.length > 0)}
    aria-label="Status"
  >
    {#if mode === 'notice' && mainNotice}
      {@render notice_block(mainNotice, true)}
    {:else if !lineHidden}
      <div class="line">
        {#if mode === 'running' && running}
          <span class="dot dot-running" aria-hidden="true"></span>
          <span class="text name" title={running.name}>{running.name}</span>
          <span class="mono timer">{clock(store.liveCurrentMs(running))}</span>
          <button type="button" class="btn" title="Pause (Space)" onclick={pause}>❚❚ Pause</button>
        {:else if mode === 'break' && paused}
          <span class="dot dot-paused" aria-hidden="true"></span>
          <span class="text">
            On break since {dayAndTime(paused.since, store.now)} · {duration(
              store.now - paused.since,
            )}
          </span>
          {@render resume_button()}
        {:else if mode === 'auto' && paused}
          <span class="icon" aria-hidden="true">⏸</span>
          <span class="text">
            Auto-paused since {dayAndTime(paused.since, store.now)} · {reasonLabel(paused.reason)} · {duration(
              store.now - paused.since,
            )}
          </span>
          {@render resume_button()}
        {:else}
          <span class="dot" aria-hidden="true"></span>
          <span class="text muted">Nothing running. Start a project.</span>
        {/if}
      </div>
    {/if}

    {#each otherNotices as n (n.sessionId)}
      <div class="notice-row">
        {@render notice_block(n, false)}
      </div>
    {/each}

    {#if warning}
      <p class="warning" role="status">
        {#if onfix}
          <button type="button" class="fix" onclick={onfix}>⚠ {warning}</button>
        {:else}
          <span>⚠ {warning}</span>
        {/if}
        {#if more}
          <span class="more" title={moreTitle}>{more}</span>
        {/if}
      </p>
    {/if}
  </section>
{/if}

{#snippet resume_button()}
  {#if resumeTarget}
    {@const target = resumeTarget}
    <button type="button" class="btn" title="Resume (Space)" onclick={() => resume(target.id)}>
      ▶ Resume {target.name}
    </button>
  {/if}
{/snippet}

<!-- A pending automatic pause. Rows leave Resume out: starting a project is its Resume (§5). -->
{#snippet notice_block(n: AwayNotice, withResume: boolean)}
  {@const disabled = pending.includes(n.sessionId)}
  <div class="notice" role="status">
    <p class="notice-text">
      <span class="icon" aria-hidden="true">⏸</span>
      <span class="name">{n.projectName}</span>
      <span class="detail">auto-paused {dayAndTime(n.pausedAt, store.now)} ·</span>
      <span class="detail">{reasonLabel(n.reason)}</span>
    </p>
    <div class="notice-actions">
      {#if withResume}
        <button
          type="button"
          class="btn"
          title="Resume (Space)"
          {disabled}
          onclick={() => choose(n.sessionId, 'resume')}
        >
          <span aria-hidden="true">▶</span> Resume
        </button>
      {/if}
      <button type="button" class="btn" {disabled} onclick={() => choose(n.sessionId, 'count')}>
        Count the {duration(countMs(n))}
      </button>
      <button
        type="button"
        class="btn btn-ghost btn-icon"
        aria-label="Dismiss"
        title="Dismiss"
        {disabled}
        onclick={() => choose(n.sessionId, 'dismiss')}
      >
        ✕
      </button>
    </div>
  </div>
{/snippet}

<style>
  .status-bar {
    padding: var(--space-3) var(--space-4);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .status-bar.running {
    background: var(--running-bg);
    border-color: color-mix(in srgb, var(--running) 35%, var(--border));
  }

  .status-bar.away {
    background: var(--paused-bg);
    border-color: color-mix(in srgb, var(--paused) 35%, var(--border));
  }

  .line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    min-height: 36px;
  }

  /* On a narrow screen the button drops to its own row instead of squeezing the text. */
  .text {
    flex: 1 1 10rem;
    min-width: 0;
    font-variant-numeric: tabular-nums;
  }

  .name {
    font-weight: 600;
  }

  .text.name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .icon {
    color: var(--paused);
  }

  .muted {
    color: var(--text-muted);
  }

  .timer {
    font-size: 1.125rem;
    font-weight: 500;
  }

  /* A pending automatic pause. Message on its own row and the buttons below it, right-aligned
     (DESIGN §10.3), so no width splits a phrase. */
  .notice {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2) var(--space-4);
  }

  .notice-row {
    margin-top: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }

  /* Without the running line above it, the first row needs no separator. */
  .notice-row:first-child {
    margin-top: 0;
    padding-top: 0;
    border-top: none;
  }

  .notice-text {
    flex: 1 1 100%;
    min-width: 0;
    margin: 0;
    font-variant-numeric: tabular-nums;
  }

  .detail {
    white-space: nowrap;
  }

  .notice-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-left: auto;
  }

  .warning {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 var(--space-3);
    margin: var(--space-2) 0 0;
    color: var(--warning);
    font-size: 0.875rem;
    font-weight: 500;
  }

  .warning:first-child {
    margin-top: 0;
  }

  /* A warning that can be fixed with a click looks like the text it replaces, plus an underline. */
  .fix {
    padding: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    background: none;
    border: none;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .more {
    color: var(--text-muted);
    font-weight: 400;
    cursor: help;
  }
</style>
