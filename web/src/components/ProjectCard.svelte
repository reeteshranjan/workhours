<script lang="ts">
  import { tick } from 'svelte';
  import { isAutoReason, type EndReason, type ProjectSummary } from '../../../shared/types.js';
  import { clock, dateLabel, dayAndTime, duration, reasonLabel, timeOfDay } from '../lib/format';
  import { store } from '../lib/state.svelte';

  const MIN_RESET_MS = 60_000; // R3.6

  let {
    project,
    index,
    running,
    onstart,
    onpause,
    onreset,
    onadjust,
    onhistory,
    onclose,
  }: {
    project: ProjectSummary;
    /**
     * Its place in the order projects were added, from 0, not on screen: the running card comes
     * first (R1.4). The first nine show their 1–9 shortcut.
     */
    index: number;
    running: boolean;
    onstart: () => void;
    onpause: () => void;
    onreset: () => void;
    onadjust: () => void;
    onhistory: () => void;
    onclose: () => void;
  } = $props();

  const liveCurrent = $derived(store.liveCurrentMs(project));
  const liveTotal = $derived(store.liveTotalMs(project));
  const canReset = $derived(liveCurrent >= MIN_RESET_MS);
  const shortcut = $derived(index < 9 ? ` (${index + 1})` : '');

  /** How the card last stopped, or null while it runs or if it never has. */
  const pause = $derived(running ? null : project.lastPause);
  const pauseAuto = $derived(pause ? isAutoReason(pause.reason) : false);
  const pauseText = (reason: EndReason, when: string): string => {
    if (isAutoReason(reason)) return `auto-paused ${when} · ${reasonLabel(reason)}`;
    if (reason === 'break') return `paused ${when}`;
    return `paused ${when} · ${reasonLabel(reason)}`;
  };
  // `store.now` ticks every second, so the label changes by itself at midnight.
  const pauseLabel = $derived(
    pause ? pauseText(pause.reason, dayAndTime(pause.at, store.now)) : '',
  );
  const pauseTitle = $derived(
    pause ? pauseText(pause.reason, `${dateLabel(pause.at)} ${timeOfDay(pause.at)}`) : '',
  );

  /** The ⋯ menu is a plain list, so adding an item is one line (DESIGN §10.2). */
  const menuItems = $derived([
    { id: 'adjust', label: 'Adjust time', run: onadjust },
    { id: 'history', label: 'History', run: onhistory },
    { id: 'close', label: 'Close project', run: onclose },
  ]);

  let menuOpen = $state(false);
  let wrapper = $state<HTMLDivElement>();
  let menuButton = $state<HTMLButtonElement>();
  let menu = $state<HTMLUListElement>();

  async function toggleMenu(): Promise<void> {
    menuOpen = !menuOpen;
    if (menuOpen) {
      await tick();
      focusItem(0);
    }
  }

  function closeMenu(returnFocus: boolean): void {
    menuOpen = false;
    if (returnFocus) {
      menuButton?.focus();
    }
  }

  function items(): HTMLElement[] {
    return menu ? [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')] : [];
  }

  function focusItem(position: number): void {
    const list = items();
    list[(position + list.length) % list.length]?.focus();
  }

  function choose(run: () => void): void {
    closeMenu(false);
    run();
  }

  function onwindowkeydown(event: KeyboardEvent): void {
    if (!menuOpen) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const current = items().indexOf(document.activeElement as HTMLElement);
      focusItem(current + (event.key === 'ArrowDown' ? 1 : -1));
    }
  }

  function onwindowclick(event: MouseEvent): void {
    if (menuOpen && event.target instanceof Node && !wrapper?.contains(event.target)) {
      closeMenu(false);
    }
  }

  /** Tabbing out of the menu closes it. */
  function onfocusout(event: FocusEvent): void {
    if (
      menuOpen &&
      event.relatedTarget instanceof Node &&
      !wrapper?.contains(event.relatedTarget)
    ) {
      closeMenu(false);
    }
  }
</script>

<svelte:window onkeydown={onwindowkeydown} onclick={onwindowclick} />

<article class="card" class:running>
  <div class="row top">
    <h2 class="name" title={project.name}>{project.name}</h2>
    {#if running}
      <span class="badge"><span class="dot dot-running" aria-hidden="true"></span> running</span>
    {:else if pause}
      <span class="last-pause" class:auto={pauseAuto} title={pauseTitle}>
        {#if pauseAuto}<span aria-hidden="true">⏸</span> {pauseLabel}{:else}{pauseLabel}{/if}
      </span>
    {/if}
  </div>

  <div class="row bottom">
    <div class="times">
      <span class="pair">
        <span class="mono current">{clock(liveCurrent)}</span>
        <span class="muted">current</span>
      </span>
      <span class="muted total">{duration(liveTotal)} total</span>
    </div>

    <div class="actions" bind:this={wrapper} {onfocusout}>
      {#if running}
        <button
          type="button"
          class="btn btn-primary btn-icon"
          aria-label="Pause"
          title="Pause (Space)"
          onclick={onpause}
        >
          ❚❚
        </button>
      {:else}
        <button
          type="button"
          class="btn btn-primary btn-icon"
          aria-label="Start {project.name}"
          title="Start {project.name}{shortcut}"
          onclick={onstart}
        >
          ▶
        </button>
      {/if}
      <button
        type="button"
        class="btn"
        disabled={!canReset}
        title={canReset ? 'Reset the current time' : 'Reset needs at least 1 minute'}
        onclick={onreset}
      >
        Reset
      </button>
      <button
        type="button"
        class="btn btn-ghost btn-icon"
        bind:this={menuButton}
        aria-label="More actions for {project.name}"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onclick={toggleMenu}
      >
        ⋯
      </button>

      {#if menuOpen}
        <ul class="menu" role="menu" bind:this={menu} aria-label="Actions for {project.name}">
          {#each menuItems as item (item.id)}
            <li role="none">
              <button type="button" role="menuitem" onclick={() => choose(item.run)}>
                {item.label}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>
</article>

<style>
  .card {
    padding: var(--space-4) var(--space-5);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  /* The green bar is an inset shadow, so a running card doesn't shift its content. */
  .card.running {
    background: var(--running-bg);
    border-color: color-mix(in srgb, var(--running) 35%, var(--border));
    box-shadow: inset 4px 0 0 var(--running);
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  /* On a narrow card the name keeps its line and the label wraps under it. */
  .top {
    flex-wrap: wrap;
  }

  .bottom {
    flex-wrap: wrap;
    margin-top: var(--space-2);
  }

  .name {
    margin: 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 1rem;
    font-weight: 600;
  }

  .badge {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: var(--space-2);
    color: var(--running);
    font-size: 0.875rem;
    font-weight: 500;
  }

  .last-pause {
    margin-left: auto;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
    font-size: 0.875rem;
    font-variant-numeric: tabular-nums;
  }

  .last-pause.auto {
    color: var(--paused-text);
    font-weight: 500;
  }

  .times {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-1) var(--space-4);
  }

  .current {
    font-size: 1.5rem;
    font-weight: 500;
    letter-spacing: -0.01em;
  }

  .muted {
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .total {
    font-variant-numeric: tabular-nums;
  }

  .pair {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-2);
  }

  .actions {
    position: relative;
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .menu {
    position: absolute;
    top: calc(100% + var(--space-1));
    right: 0;
    z-index: 10;
    min-width: 180px;
    margin: 0;
    padding: var(--space-1);
    list-style: none;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.14);
  }

  .menu button {
    width: 100%;
    padding: var(--space-2) var(--space-3);
    color: var(--text);
    background: transparent;
    border: 0;
    border-radius: 6px;
    font-size: 0.875rem;
    text-align: left;
    cursor: pointer;
  }

  .menu button:hover,
  .menu button:focus-visible {
    background: var(--surface-2);
  }

  .menu button:focus-visible {
    outline-offset: -2px;
  }
</style>
