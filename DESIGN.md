# Work Hours — Design

How Work Hours meets [REQUIREMENTS.md](REQUIREMENTS.md). Requirement IDs (R…, C…) refer to that file. Why things are this way, and the alternatives that were dropped, is recorded in [DECISIONS.md](DECISIONS.md).

## 1. Overview

```text
 Chrome tab (Svelte UI)                     Node server (Hono)                SQLite
┌──────────────────────────┐  JSON actions  ┌─────────────────────────┐      ┌──────────────────────┐
│ views and dialogs        │ ─────────────▶ │ tracker: all rules      │ ───▶ │ ~/.workhours/        │
│ alerts: sound, notifs    │ ◀───────────── │ presence and timers     │      │   workhours.db       │
│ away detection           │   SSE events   │ event broadcaster       │      │   backups/           │
│ service worker (sw.js)   │                └─────────────────────────┘      └──────────────────────┘
└──────────────────────────┘
```

Principles:

1. **The server is the single source of truth.** All rules live in `server/tracker`, and every action is one SQLite transaction. The browser only does three jobs: it shows the state, senses whether the user is present (away detection), and plays sounds and notifications.
2. **Time is never stored as a running counter.** It is stored as sessions with start and end timestamps, and totals are computed from them (R9.4).
3. **Never count time the user didn't work.** Automatic pauses are backdated to when the user left, and the user can add the time back with one click (R6).
4. **Reach the user in the background.** Use sound and system notifications. Never rely on the tab being visible (R7.1).

## 2. Stack

| Part | Choice | Why |
|---|---|---|
| Runtime | Node.js 24 or newer (long-term support until April 2028) | Built-in SQLite; user chose TypeScript on Node |
| Language | TypeScript 6.0 for server and UI, with shared API types (`shared/types.ts`) | One language. Not 7.0 yet: typescript-eslint and svelte-check don't support it, and it has no `tsserver` for the editor |
| HTTP server | Hono with `@hono/node-server` | Small; built-in Server-Sent Events helper (`streamSSE`) with disconnect detection (`onAbort`) |
| Database | `node:sqlite` (`DatabaseSync`) | Built into Node, nothing to compile; its synchronous API suits short transactions. Tested on SQLite 3.53 (Node 24.22). |
| UI | Svelte 5 and Vite | Small and reactive; well suited to ticking timers |
| Fonts | Geist and Geist Mono, from Fontsource npm packages | Bundled with the app, so no CDN and they work offline |
| Opening Chrome | `open` npm package (`apps.chrome`) | Opens Chrome specifically, on macOS, Windows and Linux |
| Tests | Vitest for unit and API tests; Playwright with Chrome for end-to-end tests | |
| Lint and format | ESLint (`typescript-eslint`, `eslint-plugin-svelte`) and Prettier (`prettier-plugin-svelte`) | Most mature Svelte support |
| Editor | VS Code settings and extension recommendations in `.vscode/` | Anyone opening the folder gets the same setup (§13) |

The server is compiled with `tsc` to `dist/`. It doesn't rely on Node running TypeScript directly, so no experimental-feature warnings appear.

## 3. Running the app

```text
$ workhours
Work Hours running at http://localhost:7420   (Ctrl+C to stop)
```

| Option | Default |
|---|---|
| `--port <n>` | `7420` |
| `--data <dir>` | `~/.workhours` |
| `--no-open` | Chrome is opened |
| `-h`, `--help` | Prints the options |
| `-v`, `--version` | Prints the version |

**Install:** `npm install && npm run build && npm link` puts `workhours` on the PATH on macOS, Windows and Linux.

**Startup sequence:**

1. If Node is older than 24, print `Work Hours needs Node.js 24 or newer (you have vX)` and exit (R10.4).
2. If the port is busy, call `GET /api/health` on it.
   - If it answers as Work Hours, open Chrome to it and exit (R10.2).
   - Otherwise print `Port 7420 is used by another program. Try --port.` and exit with an error.
3. Open the database, run migrations, take the daily backup (§12) and recover from a crash (§6.3).
4. Listen on `127.0.0.1:<port>`.
5. Open Chrome. If Chrome can't be found, print the URL with "Open this in Google Chrome".

**Shutdown** (Ctrl+C, SIGTERM, or the terminal window closing): pause the running project at that moment (an automatic pause with reason `stopped`), close the open connections, close the database (R10.3).

## 4. Data model

Times are stored as `INTEGER` milliseconds since the epoch, in UTC, and shown in local time. Schema version is tracked with `PRAGMA user_version`. Migrations are numbered `.sql` files.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE projects (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL CHECK (name = trim(name) AND length(name) BETWEEN 1 AND 100),
  status     TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_at INTEGER NOT NULL,
  closed_at  INTEGER
);
-- R1.2: unique across all projects, active and closed, ignoring case
CREATE UNIQUE INDEX uq_name ON projects(name COLLATE NOCASE);

-- One row per stretch of work
CREATE TABLE sessions (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,                         -- NULL = running now
  end_reason TEXT CHECK (end_reason IN
             ('switch','break','reset','close',                    -- user actions
              'tab_closed','sleep','stopped','locked','idle')),    -- automatic pauses
  CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX ix_sessions_project ON sessions(project_id, started_at);
-- R2.1: the database itself allows at most ONE running session
CREATE UNIQUE INDEX one_running ON sessions((ended_at IS NULL)) WHERE ended_at IS NULL;

-- R3: billing checkpoints, kept forever
CREATE TABLE resets (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  reset_at   INTEGER NOT NULL,
  minutes    INTEGER NOT NULL CHECK (minutes >= 1)   -- whole minutes entered in the client's system
);
CREATE INDEX ix_resets_project ON resets(project_id, reset_at);

-- R4: manual corrections
CREATE TABLE adjustments (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  created_at INTEGER NOT NULL,
  minutes    INTEGER NOT NULL CHECK (minutes <> 0),  -- positive adds, negative removes
  reason     TEXT    NOT NULL CHECK (reason = trim(reason) AND length(reason) BETWEEN 1 AND 200)
);
CREATE INDEX ix_adjustments_project ON adjustments(project_id, created_at);

-- R6: automatic pauses waiting for the user's choice
CREATE TABLE auto_pauses (
  session_id  INTEGER PRIMARY KEY REFERENCES sessions(id),  -- the session that was ended
  detected_at INTEGER NOT NULL,     -- when the app noticed (sessions.ended_at holds the backdated time)
  returned_at INTEGER,              -- when the user came back ("away 45m")
  resolution  TEXT CHECK (resolution IN ('counted','resumed','dismissed','withdrawn')),
  resolved_at INTEGER
);

-- Key/value: last_action (backdate window), last_alive_at, checkin_minutes (5|10|15, default 10), volume
CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

All of the constraints above were tested against `node:sqlite`. It rejects a name already used by any project (active or closed) in any letter case, 101-character names and a second running session. It accepts 100 emoji as 100 characters and lets a closed project be reopened. `VACUUM INTO` works.

**Name rules (R1.1, R1.2).** The app trims the name and counts characters as Unicode code points (`[...name].length` in JS, which matches SQLite's `length()`). It refuses line breaks and other control characters. The app checks for duplicates with `toLocaleLowerCase()`, which also handles non-English letters. The database index is the safety net, but `NOCASE` only folds English letters. If the name belongs to a closed project, the error offers **Reopen it** (§10.5).

**Derived values** (for a running session, `ended_at` is taken as now):

```text
session duration = ended_at − started_at
total_ms   = Σ session durations + Σ adjustments.minutes × 60 000
billed_ms  = Σ resets.minutes × 60 000
current_ms = total_ms − billed_ms
```

Defining Current as *total minus billed* makes the leftover seconds after a reset (R3.3) and adjustments (R4) work without special cases.

**Last pause (R2.6)** comes from the project's latest session (highest `id`): none if that session is running or the project has never run, otherwise its `ended_at` and `end_reason`. One exception: an automatic pause that was counted after another session had started now ends where that session started (`countAway`, §5), so it reads as `switch`. The stored `end_reason` keeps the automatic reason, for the record and the export.

## 5. Actions

Each action is one transaction in `server/tracker`. The current time (`now`) is passed in, so tests control the clock.

| Action | Steps | Rules |
|---|---|---|
| `addProject(name)` | Validate, insert | R1.1, R1.2 |
| `start(p)` | Resolve `p`'s pending automatic pauses as `resumed`. End the running session at `now` (reason `switch`), insert a session for `p` | Starting is the Resume choice (R6.3), so this happens however the project is started. Nothing else happens if `p` is already running |
| `pause()` | End the running session (reason `break`) | Does nothing if nothing is running |
| `backdate(at)` | See below | R2.5 |
| `reset(p)` | End `p`'s session if running (reason `reset`). `minutes = floor(current_ms / 60 000)`. Insert a resets row. Withdraw `p`'s pending automatic pauses. | `minutes ≥ 1` (R3.6) |
| `adjust(p, minutes, reason)` | Insert an adjustments row | `current_ms + minutes × 60 000 ≥ 0` (R4.3) |
| `close(p)` | End the session if running (reason `close`). Reset the whole minutes left, as `reset(p)` does. Set status to closed and `closed_at`. Withdraw pending automatic pauses. Return what was reset. | Under 1 minute, nothing is reset (R5.1) |
| `reopen(p)` | Set status to active, clear `closed_at` | Can't clash: closed projects keep their names reserved (R1.2, R5.4) |
| `autoPause(reason, at)` | End the running session at `at` (no earlier than its start) with `reason`. Insert an `auto_pauses` row. | Does nothing if nothing is running |
| `countAway(sessionId)` | If no session has started since, reopen this one (`ended_at`, `end_reason` set to NULL), so the timer carries on. Otherwise set `ended_at` to the start of the next session. Resolution: `counted`. If a reopened session is paused automatically again, its `auto_pauses` row is reused as a new pending notice. | R6.3 |
| `resumeAfterAway(sessionId)` | `start(project)`. Resolution: `resumed`. | |
| `dismissAway(sessionId)` | Resolution: `dismissed`. | |

**Backdate rules (R2.5).** Backdating only applies to the most recent Start, switch or Pause. The server checks that no other action has happened since, and the UI offers it for 30 seconds after the action (§10.4). The chosen time `T` must be in the past.

| Last action | Effect | Earliest allowed `T` |
|---|---|---|
| Switch A → B | `A.ended_at = T`, `B.started_at = T` | `A.started_at`, and no earlier than would take A's Current below zero (R4.3) |
| Pause A | `A.ended_at = T` | Same as for a switch |
| Start B, nothing was running | `B.started_at = T` | The latest `ended_at` of any session, so sessions never overlap. If no session has ever ended: 12 hours before the click |

`T` can be anywhere from the earliest time up to the click, so a backdate can be corrected by backdating again. The last action is kept in `app_meta.last_action`. Any other action that changes time (Reset, Adjust, Close, Reopen, an automatic pause, Count it or Dismiss on an away notice) ends the chance to backdate. Resume on an away notice starts the project, so it can be backdated like any Start, back as far as the pause.

## 6. Protecting the time record

Each check below can end the running session. Whichever fires first ends it, and the others find nothing running and do nothing.

| Situation | How it's detected | Ends the session at | Reason |
|---|---|---|---|
| Tab or Chrome closed | Live connection count drops to 0 and stays 0 for 60 s | Time of the last disconnect | `tab_closed` |
| Computer slept | Server's 15 s tick sees a clock jump of more than 60 s | The tick before the jump | `sleep` |
| Server stopped | Shutdown handler | Now | `stopped` |
| Server crashed or power loss | At startup, a session is still open | `last_alive_at` | `stopped` |
| Screen locked | Idle Detection API reports `screenState: locked` | Time of the lock | `locked` |
| Away with the screen unlocked | Idle Detection API reports `userState: idle` (threshold 10 min) | Time of the report − 10 min (last input) | `idle` |

### 6.1 Tab closed: the live connection

Every open tab holds `GET /api/events`, a Server-Sent Events stream (a connection that stays open so the server can push to the page). The server tracks open connections and sends a keep-alive comment every 15 s so dead connections get noticed.

When the count drops to 0 while a project is running, the server notes the time and waits 60 s. If no tab reconnects, it calls `autoPause('tab_closed', <disconnect time>)`. A page reload reconnects well within the 60 s and changes nothing. A Start that arrives while no tab is connected (from a notification button) starts the same 60 s wait. A closed tab says nothing about whether the user is at the computer, so the user counts as back only when the reopened tab first reports presence. That return raises the back-from-away alert (§7.2).

**Chrome's Memory Saver must be told to leave this tab alone.** Memory Saver unloads tabs that haven't been looked at for a while. For Work Hours this is worse than an ordinary close. The tab is what detects absence, plays sounds and shows notifications, so once it's unloaded the timer pauses (as `tab_closed`) and the app has no way to call the user.

The fix is a one-time setting: add `localhost:7420` (or the port in use) under `chrome://settings/performance` → "Always keep these sites active". The setup dialog (§8) and the README walk the user through it. If the tab is unloaded anyway, the page sees `document.wasDiscarded` when it next loads and shows a ⚠ warning pointing to the setting.

### 6.2 Sleep: a jump in the clock

The server ticks every 15 s and writes `last_alive_at` each time. If more than 60 s of wall-clock time passed since the previous tick, the process was suspended, meaning the computer slept. The session is ended as of the previous tick.

### 6.3 Server stopped or crashed

A clean stop pauses at the moment of stopping (§3). After a crash or power loss, the next startup finds a session still open and ends it at `last_alive_at`.

### 6.4 Away detection: Idle Detection API

The alert-leader tab (§7.1) runs Chrome's `IdleDetector` with a 10-minute threshold. It reports changes to `POST /api/presence`, sending `{ user: 'active'|'idle', screen: 'locked'|'unlocked', at }`.

- **Screen locked:** `autoPause('locked', at)`.
- **User idle:** `autoPause('idle', at − 10 min)`.
- **Active and unlocked again:** the server sets `returned_at` on pending automatic pauses and pushes a `returned` event. The page raises the alerts in §7.2.

The server keeps the latest presence in memory, because the check-in chime needs it. A restarted server starts with no presence, so the leader tab sends its current presence again whenever the live connection comes back. That is how a "Work Hours stopped" pause gets its back-from-away alert when the user is already at the computer.

## 7. Alerts and sounds

### 7.1 Channels

- **System notifications** are shown with `ServiceWorkerRegistration.showNotification` from `sw.js`. This is a standard JavaScript API; Chrome hands the notification to the operating system's own notification centre on macOS, Windows and Linux. No OS-specific code is needed.
  - **Buttons:** `actions` adds buttons. The service worker handles a button click by calling the server directly, so the tab doesn't need to open. On macOS, the buttons only show when the pointer is over the notification, behind an **Options** / **More** button. Clicking the notification itself opens the tab, and the away notice in its status bar (§10.3) offers the same choices.
  - **Staying on screen:** alerts set `requireInteraction: true`, which keeps them on screen on Windows and Linux. On macOS, Chrome's own documentation says not to rely on it. There, whether a notification stays is a per-app user setting in System Settings → Notifications: "Persistent" or "Temporary" ("Alerts" or "Banners" on older macOS). Setup and the README ask the user to set Chrome to Persistent.
  - **Replacing:** one `tag` per alert kind, so a new alert replaces the old one.
  - **Clicking the body** focuses the Work Hours tab.
- **Sounds** are generated with the Web Audio API, so no audio files are needed.
  - The **check-in chime** is two soft sine notes, under a second, with a gentle fade in and out.
  - The **alert tone** is three notes, slightly brighter but still gentle.
  - The exact sounds and the minimum volume are tuned after the user hears them.
  - **Waking the audio output.** Each sound starts with half a second of signal too quiet to hear (about −80 dBFS), and the notes follow it. After minutes of silence the audio output goes idle, and waking it can swallow the start of a short sound. Without the wake-up signal, Chrome played every check-in on time with its audio running, yet only some chimes came out of the speakers. With it, every chime came through.
- **One alert leader.** Only one tab plays sounds, shows notifications and runs away detection. It is chosen with the Web Locks API (`navigator.locks.request('workhours-alerts', …)`). If that tab closes, another takes over.

### 7.2 What triggers what

| Trigger | When the user is alerted | Sound | Notification |
|---|---|---|---|
| Automatic pause (sleep, locked, idle, stopped) | When the user is back: unlock, or input after being idle. Immediately if they are already active, for example after a wake. | Alert tone | "Acme Website auto-paused 14:02 · screen locked · away 45m" **[Count the 45m] [Resume]**. The time shows the day if it isn't today, as on the cards (§10.2). |
| Nothing running after a return | The user comes back from a break or absence and nothing is running. Again after 10 min if still active with nothing running. Then silent until the next break or absence. | Alert tone | "Nothing is running" **[Resume Acme Website]** |
| Server unreachable | The live connection has been down and `/api/health` has failed for 30 s | Alert tone | "Work Hours server isn't running" · "Time isn't being counted. Run workhours in a terminal to start it." Repeats every 5 min if a project was running. |
| Check-in | Every N minutes (5, 10 or 15; default 10) of a running session while the user is active | Chime | None (R7.6) |
| Sound blocked after a reload | No click or key press in the page within 1 minute | None | "Click in Work Hours to turn sound back on" |
| Tab closed | Nothing while the tab is closed. When the reopened tab first reports presence (§6.1), as for an automatic pause. | None in practice: a freshly loaded page has no sound until a click (§8) | As for an automatic pause. The status bar also shows the away notice (R7.5). |

If an automatic-pause alert and a nothing-running alert are both due on the same return, only the automatic-pause alert is shown, because it already offers Resume.

**Check-in timing is driven by the server.** The server pushes a `checkin` event every N minutes, counted from the start of the current session. Chrome slows down timers in background tabs, but it still delivers these pushed events promptly. The leader tab plays the chime only if the user is active.

**No mute (R7.7).** There is no mute control and no "off" setting. The interval can only be 5, 10 or 15 minutes. The volume slider stops at a minimum level.

## 8. Setup and permissions

**Welcome dialog** (first run, R8.1):

> **Work Hours keeps your time log accurate**
>
> **When you step away,** the running timer pauses at the moment you left. When you're back, a tone and a notification let you keep it paused, or count the time if you were away on project work.
>
> **While a timer runs,** a soft chime plays every 10 minutes. If you forgot to switch projects or pause, you can fix it right away.
>
> To do this, Work Hours needs sound, notifications, and permission to notice when you're away from your computer.
>
> **[ Set up alerts ]**

It then walks through four steps. Each step needs its own click, because Chrome asks for a fresh click before each permission prompt.

1. **Sound:** `AudioContext.resume()`, then play the chime and the alert tone.
2. **Notifications:** `Notification.requestPermission()`, then send a test notification and ask "Did it stay on screen until you clicked it?". If the answer is No, show the OS steps from the README: allow Chrome's notifications, set Chrome's style to Persistent on macOS, and check Focus / Do Not Disturb.
3. **Away detection:** `IdleDetector.requestPermission()`.
4. **Keep this tab active:** explain the Memory Saver setting (§6.1), give the exact address to add, and offer a **Done** button. Chrome gives pages no way to read this setting, so the app takes the user's word for it and relies on `document.wasDiscarded` as the safety net.

Each step after the welcome has **Skip**, which moves on to the next step; on the last step it closes the dialog. Closing the dialog in any way (**Done**, **Skip** on the last step, Esc) marks setup as done (a flag in the browser's local storage). Anything skipped shows as a warning (below), and clicking the warning reopens setup at that step.

**Every page load (R8.2).** Chrome blocks sound until the user clicks in the page. The status bar's `⚠ Sound is off. Click to turn on.` warning asks for that one click, and any click or key press anywhere also turns sound on. Sound is turned on after the click has done its job, not when the button goes down: turning it on removes the warning, and if the page shifted while the button was down the click would land on whatever moved under the pointer. Chrome remembers the notification and away-detection permissions, so they aren't asked again.

**Health check (R8.3).** The page keeps checking five things:

- notification permission is granted;
- away-detection permission is granted;
- sound is unlocked;
- the server is reachable;
- the tab wasn't unloaded by Memory Saver (`document.wasDiscarded`).

If any check fails, the status bar shows a ⚠ badge explaining what isn't protected, and the tab title starts with ⚠. The app keeps working.

**Unsupported browser (C2).** If `IdleDetector`, service workers or `Notification` are missing, the page shows "Work Hours needs Google Chrome", with the URL to copy.

## 9. API

Requests and responses are JSON, apart from the event stream and the CSV export. Every state change pushes a `state` event to all tabs (§9.1). Actions answer with the new `AppState` (adding a project with status 201), except Reset and Close, which answer with what they reset. A presence report answers 204 with no body, and saving settings answers with the settings. The types are in `shared/types.ts`, used by both server and UI. Errors answer `{ error: { code, message } }`: 400 for bad input, 404 for an unknown id, 409 when a rule refuses the action (for example `name_taken`, `too_little_time`, `would_go_negative`), 403 for a request to the wrong host and 415 for a state change that isn't JSON (§11).

| Method | Path | Does |
|---|---|---|
| GET | `/api/health` | `{ app: 'work-hours', version, dataDir }`, used by startup (§3), the health check and Settings |
| GET | `/api/state` | Everything the main view needs (below) |
| POST | `/api/projects` | Add `{ name }` |
| POST | `/api/projects/:id/start` | Start or switch |
| POST | `/api/pause` | Global pause |
| POST | `/api/backdate` | `{ at }` for the latest Start, switch or Pause |
| POST | `/api/projects/:id/reset` | Records the reset; returns `{ hours, minutes }` |
| POST | `/api/projects/:id/adjust` | `{ minutes, reason }` |
| POST | `/api/projects/:id/close` | Resets what's left, then closes; returns `{ reset: { hours, minutes } \| null }` |
| POST | `/api/projects/:id/reopen` | Reopen a closed project |
| GET | `/api/projects/closed` | Closed projects with totals and closed dates |
| GET | `/api/projects/:id/history` | Resets and adjustments |
| POST | `/api/presence` | `{ user, screen, at }` from away detection |
| POST | `/api/away/:sessionId` | `{ action: 'count' \| 'resume' \| 'dismiss' }` |
| GET / PUT | `/api/settings` | `{ checkinMinutes: 5 \| 10 \| 15, volume }` |
| GET | `/api/events` | Live event stream (§9.1) |
| GET | `/api/export?format=json\|csv` | JSON: all tables. CSV: reset history (project, date, hours, minutes). |

```ts
interface AppState {
  now: number;                     // server time; the page computes its clock offset from it
  running: { projectId: number; sessionId: number; startedAt: number } | null;
  paused: { since: number; reason: EndReason; lastProjectId: number | null } | null;  // nothing running; null id if that project is closed
  projects: {                      // active projects, in the order they were added
    id: number; name: string; createdAt: number;
    currentMs: number; totalMs: number;          // as of `now`
    lastPause: { at: number; reason: EndReason } | null;  // §4; null while running or never run
  }[];
  awayNotices: {                   // pending automatic pauses
    sessionId: number; projectId: number; projectName: string;
    reason: AutoReason; pausedAt: number; returnedAt: number | null;
    nextStartedAt: number | null;  // start of the next session, where Count ends; null if none (§10.3)
  }[];
  lastAction: { kind: 'start' | 'switch' | 'pause'; at: number; earliest: number } | null;
  settings: { checkinMinutes: 5 | 10 | 15; volume: number };
}
```

The page ticks timers itself, once a second, by adding the time elapsed since `now` to the running project. It doesn't poll the server.

### 9.1 Events (`/api/events`)

| Event | Meaning |
|---|---|
| `state` | Something changed; tabs fetch `/api/state` again |
| `autopause` | A new automatic pause is waiting for the user's choice |
| `returned` | The user is back (§6.4) |
| `checkin` | Time to play the chime |
| `: keep-alive` comment | Every 15 s, to detect dead connections |

## 10. UI

### 10.1 Visual style

- **Surfaces:** neutral backgrounds, rounded 12 px cards, generous spacing.
- **Colours:** one accent per meaning: green for running, amber for break or paused, red for warnings.
- **Fonts:** Geist for text, Geist Mono for timers. Timers use fixed-width digits so they don't jitter as they tick.
- **Themes:** light and dark, following the OS setting.

### 10.2 Main view (Active)

```text
┌──────────────────────────────────────────────────────────────┐
│  Work Hours                              Active   Closed  ⚙  │
├──────────────────────────────────────────────────────────────┤
│  [ New project name…                               + Add ]   │
│                                                              │
│  ┃ Acme Website                                  ● running   │  ← running: first
│  ┃ 01:42:17 current    38h 05m total        ❚❚    Reset  ⋯   │
│                                                              │
│    Data pipeline migration           paused 10:30 · switched │
│    00:55:03 current    12h 40m total        ▶     Reset  ⋯   │
│                                                              │
│    Blog redesign      ⏸ auto-paused 15:00 · screen locked    │
│    00:00:40 current     6h 10m total        ▶     Reset  ⋯   │
└──────────────────────────────────────────────────────────────┘
```

- **Running card:** a green left bar and a pulsing dot. Its button shows ❚❚, which is the same as the global Pause.
- **Paused card:** the top line shows when the project last stopped and why (R2.6, §4):

  | Last stop | Shows |
  |---|---|
  | Pause | `paused 12:30` |
  | Switch, or an automatic pause counted up to a later start | `paused 10:30 · switched` |
  | Reset while running | `paused 16:00 · reset` |
  | Close, then reopen | `paused 02 Oct · closed` |
  | Automatic pause | `⏸ auto-paused 15:00 · screen locked`, in amber, with the reason as in the away notice (§10.3) |
  | Never run | nothing |

  The time is `15:00` today, `yesterday 17:45`, `Mon 17:45` within the last week, and `02 Oct` (with the year if it isn't this year) before that. Hovering shows the full date and time. If the window is too narrow, the label moves under the project name.
- **⋯ menu:** Adjust time, History, Close project.
- **Card order (R1.4):** the running project's card comes first. While nothing runs, the card of the project on a break or paused automatically stays first. After a Reset or Close, or before anything has run, no card is pulled up. The rest stay in the order they were added, so a switch moves a card by at most one place. A card that changes place slides there, so it's clear where it went (no slide with reduced motion).
- **Status bar while running:** no running line on this view, since the first card shows the same name, timer and ❚❚. The status bar only appears for other pending away notices (§10.3) or ⚠ warnings.

**Status bar states:**

| State | Shows |
|---|---|
| Running, on the Active view | No line: the first card is the running one. Other pending away notices and ⚠ warnings still show, and without them there is no status bar. |
| Running, on Closed or Settings | `● Acme Website   01:42:17   [❚❚ Pause]` |
| On break | `On break since 12:30 · 42m   [▶ Resume Acme Website]` |
| Paused automatically, waiting for a choice | The away notice (§10.3) |
| Paused automatically, notice dismissed | `⏸ Auto-paused since 14:02 · screen locked · 45m   [▶ Resume Acme Website]` |
| Nothing running (never started, or the last stop was a Reset or Close) | `Nothing running. Start a project.` |
| Alerts not fully working | Adds a red ⚠ line, for example `⚠ Sound is off. Click to turn on.` Clicking it fixes the problem where the page can. |

Times are shown as on the cards. Together with the first card, the status bar is the one place at the top of the page that says what's happening: away notices are part of it (§10.3), not separate boxes.

### 10.3 Away notices

Pending automatic pauses are shown in the status bar until acted on (R6.4), mirroring the notification. While nothing is running, the pause of the project that ran last is the status line itself:

```text
┌──────────────────────────────────────────────────────────────────┐
│ ⏸ Acme Website auto-paused 14:02 · screen locked                 │
│                       [ ▶ Resume ]   [ Count the 45m ]   [ ✕ ]   │
└──────────────────────────────────────────────────────────────────┘
```

Any other pending pause (the user started another project, or more than one is waiting) is a row with Count and ✕ only, under the status line if there is one. While a project runs, the Active view has no status line (§10.2), so the rows are all the status bar shows:

```text
┌──────────────────────────────────────────────────────────────────┐
│ ⏸ Acme Website auto-paused 14:02 · screen locked                 │
│                                    [ Count the 52m ]   [ ✕ ]     │
└──────────────────────────────────────────────────────────────────┘
```

- **Count** says how much it adds: up to the start of the next session (`nextStartedAt`, §9), or up to now if nothing has started since, because the timer then carries on (§5). This can be more than the time away, so the notice shows only this one number.
- **Resume** is any start of the project: the notice's button, ▶ on its card, Space, 1–9, the status bar's Resume, or a notification (§5). So rows don't repeat it.
- **✕** is Dismiss. The status line then shows the plain automatic pause (§10.2).

### 10.4 Started earlier / Stopped earlier

After a Start, switch or Pause, a toast shows for 30 seconds:

```text
 Switched to Data pipeline at 14:11 · Started earlier?
```

Clicking it opens:

```text
 Actually started at  [ 14:03 ]   [ −5 min ]  [ −10 min ]   [ Save ]
```

For a Pause, the toast reads `Paused Acme Website at 14:11 · Stopped earlier?`.

The time box is a 24-hour `HH:MM` text field, like every other time in the app. It accepts `9:05`, `905` or `1403` and tidies them to `09:05` or `14:03`, and the arrow keys step it a minute at a time (ten with Shift). It isn't Chrome's time picker, which follows the browser's 12- or 24-hour setting and can't be changed by the page.

### 10.5 Dialogs

**Reset** (R3):

```text
┌ Reset Acme Website ───────────────────────────┐
│  Enter this in the client's system:           │
│                                               │
│   ┌──────┐            ┌──────┐                │
│   │  12  │ hours      │  34  │ minutes        │
│   └──────┘  [Copy]    └──────┘  [Copy]        │
│                                               │
│  The counter goes back to zero; leftover      │
│  seconds stay. Total time (38h 05m) is kept.  │
│                          [ Cancel ] [ Reset ] │
└───────────────────────────────────────────────┘
```

While the project is running, the boxes update live. Confirming records the minutes at that moment, and the boxes then show the recorded values to copy.

**Close** (R5.1), when 1 minute or more hasn't been reset:

```text
┌ Close Acme Website ───────────────────────────┐
│  Enter this in the client's system:           │
│                                               │
│   ┌──────┐            ┌──────┐                │
│   │   3  │ hours      │  12  │ minutes        │
│   └──────┘  [Copy]    └──────┘  [Copy]        │
│                                               │
│  Closing resets it first, then moves it to    │
│  Closed projects.                             │
│                [ Cancel ] [ Reset and close ] │
└───────────────────────────────────────────────┘
```

The boxes update live while the project runs, as in Reset. **Reset and close** records the reset and closes the project in one step. The dialog then shows the recorded values with "Recorded and closed." and **Done**, though the project has already left the active list. Under 1 minute there's nothing to reset: the dialog says "It moves to Closed projects." with **[Cancel] [Close project]**.

**Adjust time** (R4): `[ + | − ]  [ 30 ] minutes   Reason: [ … ]   [Save]`.

**Name already used** (R1.2): if the name belongs to an active project, the add box says "Acme Website already exists." If it belongs to a closed project, it says "A closed project is called Acme Website." and offers a **Reopen it** button.

### 10.6 Closed projects

```text
 Closed projects
 ───────────────────────────────────────────────────────────
 Blog redesign          closed 12 Nov 2026       46h 20m   ›
 Mobile app audit       closed 02 Oct 2026       18h 05m   ›
```

Expanding a row shows its history: resets (date · 12 h 34 min) and adjustments (date · +30 min · reason). It also has a **Reopen** button. Active projects open the same History view from their ⋯ menu.

### 10.7 Settings, tab title, shortcuts

- **Settings:**
  - check-in every 5, 10 or 15 minutes;
  - volume slider with a minimum level, with **Play chime** and **Play alert tone** buttons;
  - the alerts checklist (the five health checks, §8) with **Set up alerts** and **Send test alert** buttons;
  - data folder path, and where the daily backups go;
  - Export JSON and Export CSV;
  - the version.
- **Tab title:** `01:42 · Acme Website` while running, `On break · Work Hours` on break, starting with `⚠` when a health check fails.
- **Tab icon:** green dot while running, grey on break.
- **Keyboard:** `N` new project, `Space` pause/resume, `1`–`9` start the nth project in the order added, not the nth card on screen (R1.4, R11.2). The ▶ tooltip shows each card's number.

## 11. Security

- The server listens on `127.0.0.1` only (C4).
- Requests whose `Host` header isn't `localhost:<port>` or `127.0.0.1:<port>` are rejected. This blocks DNS-rebinding attacks, where an outside website tricks Chrome into treating its address as localhost.
- State changes must be `POST` or `PUT` with `Content-Type: application/json`. The server sends no CORS headers. Together, these stop other websites open in Chrome from calling the API.
- There is no login. Securing the computer is the user's job.

## 12. Data safety

- **Database settings:** WAL mode, foreign keys on and a busy timeout. Every action is one transaction.
- **Daily backup:** at startup, and on the first tick after midnight, if today's backup doesn't exist yet, run `VACUUM INTO '<data>/backups/workhours-YYYY-MM-DD.db'`. The newest 14 are kept.
- **Export:** JSON and CSV (§9).

## 13. Project layout and scripts

```text
(repo root)
├─ package.json            name: work-hours · bin: workhours → dist/server/cli.js · engines: { node: ">=24" }
├─ server/
│  ├─ cli.ts               options, Node version check, already-running check, open Chrome, shutdown
│  ├─ app.ts               Hono routes, serving the built UI, localhost guard
│  ├─ paths.ts             package root, version, built UI folder
│  ├─ db/                  index.ts, open.ts (pragmas), migrate.ts, migrations/001_init.sql, tx.ts, backup.ts
│  ├─ tracker/             actions and time maths; clock passed in; no I/O other than the db handle
│  ├─ presence.ts          live connections, tab-close grace period, sleep tick, check-in scheduler
│  └─ events.ts            event broadcast
├─ shared/types.ts         API types used by server and UI
├─ web/                    Svelte 5 + Vite
│  ├─ src/lib/             api.ts, state.svelte.ts (1 s ticker), format.ts, tab.ts and tab.svelte.ts
│  │                       (title, icon), history.ts, setup.ts, order.ts (card order)
│  ├─ src/lib/alerts/      leader.ts, sounds.ts, notify.ts, idle.ts (types in idle-detector.d.ts),
│  │                       health.svelte.ts, rules.ts (what to alert, unit-tested), engine.svelte.ts (when)
│  ├─ src/components/      StatusBar, ProjectCard, AddProject, ResetDialog, ResetAmount (the hours
│  │                       and minutes boxes, shared with Close), CloseDialog, AdjustDialog,
│  │                       BackdateToast, SetupDialog, ClosedList, History, HistoryDialog, Settings,
│  │                       Unsupported
│  └─ public/sw.js         notifications with buttons
├─ tests/                  unit/, api/, e2e/
├─ scripts/                copy-assets.mjs (migrations into dist, CLI made executable), e2e-server.mjs (fresh test data),
│                          screenshots.mjs (the README's screenshots, from made-up projects)
├─ playwright.config.ts    end-to-end tests in the installed Chrome
├─ .vscode/                extensions.json (recommended and unwanted extensions), settings.json
├─ docs/                   screenshot-light.png, screenshot-dark.png (the README's banner, from `npm run screenshots`)
├─ README.md               for users: install, run, one-time system settings, troubleshooting
├─ DECISIONS.md            why things are the way they are; spans requirements and design
├─ REQUIREMENTS.md
└─ DESIGN.md
```

| Script | Does |
|---|---|
| `npm run dev` | Runs the server with auto-restart (`tsx watch`) and the Vite dev server, which forwards `/api` to it |
| `npm run build` | Builds the UI into `dist/web` and compiles the server into `dist/server` |
| `npm start` | Runs the built server (`dist/server/cli.js`) |
| `npm test` | Unit and API tests |
| `npm run test:e2e` | Builds, then runs the Playwright tests in the installed Chrome |
| `npm run screenshots` | Builds, then retakes the README's light and dark screenshots in `docs/` (port 7499, throwaway database) |
| `npm run typecheck` | `tsc` for server, shared and tests; `svelte-check` for the UI |
| `npm run lint` | ESLint, plus Prettier in check mode |
| `npm run format` | Prettier, rewriting files |
| `npm link` | Installs the `workhours` command |

## 14. Testing

- **Tracker unit tests** (Vitest, in-memory `node:sqlite`, fake clock):
  - names: rules and uniqueness;
  - start, switch and pause;
  - reset minutes and leftover seconds;
  - adjustment limits;
  - close and reopen; closing resets the whole minutes left; adding a closed project's name is refused;
  - every backdate rule;
  - each automatic-pause reason and its backdated time;
  - Count it, with and without a later session;
  - crash recovery and sleep detection.
- **API tests:** the localhost guard, the JSON-only rule, events, and the tab-close grace period (connect, disconnect, reconnect within and after 60 s).
- **End-to-end tests** (Playwright in Chrome): the main flows, with permissions granted to the test browser. Away detection is simulated with the Chrome DevTools Protocol command `Emulation.setIdleOverride`.
  - They use the installed Google Chrome (`channel: 'chrome'`), so nothing extra is downloaded. `scripts/e2e-server.mjs` empties `.e2e-data` and starts the built server on port 7498, so each run starts from an empty database. Tests share that database and run one at a time.
  - Playwright's own API can't grant the away-detection permission, so `away.spec.ts` grants it with the DevTools protocol (`Browser.grantPermissions` with `idleDetection`, on a browser-level session with the page's `browserContextId`) and then drives the page's real `IdleDetector` with `Emulation.setIdleOverride`.
  - Headless Chrome doesn't reliably list notifications, so the tests record `showNotification` calls instead. How notifications look and stay on screen, how the sounds sound, the 10-minute idle threshold and the check-in timing are checked by hand (the last two also by server unit tests).
- **Manual checks on macOS:** real sleep, screen lock, Memory Saver unloading the tab, how notifications look, and how the sounds sound.

## 15. Milestones

1. **Skeleton:** package and scripts, Hono server, `node:sqlite` with migration 001, the CLI (options, version check, opening Chrome, localhost guard), and the Svelte app with fonts and theme.
2. **Tracker logic and unit tests:** every action in §5, with automatic pauses and Count it.
3. **API and events:** endpoints, live connections and tab-close grace period, sleep tick, crash recovery, check-in scheduler.
4. **Active view:** status bar, cards, add project, Reset and Close dialogs, Started/Stopped-earlier toast, away notices, tab title and icon, shortcuts.
5. **Alerts:** welcome and setup dialog, sounds, service-worker notifications with buttons, away detection, alert leader, health warnings (including the "Sound is off" prompt), unsupported-browser page.
6. **The rest of v1:** Closed view, History, Reopen, Adjust time, Settings, export, daily backups.
7. **Finish:** end-to-end tests, bring README.md in line with the finished app, tune the sounds and minimum volume with the user.

## 16. Open items

- The exact sounds, and the minimum volume: set with the user after testing.
- Windows and Linux are untested. On Linux, check Chrome's away detection on Wayland desktops.
- On the user's macOS version, confirm which Notifications entries Chrome uses ("Google Chrome", and possibly "Google Chrome Helper (Alerts)") and what the style options are called. Then correct the README if needed.
