<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { health } from '../lib/alerts/health.svelte';
  import { idle } from '../lib/alerts/idle';
  import { notify } from '../lib/alerts/notify';
  import { sounds } from '../lib/alerts/sounds';
  import { MEMORY_SAVER_URL, STEP_COUNT, markSetupComplete } from '../lib/setup';
  import type { SetupStep } from '../lib/setup';

  /** Time between the chime and the alert tone in step 1. */
  const TONE_GAP_MS = 1200;
  const COPIED_MS = 1500;

  const TITLES: Record<SetupStep, string> = {
    0: 'Work Hours keeps your time log accurate',
    1: 'Sound',
    2: 'Notifications',
    3: 'Away detection',
    4: 'Keep this tab active',
  };

  /** `initialStep` skips the welcome screen when a warning reopens the dialog at one step. */
  let { initialStep = 0, onclosed }: { initialStep?: SetupStep; onclosed: () => void } = $props();

  let dialog = $state<HTMLDialogElement>();
  let step = $state<SetupStep>(0);

  /** Step 1: 'playing' while the two sounds play; 'failed' if Chrome kept sound off. */
  let sound = $state<'start' | 'playing' | 'done' | 'failed'>('start');
  /**
   * Step 2: 'asked' is the test notification showing, with the question about it waiting.
   * 'dismissed' is a permission prompt closed without an answer.
   */
  let notifications = $state<
    'start' | 'asking' | 'asked' | 'stayed' | 'vanished' | 'denied' | 'dismissed'
  >('start');
  /** Step 3. */
  let away = $state<'start' | 'asking' | 'granted' | 'denied' | 'dismissed' | 'unsupported'>(
    'start',
  );
  let copied = $state<'address' | 'link' | null>(null);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  const host = location.host;

  const soundSettled = $derived(sound === 'done' || sound === 'failed');
  const notificationsSettled = $derived(
    notifications === 'stayed' ||
      notifications === 'vanished' ||
      notifications === 'denied' ||
      notifications === 'dismissed',
  );
  const awaySettled = $derived(away !== 'start' && away !== 'asking');

  onMount(() => {
    step = initialStep;
    dialog?.showModal();
    focusPrimary();
  });

  onDestroy(() => clearTimeout(copiedTimer));

  /** Puts the focus on the button that moves on, since the buttons change with every step. */
  async function focusPrimary(): Promise<void> {
    await tick();
    dialog?.querySelector<HTMLElement>('.btn-primary:not(:disabled)')?.focus();
  }

  async function go(next: SetupStep): Promise<void> {
    void notify.close('test');
    step = next;
    copied = null;
    await focusPrimary();
  }

  function next(): void {
    if (step === STEP_COUNT) {
      dialog?.close();
    } else {
      void go((step + 1) as SetupStep);
    }
  }

  /** Any way of closing the dialog (Done, Skip on the last step, Esc) counts as having been asked. */
  function closed(): void {
    void notify.close('test');
    markSetupComplete();
    void health.refresh();
    onclosed();
  }

  function pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function turnOnSound(): Promise<void> {
    sound = 'playing';
    // Unlocking has to happen first: sounds are silent until then.
    if (!(await sounds.unlock())) {
      sound = 'failed';
      void focusPrimary();
      return;
    }
    sounds.chime();
    await pause(TONE_GAP_MS);
    sounds.alertTone();
    sound = 'done';
    void focusPrimary();
  }

  async function allowNotifications(): Promise<void> {
    notifications = 'asking';
    const result = await notify.requestPermission();
    void health.refresh();
    if (result === 'granted') {
      notifications = 'asked';
      void notify.show('test', {
        title: 'Work Hours notifications work',
        body: 'Did this stay on screen until you clicked it?',
      });
    } else {
      notifications = result === 'denied' ? 'denied' : 'dismissed';
    }
    void focusPrimary();
  }

  function answer(stayed: boolean): void {
    notifications = stayed ? 'stayed' : 'vanished';
    void notify.close('test');
    void focusPrimary();
  }

  async function allowAway(): Promise<void> {
    away = 'asking';
    // Not idle.start(): only the leader tab runs the detector, and it starts by itself when it
    // sees the permission granted.
    const result = await idle.requestPermission();
    void health.refresh();
    if (result === 'granted') {
      away = 'granted';
    } else if (result === 'unsupported') {
      away = 'unsupported';
    } else {
      away = result === 'denied' ? 'denied' : 'dismissed';
    }
    void focusPrimary();
  }

  async function copy(what: 'address' | 'link'): Promise<void> {
    try {
      await navigator.clipboard.writeText(what === 'address' ? host : MEMORY_SAVER_URL);
    } catch {
      // No clipboard access: the text is on the page to select.
      return;
    }
    copied = what;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied = null), COPIED_MS);
  }
</script>

<dialog bind:this={dialog} class="dialog setup" aria-labelledby="setup-title" onclose={closed}>
  {#if step > 0}
    <p class="step">Step {step} of {STEP_COUNT}</p>
  {/if}
  <h2 id="setup-title" class="title">{TITLES[step]}</h2>

  {#if step === 0}
    <p>
      <strong>When you step away,</strong> the running timer pauses at the moment you left. When you're
      back, a tone and a notification let you keep it paused, or count the time if you were away on project
      work.
    </p>
    <p>
      <strong>While a timer runs,</strong> a soft chime plays every 10 minutes. If you forgot to switch
      projects or pause, you can fix it right away.
    </p>
    <p>
      To do this, Work Hours needs sound, notifications, and permission to notice when you're away
      from your computer.
    </p>
    <div class="actions">
      <button type="button" class="btn btn-primary" onclick={() => go(1)}>Set up alerts</button>
    </div>
  {:else if step === 1}
    <p>You'll hear the soft check-in chime, then the alert tone.</p>
    {#if sound === 'done'}
      <p class="ok" role="status">✓ Sound is on.</p>
    {:else if sound === 'failed'}
      <p class="problem" role="status">
        Chrome didn't turn sound on. Try again, and check that this tab isn't muted.
      </p>
    {/if}
    <div class="actions">
      <button type="button" class="link" onclick={next}>Skip</button>
      <button
        type="button"
        class="btn"
        class:btn-primary={!soundSettled}
        disabled={sound === 'playing'}
        onclick={turnOnSound}
      >
        {sound === 'playing' ? 'Playing…' : soundSettled ? 'Play again' : 'Turn on sound'}
      </button>
      {#if soundSettled}
        <button type="button" class="btn btn-primary" onclick={next}>Next</button>
      {/if}
    </div>
  {:else if step === 2}
    <p>
      Alerts appear as system notifications, so you see them when Chrome is in the background.
      Chrome will ask first, and then Work Hours sends a test.
    </p>

    {#if notifications === 'asked'}
      <p class="question" role="status">Did it stay on screen until you clicked it?</p>
    {:else if notifications === 'stayed'}
      <p class="ok" role="status">✓ Notifications work.</p>
    {:else if notifications === 'vanished'}
      <div class="help" role="status">
        <p>Then the system is hiding it. These settings make notifications wait for you:</p>
        <ul>
          <li>
            <strong>macOS:</strong> System Settings → Notifications → Google Chrome → Allow
            notifications, with the style set to <strong>Persistent</strong> (<strong>
              Alerts
            </strong>
            on older macOS). If there is also <strong>Google Chrome Helper (Alerts)</strong>, set
            that one too.
          </li>
          <li>
            <strong>Windows:</strong> Settings → System → Notifications → turn on Google Chrome.
          </li>
          <li>
            <strong>Linux:</strong> allow notifications from Chrome in your desktop's settings.
          </li>
          <li>Check that Focus or Do Not Disturb isn't on.</li>
        </ul>
      </div>
    {:else if notifications === 'denied'}
      <div class="help" role="status">
        <p>
          Chrome has notifications blocked for this site, so Work Hours can't ask again. To allow
          them, click the icon to the left of the address bar → Site settings → Notifications →
          Allow.
        </p>
      </div>
    {:else if notifications === 'dismissed'}
      <p class="problem" role="status">
        Chrome didn't get an answer. Try again, or skip this step.
      </p>
    {/if}

    <div class="actions">
      <button type="button" class="link" onclick={next}>Skip</button>
      {#if notifications === 'asked'}
        <button type="button" class="btn" onclick={() => answer(false)}>No</button>
        <button type="button" class="btn btn-primary" onclick={() => answer(true)}>Yes</button>
      {:else}
        {#if notifications === 'start' || notifications === 'asking' || notifications === 'dismissed'}
          <button
            type="button"
            class="btn btn-primary"
            disabled={notifications === 'asking'}
            onclick={allowNotifications}
          >
            Allow notifications
          </button>
        {/if}
        {#if notificationsSettled}
          <button
            type="button"
            class="btn"
            class:btn-primary={notifications !== 'dismissed'}
            onclick={next}
          >
            Next
          </button>
        {/if}
      {/if}
    </div>
  {:else if step === 3}
    <p>
      Chrome will ask whether Work Hours may know when you're using your device. It only learns
      whether you're active and whether the screen is locked.
    </p>
    {#if away === 'granted'}
      <p class="ok" role="status">✓ Away detection is on.</p>
    {:else if away === 'denied'}
      <div class="help" role="status">
        <p>
          Chrome has this blocked for this site, so Work Hours can't ask again. To allow it, click
          the icon to the left of the address bar → Site settings → Device use → Allow. Until then
          the timer won't pause when you leave.
        </p>
      </div>
    {:else if away === 'dismissed'}
      <p class="problem" role="status">
        Chrome didn't get an answer. Try again, or skip this step.
      </p>
    {:else if away === 'unsupported'}
      <p class="problem" role="status">
        This browser can't detect when you're away. Work Hours needs Google Chrome.
      </p>
    {/if}
    <div class="actions">
      <button type="button" class="link" onclick={next}>Skip</button>
      {#if away === 'start' || away === 'asking' || away === 'dismissed'}
        <button
          type="button"
          class="btn btn-primary"
          disabled={away === 'asking'}
          onclick={allowAway}
        >
          Allow away detection
        </button>
      {/if}
      {#if awaySettled}
        <button type="button" class="btn" class:btn-primary={away !== 'dismissed'} onclick={next}>
          Next
        </button>
      {/if}
    </div>
  {:else}
    <p>
      Chrome's Memory Saver unloads tabs you haven't looked at for a while. If it unloads this one,
      the timer pauses and Work Hours can no longer alert you. Tell Chrome to leave it alone, once:
    </p>
    <ol class="memory">
      <li>
        <span>
          Open <code>{MEMORY_SAVER_URL}</code> in a new tab.
        </span>
        <button type="button" class="btn copy" onclick={() => copy('link')}>
          {copied === 'link' ? 'Copied' : 'Copy settings link'}
        </button>
      </li>
      <li>
        <span>
          Find <strong>Always keep these sites active</strong> and click <strong>Add</strong>.
        </span>
      </li>
      <li>
        <span>
          Enter <code>{host}</code> and confirm.
        </span>
        <button type="button" class="btn copy" onclick={() => copy('address')}>
          {copied === 'address' ? 'Copied' : 'Copy address'}
        </button>
      </li>
    </ol>
    <p class="note">
      Chrome doesn't let a page see this setting, so Work Hours takes your word for it. If Chrome
      unloads the tab anyway, you'll see a warning the next time it opens.
    </p>
    <div class="actions">
      <button type="button" class="link" onclick={next}>Skip</button>
      <button type="button" class="btn btn-primary" onclick={next}>Done</button>
    </div>
  {/if}
</dialog>

<style>
  .setup {
    width: min(520px, calc(100vw - 2 * var(--space-4)));
  }

  .step {
    margin: 0 0 var(--space-1);
    color: var(--text-muted);
    font-size: 0.8125rem;
    font-weight: 500;
  }

  .title {
    margin: 0 0 var(--space-3);
    font-size: 1.125rem;
    font-weight: 600;
  }

  p {
    margin: 0 0 var(--space-3);
  }

  .ok {
    color: var(--running);
    font-weight: 600;
  }

  .problem {
    color: var(--warning);
    font-size: 0.875rem;
    font-weight: 500;
  }

  .question {
    font-weight: 600;
  }

  .help {
    margin-bottom: var(--space-3);
    padding: var(--space-3) var(--space-4);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 0.875rem;
  }

  .help p:last-child {
    margin-bottom: 0;
  }

  .help ul {
    margin: 0;
    padding-left: var(--space-4);
  }

  .help li + li {
    margin-top: var(--space-2);
  }

  .memory {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin: 0 0 var(--space-3);
    padding-left: var(--space-5);
  }

  .memory li {
    padding-left: var(--space-1);
  }

  .memory span {
    display: block;
  }

  .copy {
    min-height: 32px;
    margin-top: var(--space-2);
    padding: 0 var(--space-3);
    font-size: 0.8125rem;
  }

  code {
    padding: 1px var(--space-1);
    background: var(--surface-2);
    border-radius: 4px;
    font-family: var(--font-mono);
    font-size: 0.875em;
    overflow-wrap: anywhere;
  }

  .note {
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-5);
  }

  /* Skip is a quiet link on the left, away from the buttons that move on. */
  .link {
    margin-right: auto;
    padding: var(--space-1) 0;
    color: var(--text-muted);
    background: none;
    border: none;
    text-decoration: underline;
    cursor: pointer;
  }

  .link:hover {
    color: var(--text);
  }
</style>
