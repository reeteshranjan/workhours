# Work Hours — Decisions

The reasons behind Work Hours' requirements and design. Each row records what was decided, what was considered and dropped, and why. These decisions were made during planning in November 2026.

**Where** points to the affected requirements (R…, C… in [REQUIREMENTS.md](REQUIREMENTS.md)) and design sections (§… in [DESIGN.md](DESIGN.md)). When a decision changes:

1. update its row here, keeping the old choice under "considered and dropped" with the reason it changed;
2. update every requirement and design section listed in **Where**.

## Scope and platform

| Topic | Decided | Considered and dropped (why) | Where |
|---|---|---|---|
| Platform | Local web app: a server on the user's computer, used in Chrome | Desktop apps for macOS, Windows and Linux plus a web version, built with Tauri 2 (first plan). The user narrowed the scope to a simple web app with data in the backend. | C1 · §1, §3 |
| Where data lives | SQLite on the server | SQLite inside the browser (WASM, browser storage): the data would be stuck in one browser | C1, R9.1 · §4, §12 |
| Backend language | TypeScript on Node | Go single binary: the user prefers one language | C3 · §2 |
| SQLite driver | `node:sqlite`, built in | `better-sqlite3`: a native module that has to be compiled. The Tauri SQL plugin (first plan): unreliable transactions. | C6 · §2 |
| Browser support | Chrome only | Safari and Firefox lack away detection and notification buttons. A strict requirement is acceptable for accurate tracking. | C2 · §8 |
| Access | This computer only, no login | Access from other devices with a login: not needed for one developer | C4 · §11 |
| OS integration | None | Autostart at login, menu bar or tray timer, reading OS idle time (`ioreg`): the user's rule is no system bindings | C5 · §3, §6.4 |
| Install and run | `workhours` command via `npm link`, port 7420, data in `~/.workhours` | An app bundle in `~/Applications` (no longer a desktop app) | R10.1, R9.1 · §3 |
| TypeScript version | 6.0 | 7.0, the native compiler (`latest` on npm since late 2026): typescript-eslint (needs <6.1) and svelte-check (needs 5 or 6) don't support it yet, and it ships no `tsserver` for VS Code. Revisit when they do. | §2 |
| Lint and format | ESLint and Prettier, with their Svelte plugins | Oxc (Oxlint and its formatter): Svelte support less mature. Running both sets side by side: conflicting fixes. | §2, §13 |
| Editor setup | `.vscode/` in the project: recommended and unwanted extensions, format on save, the project's own TypeScript | Leaving editor setup to each person: errors in the editor could differ from the build | §2, §13 |

## Tracking and billing

| Topic | Decided | Considered and dropped (why) | Where |
|---|---|---|---|
| Project names | Unique across all projects, active and closed, ignoring case. A closed project is reopened, not re-created. | Unique among active projects only, with a rename on reopen (dropped: closed projects can be reopened, so their names stay reserved). Allowing duplicates. | R1.2, R5.4 · §4, §5, §10.5 |
| Resume after a break | Offered for the last project. The user can ignore it and start any other project, since a break can come in the middle of a project. | — | R2.2 · §10.2 |
| When each project last stopped | Every paused card shows the time and reason of its last stop, with automatic pauses marked and in amber. The status bar's break line also shows when the break began. Added after the first build, to avoid confusion about why a project's time stopped where it did. | The status bar alone: it shows only the most recent stop. The away notice alone: it disappears after Dismiss. Naming the project switched to (`switched to Blog`): longer, and that project's own card already shows it. Rewriting the stored reason of a counted pause to `switch`: the export would lose why the app paused it. | R2.2, R2.6 · §4, §9, §10.2 |
| Card order | The running project's card comes first. While nothing runs, the project on a break or paused automatically stays first, since it's the one expected to carry on. The rest keep the order they were added. A card that moves slides to its new place. `1`–`9` count in the order added, so a key always starts the same project. | All cards in the order added, never moving (first build): in a long list the running card could be off screen, so the status bar repeated it. `1`–`9` by screen position: every switch would renumber the cards, and `1` would always be the project already running. Putting the card back in its place on Pause: it would move twice for every break. | R1.4, R11.2 · §10.2, §10.7 |
| Status bar while a project runs | No running line on the Active view, where the first card shows the same name, timer and ❚❚. The bar shows only other pending away notices and ⚠ warnings, and isn't there without them. On Closed and Settings, which have no cards, it keeps the running line with Pause. | The running line on every view (first build): on the Active view it repeated the running card, and the tab title showed it a third time. | R1.4 · §10.2, §10.3 |
| Fixing a forgotten switch | Started/Stopped earlier right after the action, plus Adjust time | Adjust time only, which needs two edits for a switch | R2.5, R4 · §5, §10.4 |
| Time box in Started/Stopped earlier | A 24-hour `HH:MM` text field with arrow-key stepping | Chrome's `<input type="time">`: it shows 12-hour times ("04:56 PM") on many machines, unlike the rest of the app, and a page can't switch it to 24-hour | R2.5 · §10.4 |
| Limits on Started/Stopped earlier | Can't take the project losing the minutes below zero Current. A first-ever Start can go back at most 12 hours. It can be redone until another action changes time. | No Current check: an Adjust followed by a backdated Pause could make Current negative, which R4.3 forbids. No limit on a first-ever Start. | R2.5 · §5 |
| Reset confirmation | Added; it shows the amount to copy | No confirmation (the original spec only confirmed Close) | R3.2 · §10.5 |
| Reset amount format | Separate hours and minutes boxes, matching the client's system; leftover seconds stay on the counter | Decimal hours (12.57 h); rounding to the nearest minute; dropping the seconds | R3.2, R3.3 · §4, §10.5 |
| Closing with time not yet reset | Close resets it first, in the same step and one transaction. The dialog shows the hours and minutes to copy, and stays open after the close to show them. Time that shouldn't be billed is removed with Adjust time first, which records why. | A warning in the Close dialog (first build): the user had to cancel, reset, then close again. A Close without resetting button: unbilled time could slip into Closed projects unnoticed. Reset, then Close, as two requests: a failure between them could leave the project reset but still open, and its stop would read `reset`, not `closed`. | R5.1 · §5, §9, §10.5 |
| v1 extras | Adjust time, Reopen closed projects | — | R4, R5.4 · §5 |

## Protecting the time record and alerts

| Topic | Decided | Considered and dropped (why) | Where |
|---|---|---|---|
| Default when the user leaves | Stop at the moment they left; one click to count it | A "Keep or Discard?" prompt that kept counting until answered: risked billing time not worked | R6.2, R6.3 · §6 |
| Detecting a closed tab | Live connection plus a 60 s grace period | A ping from the page every 15 s: Chrome slows background-tab timers to once a minute, so pings would arrive late | R6.1 · §6.1 |
| Getting alerts to the user | System notifications and sound, sent when the user comes back | A banner in the page: the tab is almost always in the background, and an alert sent at the moment the user leaves goes unseen | R7.1, R7.2 · §7 |
| Check-in | Sound only; every 10 min by default; options 5, 10 or 15 | A notification with each check-in (too distracting); a 5-minute default; an "off" option | R7.6 · §7.2 |
| Muting | None; volume has a minimum | A mute toggle: the chime and alerts are the app's core job | R7.7 · §7.2 |
| Waking the audio output | Each sound starts with half a second of inaudible signal (about −80 dBFS), then the notes | Playing the notes straight away: after minutes of silence the idle audio output swallowed some chimes, even though Chrome played every one on time. Keeping an inaudible signal playing all the time: keeps the audio output busy all day for one sound every 5–15 minutes. | R7.6, R7.8 · §7.1 |
| Check-in rhythm | Counted from the start of each session, so a start, switch or resume restarts it | A steady rhythm across switches: a switch is already the check-in the chime asks for, so no reminder is due right after one. Confirmed with the user after a test showed gaps of up to twice the interval after switches. | R7.6 · §7.2 |
| Chrome Memory Saver | A required one-time exception for `localhost:<port>`: setup step 4, the README, and a warning if the tab was unloaded anyway | Treating it as an optional tip: an unloaded tab silently stops all alerts | R8.5 · §6.1, §8 |
| Notifications staying on screen (macOS) | Ask the user to set Chrome's notification style to Persistent | Relying on `requireInteraction`, which Chrome says not to rely on for macOS | R7.2 · §7.1 |
| When a closed tab counts as "back" | When the reopened tab first reports presence. That return raises the usual back-from-away notification; its tone stays silent, because Chrome blocks sound on a freshly loaded page until a click. | Using the presence the closed tab last reported: it would mark the user back about 60 s after the pause, and offer to count about a minute, not the real time away. No alert on reopen, only the notice in the page (as first written): when Chrome restores the tab in the background, nothing would say the timer had stopped. | R6.3, R7.2, R7.5 · §6.1, §7.2 |
| Presence after a server restart | The leader tab sends its presence again whenever the live connection comes back | Waiting for the next active/idle change: a "Work Hours stopped" pause would get no back-from-away alert while the user sits at the computer | R6.3, R7.2 · §6.4 |
| Turning sound on after a reload | On any click or key press, after the click has done its job. The status bar's `⚠ Sound is off. Click to turn on.` warning is the one-click prompt. | Turning it on when the mouse button goes down: the "Sound is off" warning vanishes mid-click, the page shifts, and the click lands on the wrong control. A floating card: it covered the header buttons at some window widths. A **Resume alerts** banner under the status bar (first build): it said the same thing as the ⚠ warning, in the amber that means paused. | R8.2 · §8, §10.2 |
| Where away notices show | In the status bar. While nothing runs, the pause of the project that ran last is the status line itself, with Resume, Count and ✕. Other pending pauses are rows with Count and ✕, under the status line if there is one. | A separate banner under the status bar (first build): with the status line and the card's label, one pause was described three times down the page, with two Resume buttons that did different things. | R6.3, R6.4, R7.5 · §7.1, §7.2, §10.2, §10.3 |
| Starting a project that has a pending away notice | Counts as Resume: the notice is resolved and the time away isn't counted. For 30 seconds, "Started earlier?" can still move the start back to the pause. Later, Adjust time can add the minutes. | Leaving the notice pending (first build): only the banner's Resume resolved it, so after ▶, Space or the status bar's Resume the page kept offering Resume for a running project. | R6.3 · §5, §10.3 |
| The amount on the page's Count button | What Count will add: up to the next session's start, or up to now when the timer will carry on (`nextStartedAt`) | The time away (first build): it understated what Count adds once the user had been back a while or had started another project. Showing both the time away and the amount: two different numbers for one choice. The notification keeps the time away, which is what Count adds at the moment it's sent. | R6.3 · §9, §10.3 |
| Words for an automatic pause | "auto-paused" with ⏸ in amber everywhere (status bar, card, notification). "paused" and "On break" are for the user's own stops. Times show the day when it isn't today. | "Paused at 21:44" in the status bar and "paused at 21:44" in the banner (first build): they didn't say the app did it, and showed no day after a pause the day before. | R2.6 · §7.2, §10.2, §10.3 |
| Skipping setup | Closing the setup dialog in any way marks it done; skipped steps show as warnings that reopen setup at that step | Showing setup again on every load until everything is granted: nagging, and Chrome gives no way to confirm the Memory Saver step anyway | R8.1, R8.3 · §8 |
| Showing the data folder | `GET /api/health` also returns `dataDir` | A separate `/api/info` endpoint for one value | R8.4 · §9 |

## Documentation

| Topic | Decided | Considered and dropped (why) | Where |
|---|---|---|---|
| User-facing documentation | README.md covers everything a user must know or set up | Leaving setup to the in-app dialog alone: some settings are outside Chrome and need written steps | R12.1 · [README.md](README.md) |
| Decision record | This separate file, since decisions span requirements and design | A section at the end of DESIGN.md | — |
