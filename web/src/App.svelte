<script lang="ts">
  import { onMount } from 'svelte';
  import { flip } from 'svelte/animate';
  import AddProject from './components/AddProject.svelte';
  import AdjustDialog from './components/AdjustDialog.svelte';
  import BackdateToast from './components/BackdateToast.svelte';
  import CloseDialog from './components/CloseDialog.svelte';
  import ClosedList from './components/ClosedList.svelte';
  import HistoryDialog from './components/HistoryDialog.svelte';
  import ProjectCard from './components/ProjectCard.svelte';
  import ResetDialog from './components/ResetDialog.svelte';
  import Settings from './components/Settings.svelte';
  import SetupDialog from './components/SetupDialog.svelte';
  import StatusBar from './components/StatusBar.svelte';
  import * as api from './lib/api';
  import { startAlerts } from './lib/alerts/engine.svelte';
  import { health } from './lib/alerts/health.svelte';
  import { sounds } from './lib/alerts/sounds';
  import { cardOrder } from './lib/order';
  import { fixForWarning, isSetupComplete, summarizeWarnings } from './lib/setup';
  import type { SetupStep } from './lib/setup';
  import { store } from './lib/state.svelte';
  import { useTabTitle } from './lib/tab.svelte';

  type View = 'active' | 'closed' | 'settings';

  /** The Settings button shows a gear instead of a label, so it needs its own accessible name. */
  const views: { id: View; label: string; ariaLabel?: string }[] = [
    { id: 'active', label: 'Active' },
    { id: 'closed', label: 'Closed' },
    { id: 'settings', label: 'Settings', ariaLabel: 'Settings' },
  ];

  let view = $state<View>('active');
  let addProject = $state<AddProject>();
  /** The open project dialog, by project id (the project itself is looked up live). */
  let dialogTarget = $state<{
    kind: 'reset' | 'close' | 'adjust' | 'history';
    projectId: number;
  } | null>(null);
  /** The open setup dialog and the step it starts at: open on a first run, and from a warning. */
  let setupOpen = $state<{ step: SetupStep } | null>(isSetupComplete() ? null : { step: 0 });

  onMount(() => {
    store.start();
    startAlerts();

    // Chrome blocks sound until the page has had a click or key press, and any will do (R8.2).
    // Unlock on `click` (bubbling to window, so the clicked control has already acted), not on
    // `pointerdown`: unlocking removes the "Sound is off" warning, which shifts the page, and if
    // that happened while the button was still down the click would land on whatever moved under
    // the pointer. The listeners stay until the unlock has worked.
    function onactivate(): void {
      void sounds.unlock().then((ok) => {
        if (ok) {
          window.removeEventListener('click', onactivate);
          window.removeEventListener('keydown', onactivate);
        }
      });
    }
    window.addEventListener('click', onactivate);
    window.addEventListener('keydown', onactivate);

    return () => {
      window.removeEventListener('click', onactivate);
      window.removeEventListener('keydown', onactivate);
    };
  });
  useTabTitle(() => health.warnings.length > 0);

  const warnings = $derived(summarizeWarnings(health.warnings));
  const warningFix = $derived(warnings ? fixForWarning(warnings.first.id) : null);

  /** What a click on the status bar's warning does (R8.3). */
  function fixWarning(): void {
    if (warningFix?.kind === 'sound') {
      void sounds.unlock();
    } else if (warningFix?.kind === 'setup') {
      setupOpen = { step: warningFix.step };
    }
  }

  const runningId = $derived(store.state?.running?.projectId ?? null);
  /** The cards in screen order, each with its place in the order added (R1.4). */
  const cards = $derived(store.state ? cardOrder(store.state) : []);
  // `flip` runs in JavaScript, so the CSS reduced-motion rule doesn't reach it.
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** The current object from the store, so the dialog's live values keep updating. */
  const dialogProject = $derived(
    dialogTarget
      ? (store.state?.projects.find((p) => p.id === dialogTarget?.projectId) ?? null)
      : null,
  );

  // A project that was closed elsewhere takes its dialog with it. The Close dialog sees to that
  // itself, since it stays open after its own close to show what was reset.
  $effect(() => {
    if (dialogTarget && dialogTarget.kind !== 'close' && store.state && !dialogProject) {
      dialogTarget = null;
    }
  });

  function start(id: number): void {
    void store.run(() => api.start(id));
  }

  function pause(): void {
    void store.run(() => api.pause());
  }

  // ---- Keyboard shortcuts (R11.2) ----

  function isTyping(target: EventTarget | null): boolean {
    return (
      target instanceof HTMLElement &&
      (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
    );
  }

  /** Space was handled on keydown, so its keyup must not also click a focused button. */
  let swallowSpaceKeyup = false;

  function onkeydown(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
    if (isTyping(event.target) || document.querySelector('dialog[open]')) return;
    // Space and the digits belong to an open ⋯ menu's items.
    if (event.target instanceof Element && event.target.closest('[role="menu"]')) return;

    if (event.key === 'n' || event.key === 'N') {
      if (view !== 'active') return;
      event.preventDefault();
      addProject?.focus();
    } else if (event.key === ' ') {
      // Space on a focused button or link presses that control, not the global shortcut.
      if (
        event.target instanceof Element &&
        event.target.closest('button, a[href], [role="button"]')
      )
        return;
      const last = store.lastProject;
      if (store.state?.running) {
        event.preventDefault();
        swallowSpaceKeyup = true;
        pause();
      } else if (last) {
        event.preventDefault();
        swallowSpaceKeyup = true;
        start(last.id);
      }
    } else if (event.key >= '1' && event.key <= '9' && event.key.length === 1) {
      if (view !== 'active') return;
      // `projects` is in the order added, so a key always starts the same project, even when the
      // first card is another one (R11.2).
      const project = store.state?.projects[Number(event.key) - 1];
      if (project && project.id !== runningId) {
        event.preventDefault();
        start(project.id);
      }
    }
  }

  function onkeyup(event: KeyboardEvent): void {
    if (event.key === ' ' && swallowSpaceKeyup) {
      swallowSpaceKeyup = false;
      event.preventDefault();
    }
  }
</script>

<svelte:window {onkeydown} {onkeyup} />

<main>
  <header>
    <h1>Work Hours</h1>
    <nav aria-label="Views">
      {#each views as v (v.id)}
        <button
          type="button"
          class="nav-btn"
          class:selected={view === v.id}
          aria-label={v.ariaLabel}
          aria-current={view === v.id ? 'page' : undefined}
          onclick={() => (view = v.id)}
        >
          {#if v.id === 'settings'}
            <svg
              class="gear"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path
                d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
              />
              <circle cx="12" cy="12" r="3" />
            </svg>
          {:else}
            {v.label}
          {/if}
        </button>
      {/each}
    </nav>
  </header>

  {#if store.state}
    <StatusBar
      warning={warnings?.first.text ?? null}
      more={warnings?.more}
      moreTitle={warnings?.all}
      onfix={warningFix ? fixWarning : null}
      showRunning={view !== 'active'}
    />

    {#if store.error}
      <div class="error-bar" role="alert">
        <span>{store.error}</span>
        <button
          type="button"
          class="btn btn-ghost btn-icon"
          aria-label="Dismiss error"
          onclick={() => (store.error = null)}
        >
          ✕
        </button>
      </div>
    {/if}

    {#if view === 'active'}
      <div class="active">
        <AddProject bind:this={addProject} />

        {#if store.state.projects.length === 0}
          <p class="empty">No projects yet. Add your first one above.</p>
        {:else}
          <ul class="cards">
            {#each cards as { project, index } (project.id)}
              <li animate:flip={{ duration: reduceMotion ? 0 : 200 }}>
                <ProjectCard
                  {project}
                  {index}
                  running={project.id === runningId}
                  onstart={() => start(project.id)}
                  onpause={pause}
                  onreset={() => (dialogTarget = { kind: 'reset', projectId: project.id })}
                  onadjust={() => (dialogTarget = { kind: 'adjust', projectId: project.id })}
                  onhistory={() => (dialogTarget = { kind: 'history', projectId: project.id })}
                  onclose={() => (dialogTarget = { kind: 'close', projectId: project.id })}
                />
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {:else if view === 'closed'}
      <ClosedList />
    {:else}
      <Settings onsetup={() => (setupOpen = { step: 1 })} />
    {/if}
  {:else}
    <p class="placeholder">Loading…</p>
  {/if}

  {#if dialogTarget?.kind === 'close'}
    <CloseDialog projectId={dialogTarget.projectId} onclosed={() => (dialogTarget = null)} />
  {:else if dialogTarget && dialogProject}
    {#if dialogTarget.kind === 'reset'}
      <ResetDialog project={dialogProject} onclosed={() => (dialogTarget = null)} />
    {:else if dialogTarget.kind === 'adjust'}
      <AdjustDialog project={dialogProject} onclosed={() => (dialogTarget = null)} />
    {:else}
      <HistoryDialog project={dialogProject} onclosed={() => (dialogTarget = null)} />
    {/if}
  {/if}

  <BackdateToast />
</main>

{#if setupOpen}
  <SetupDialog initialStep={setupOpen.step} onclosed={() => (setupOpen = null)} />
{/if}

<style>
  main {
    max-width: 760px;
    margin: 0 auto;
    padding: var(--space-5) var(--space-4) var(--space-6);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-5);
  }

  h1 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
  }

  nav {
    display: flex;
    gap: var(--space-1);
  }

  .nav-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    /* As tall as the text buttons, so the gear doesn't make its button shorter. */
    min-height: calc(1.5em + var(--space-2) + 2px);
    color: var(--text-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    padding: var(--space-1) var(--space-3);
    cursor: pointer;
  }

  .nav-btn:hover {
    background: var(--surface-2);
    color: var(--text);
  }

  .nav-btn.selected {
    background: var(--surface);
    border-color: var(--border);
    color: var(--text);
  }

  .error-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-top: var(--space-3);
    padding: var(--space-1) var(--space-1) var(--space-1) var(--space-4);
    color: var(--warning);
    background: var(--warning-bg);
    border: 1px solid color-mix(in srgb, var(--warning) 35%, var(--border));
    border-radius: var(--radius-sm);
    font-size: 0.875rem;
  }

  .error-bar .btn-icon {
    width: 28px;
    min-height: 28px;
    color: inherit;
  }

  .active {
    margin-top: var(--space-5);
  }

  .cards {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .empty,
  .placeholder {
    margin-top: var(--space-5);
    color: var(--text-muted);
  }
</style>
