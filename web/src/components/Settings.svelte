<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { CHECKIN_OPTIONS, DEFAULT_SETTINGS, MIN_VOLUME } from '../../../shared/types.js';
  import type { CheckinMinutes } from '../../../shared/types.js';
  import * as api from '../lib/api';
  import { health } from '../lib/alerts/health.svelte';
  import type { WarningId } from '../lib/alerts/health.svelte';
  import { notify } from '../lib/alerts/notify';
  import { sounds } from '../lib/alerts/sounds';
  import { store } from '../lib/state.svelte';

  /** Reopens the setup dialog at its first step (App owns the dialog). */
  let { onsetup }: { onsetup: () => void } = $props();

  const COPIED_MS = 1500;

  /** The five health checks (R8.3) and what each says while it passes. */
  const CHECKS: { id: WarningId; label: string; ok: string }[] = [
    { id: 'server', label: 'Server', ok: 'Work Hours is running.' },
    { id: 'sound', label: 'Sound', ok: 'Sound is on.' },
    { id: 'notifications', label: 'Notifications', ok: 'Notifications are allowed.' },
    { id: 'away', label: 'Away detection', ok: 'Away detection is on.' },
    { id: 'discarded', label: 'Tab kept active', ok: "Chrome hasn't unloaded this tab." },
  ];

  /** The data folder and version, from /api/health. */
  let info = $state<{ dataDir: string; version: string } | 'failed' | null>(null);
  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  /** What the last Send test alert did, or null before the first one. */
  let testNote = $state<string | null>(null);

  /** The choice the user just made, until it is saved: the radios show it straight away. */
  let pendingCheckin = $state<CheckinMinutes | null>(null);
  /** The slider's value while it is being dragged and until it is saved. */
  let draftVolume = $state<number | null>(null);

  const checkin = $derived(pendingCheckin ?? store.state?.settings.checkinMinutes);
  const volume = $derived(draftVolume ?? store.state?.settings.volume ?? DEFAULT_SETTINGS.volume);

  onMount(() => {
    void health.refresh();
    api
      .getHealth()
      .then((h) => (info = { dataDir: h.dataDir, version: h.version }))
      .catch(() => (info = 'failed'));
  });

  onDestroy(() => clearTimeout(copiedTimer));

  // Each choice gets a number, so that when several are made in quick succession (holding an arrow
  // key on the slider, say) only the newest one lets go of the value shown.
  let checkinEdit = 0;
  let volumeEdit = 0;

  async function chooseCheckin(minutes: CheckinMinutes): Promise<void> {
    pendingCheckin = minutes;
    const mine = ++checkinEdit;
    try {
      if (await store.run(() => api.putSettings({ checkinMinutes: minutes }))) {
        await store.refresh();
      }
    } finally {
      if (mine === checkinEdit) {
        pendingCheckin = null;
      }
    }
  }

  /** While dragging: hear the new level on the next sound, but save only when the drag ends. */
  function dragVolume(input: HTMLInputElement): void {
    volumeEdit++;
    draftVolume = roundVolume(input.valueAsNumber);
    sounds.setVolume(draftVolume);
  }

  async function saveVolume(input: HTMLInputElement): Promise<void> {
    const value = roundVolume(input.valueAsNumber);
    draftVolume = value;
    const mine = ++volumeEdit;
    try {
      if (await store.run(() => api.putSettings({ volume: value }))) {
        await store.refresh();
      }
    } finally {
      if (mine === volumeEdit) {
        draftVolume = null;
        // If saving failed, the sounds go back to the saved level.
        sounds.setVolume(store.state?.settings.volume ?? value);
      }
    }
  }

  /** The slider's steps are 0.05, but floating point drifts. */
  function roundVolume(v: number): number {
    return Math.round(v * 100) / 100;
  }

  async function play(sound: 'chime' | 'alertTone'): Promise<void> {
    // These are clicks, so Chrome allows sound to start here.
    await sounds.unlock();
    sounds.setVolume(volume);
    sounds[sound]();
  }

  async function sendTestAlert(): Promise<void> {
    await sounds.unlock();
    sounds.setVolume(volume);
    sounds.alertTone();
    await notify.show('test', { title: 'Work Hours test alert', body: 'Alerts are working.' });
    testNote =
      notify.permission() === 'granted'
        ? 'Test alert sent.'
        : 'Notifications are off, so only the sound played.';
  }

  async function copyPath(dataDir: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(dataDir);
    } catch {
      // No clipboard access: the path is on the page to select.
      return;
    }
    copied = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied = false), COPIED_MS);
  }
</script>

<div class="settings">
  <h2 class="heading">Settings</h2>

  <section class="card" aria-labelledby="settings-checkin">
    <h3 id="settings-checkin" class="title">Check-in chime</h3>
    <p class="hint">While a timer runs and you're active, a soft chime plays every:</p>
    <div class="choices" role="radiogroup" aria-labelledby="settings-checkin">
      {#each CHECKIN_OPTIONS as minutes (minutes)}
        <label class="choice">
          <input
            type="radio"
            name="checkin"
            value={minutes}
            checked={checkin === minutes}
            onchange={() => chooseCheckin(minutes)}
          />
          {minutes} minutes
        </label>
      {/each}
    </div>
  </section>

  <section class="card" aria-labelledby="settings-volume">
    <h3 id="settings-volume" class="title">Volume</h3>
    <div class="slider">
      <input
        type="range"
        aria-labelledby="settings-volume"
        min={MIN_VOLUME}
        max={1}
        step={0.05}
        value={volume}
        oninput={(e) => dragVolume(e.currentTarget)}
        onchange={(e) => saveVolume(e.currentTarget)}
      />
      <span class="mono level">{Math.round(volume * 100)}%</span>
    </div>
    <div class="actions">
      <button type="button" class="btn" onclick={() => play('chime')}>Play chime</button>
      <button type="button" class="btn" onclick={() => play('alertTone')}>Play alert tone</button>
    </div>
    <p class="hint">Sounds can be lowered but not turned off.</p>
  </section>

  <section class="card" aria-labelledby="settings-alerts">
    <h3 id="settings-alerts" class="title">Alerts</h3>
    <ul class="checks">
      {#each CHECKS as check (check.id)}
        {@const warning = health.warnings.find((w) => w.id === check.id)}
        <li class="check" class:failing={warning !== undefined}>
          <span class="mark" role="img" aria-label={warning ? 'Warning' : 'OK'}>
            {warning ? '⚠' : '✓'}
          </span>
          <span class="label">{check.label}</span>
          <span class="detail">{warning ? warning.text : check.ok}</span>
        </li>
      {/each}
    </ul>
    <div class="actions">
      <button type="button" class="btn" onclick={onsetup}>Set up alerts</button>
      <button type="button" class="btn" onclick={sendTestAlert}>Send test alert</button>
    </div>
    {#if testNote}
      <p class="hint note" role="status">{testNote}</p>
    {/if}
  </section>

  <section class="card" aria-labelledby="settings-data">
    <h3 id="settings-data" class="title">Data</h3>
    {#if info === null}
      <p class="hint">Loading…</p>
    {:else if info === 'failed'}
      <p class="problem" role="alert">Couldn't read the data folder from the server.</p>
    {:else}
      {@const dataDir = info.dataDir}
      <p class="folder">Your data is in</p>
      <div class="path-row">
        <code class="mono path" data-testid="data-dir">{dataDir}</code>
        <button type="button" class="btn copy" onclick={() => copyPath(dataDir)}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p class="hint">
        A backup is made every day in <span class="mono">{dataDir}/backups</span>; the last 14 are
        kept.
      </p>
    {/if}
    <div class="actions export">
      <a class="btn" href={api.exportUrl('json')} download>Export JSON</a>
      <a class="btn" href={api.exportUrl('csv')} download>Export CSV</a>
    </div>
  </section>

  {#if info !== null && info !== 'failed'}
    <p class="version">Work Hours {info.version}</p>
  {/if}
</div>

<style>
  .settings {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-top: var(--space-5);
  }

  .heading {
    margin: 0 0 var(--space-1);
    font-size: 1rem;
    font-weight: 600;
  }

  .card {
    padding: var(--space-4) var(--space-5);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .title {
    margin: 0 0 var(--space-1);
    font-size: 1rem;
    font-weight: 600;
  }

  .hint {
    margin: var(--space-2) 0 0;
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .title + .hint {
    margin-top: 0;
  }

  .problem {
    margin: 0;
    color: var(--warning);
    font-size: 0.875rem;
    font-weight: 500;
  }

  /* Check-in */
  .choices {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-top: var(--space-3);
  }

  .choice {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 36px;
    padding: 0 var(--space-4) 0 var(--space-3);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }

  .choice:hover {
    background: var(--surface-2);
  }

  .choice:has(input:checked) {
    background: var(--surface-2);
    border-color: var(--text-muted);
  }

  .choice input {
    margin: 0;
    accent-color: var(--text);
    cursor: pointer;
  }

  /* Volume */
  .slider {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    margin-top: var(--space-3);
  }

  .slider input {
    flex: 1;
    min-width: 0;
    margin: 0;
    accent-color: var(--text);
    cursor: pointer;
  }

  .level {
    flex: none;
    min-width: 4ch;
    text-align: right;
    font-size: 0.875rem;
    font-weight: 500;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-top: var(--space-4);
  }

  /* Alerts */
  .checks {
    display: flex;
    flex-direction: column;
    margin: var(--space-2) 0 0;
    padding: 0;
    list-style: none;
  }

  .check {
    display: grid;
    grid-template-columns: 1.25rem 9.5rem 1fr;
    align-items: baseline;
    gap: var(--space-2);
    padding: var(--space-2) 0;
    font-size: 0.875rem;
  }

  .check + .check {
    border-top: 1px solid var(--border);
  }

  .mark {
    color: var(--running);
    font-weight: 700;
    text-align: center;
  }

  .label {
    font-weight: 600;
  }

  .detail {
    color: var(--text-muted);
  }

  .check.failing .mark,
  .check.failing .detail {
    color: var(--warning);
  }

  .check.failing .detail {
    font-weight: 500;
  }

  .note {
    margin-top: var(--space-3);
  }

  /* Data */
  .folder {
    margin: var(--space-2) 0 var(--space-2);
    font-size: 0.875rem;
  }

  .path-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .path {
    flex: 1;
    min-width: 0;
    padding: var(--space-2) var(--space-3);
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    font-size: 0.8125rem;
    overflow-wrap: anywhere;
    user-select: all;
  }

  .copy {
    flex: none;
    min-width: 5.5rem;
  }

  .hint .mono {
    font-size: 0.8125rem;
    overflow-wrap: anywhere;
  }

  .export a {
    text-decoration: none;
  }

  .version {
    margin: var(--space-2) 0 0;
    color: var(--text-muted);
    font-size: 0.8125rem;
    text-align: center;
  }

  @media (max-width: 520px) {
    .card {
      padding-inline: var(--space-4);
    }

    .check {
      grid-template-columns: 1.25rem 1fr;
    }

    .detail {
      grid-column: 2;
    }
  }
</style>
