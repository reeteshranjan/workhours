# Work Hours — Requirements

What Work Hours must do, and the constraints it works under. How it does it is in [DESIGN.md](DESIGN.md), and why things are the way they are is in [DECISIONS.md](DECISIONS.md).

## Purpose

Work Hours tracks time for a developer who works on several client projects in parallel and keeps switching across them. It keeps an accurate time record per project for billing purpose.

## A typical day

| Time | What happens |
|---|---|
| 09:00 | Start **Acme Website**. |
| 10:30 | Acme waits on a code review. Click Start on **Data pipeline**; Acme pauses at the same moment. |
| 11:20 | The check-in chime plays. You realise you've been on the blog for 5 minutes, so you switch to **Blog** and use **Started earlier?** to move those minutes over. |
| 12:30 | Lunch: press **Pause**. |
| 13:15 | Back at the keyboard. A tone and a notification say nothing is running, with **Resume Data pipeline**. |
| 15:00 | Lock the screen for a walk. The timer stops as of 15:00. On return, a notification offers **Count the 40m** or **Resume**. |
| Friday | Reset Acme: copy **12** hours and **34** minutes into the client's system. Acme's counter goes back to zero; its total is kept. |

## Constraints

| ID | Constraint |
|---|---|
| C1 | A local web app: a server running on the user's computer, used in a browser. All data lives in the server's SQLite database. |
| C2 | Google Chrome only. Other browsers get a page asking the user to open Work Hours in Chrome. |
| C3 | Node.js 24 or newer. |
| C4 | The server accepts connections from this computer only. |
| C5 | No OS integration: no autostart at login, no menu bar or tray icon, no OS-specific code. |
| C6 | Nothing to install besides Node and Chrome. The database is built into Node. |
| C7 | Developed and tested on macOS. Expected to work on Windows and Linux with the same Node and Chrome. |

## Features

### 1. Projects

- **R1.1** Add a project by name. The name is trimmed and must be 1–100 characters (an emoji counts as one character). It can't contain line breaks or other control characters.
- **R1.2** Names are unique across all projects, active and closed, ignoring upper/lower case. A closed project keeps its name because it can be reopened (R5.4). To work on it again, reopen it rather than adding a new project.
- **R1.3** Any number of projects can be active at the same time.
- **R1.4** The running project is listed first. It stays first while it's on a break or paused automatically, since it's the one expected to carry on. The other active projects stay in the order they were added.

### 2. Tracking time

- **R2.1** Start a project to run its timer. If another project was running, it pauses at the same moment. Only one project runs at a time.
- **R2.2** **Pause** is global and meant for any breaks (lunch, end of day). It pauses the running project. While on break, the app shows when the break began and how long it has lasted, and offers **Resume** for the last project. The user may skip the offer if they want to start a different project.
- **R2.3** Each project shows two values:
  - **Current**: time not yet reset (not yet billed).
  - **Total**: all time ever spent on the project, including time already reset.
- **R2.4** The running timer updates every second, and the browser tab title shows it (for example `01:42 · Acme Website`).
- **R2.5** **Started earlier? / Stopped earlier?** Right after a Start, switch or Pause, the user can say it actually happened earlier: −5 min, −10 min, or a specific time.
  - On a switch, those minutes move from the old project to the new one.
  - On a Pause, they are removed from the project that was running.
  - On a Start when nothing was running, they are added to the new project.
  - It can't go back before the previous project's timer started, or (for a plain Start) before the last timer stopped. It can't take a project's Current below zero (R4.3).
- **R2.6** Each project that isn't running shows when it last stopped and why, so it's clear whether the user stopped it or the app did:
  - A stop by the user shows its time. A switch, Reset or Close (before a reopen) also says so; a Pause needs no reason.
  - An automatic pause (R6.1) is marked as automatic and shows the backdated time and the reason. It stays shown after the user's choice (R6.3), until the project runs again. One exception: if another project started in the meantime, **Count** moves the stop to that start, so it then shows as a switch.
  - A time from an earlier day also shows the day. A project that has never run shows nothing.

### 3. Reset (billing)

- **R3.1** Reset is used once the project's current time has been entered into the client's billing system.
- **R3.2** Reset asks for confirmation. The dialog shows the time in **separate hours and minutes boxes**, each with a **Copy** button.
- **R3.3** Only whole minutes are reset. Leftover seconds stay on the counter: 12:34:40 resets 12 h 34 min, and the counter then shows 0:00:40.
- **R3.4** If the project is running, its timer stops. It doesn't start again until the user presses Start.
- **R3.5** Total doesn't change. Each reset (date, hours, minutes) is kept in the project's history.
- **R3.6** Reset isn't available while the current time is under 1 minute.

### 4. Adjust time

- **R4.1** Add or remove minutes on a project, with a required reason (for example "worked offline on the train").
- **R4.2** Adjustments appear in the project's history and count towards Current and Total.
- **R4.3** An adjustment can't make Current negative, because time already reset has been billed.

### 5. Close and reopen project

- **R5.1** Close asks for confirmation. If the project has 1 minute or more that hasn't been reset, closing resets it first, in the same step. The dialog shows the hours and minutes to copy, as Reset does (R3.2, R3.3), and stays open after the close to show what was recorded. There's no close without resetting: to keep time from being billed, remove it with Adjust time (R4) before closing.
- **R5.2** Closing stops the project's timer if it is running, and moves the project from the main view to **Closed projects**.
- **R5.3** The **Closed projects** menu lists closed projects with their total time and closed date. Each one shows its history.
- **R5.4** **Reopen** moves a closed project back to the active list, with its name, totals and history.

### 6. Protecting the time record

- **R6.1** The timer must not keep counting when the user isn't working. The running project pauses automatically when:

  | Situation | The pause takes effect at |
  |---|---|
  | The Work Hours tab (or Chrome) closed and wasn't reopened within 60 s | when the tab closed |
  | The computer went to sleep | when sleep began |
  | The Work Hours server stopped or crashed | when it stopped |
  | The screen was locked | when it was locked |
  | No keyboard or mouse input anywhere on the computer for 10 minutes | the last input |

- **R6.2** Every automatic pause is backdated to the moment the user left, as in the table, and the reason is saved.
- **R6.3** Every automatic pause can be undone:
  - **Count the 45m** adds the away time back, for meetings, calls or project work away from the computer. If nothing else was started since, the timer carries on as if it never paused. The page's button shows the amount it will add.
  - **Resume** restarts the timer from now without counting the away time. Starting the project in any other way counts as Resume too.
  - **Dismiss** keeps the project paused.
- **R6.4** These choices stay available until the user acts on them; they don't fade away. Resetting or closing that project withdraws them.

### 7. Alerts

- **R7.1** Alerts must reach the user while the tab is in the background, using sound and system notifications.
- **R7.2** **Back from away.** When the user returns after an automatic pause (unlocks the screen, touches the keyboard or mouse after being away, wakes the computer, or reopens the closed Work Hours tab), the app plays the alert tone and shows a notification with **Count the 45m** and **Resume**. The notification stays on screen until clicked. On macOS this depends on a one-time system setting covered in the README (R12.1).
- **R7.3** **Nothing running.** When the user returns from a break or from being away and no project is running, the app plays the alert tone and shows a notification with **Resume ‹last project›**. If the user stays active and still nothing is running, it repeats once after 10 minutes, then stops until the next break or absence.
- **R7.4** **Server stopped.** If the tab can't reach the server, the app plays the alert tone and shows a notification saying time isn't being counted and how to start the server again. It repeats every 5 minutes if a project was running when the server stopped.
- **R7.5** **Tab closed.** No alert is possible while the tab is closed. When it is opened again, the page shows the paused notice and the back-from-away notification (R7.2). The tone stays silent then, because Chrome blocks sound until the user clicks in the page (R8.2).
- **R7.6** **Check-in chime.** While a project is running and the user is active, a soft chime plays every 10 minutes (options: 5, 10 or 15). It is sound only, with no notification, and needs no response. It reminds the user to switch or pause if they forgot.
- **R7.7** The chime and alerts can't be muted or turned off. Volume can be adjusted but has a minimum level.
- **R7.8** There are two distinct sounds: the soft check-in chime, and a gentle but more noticeable alert tone.

### 8. Setup

- **R8.1** On first run, a welcome dialog explains why the app uses sound, notifications and away detection (text in [DESIGN.md](DESIGN.md#8-setup-and-permissions)). It then walks through:
  1. turning on sound, which plays both sounds;
  2. allowing notifications, which sends a test notification;
  3. allowing away detection;
  4. keeping the tab active, a one-time Chrome setting (R8.5).
- **R8.2** Chrome blocks sound after a page reload or a Chrome restart until the user clicks in the page. The status bar's ⚠ warning turns sound on with one click, and so does any click or key press in the page. If there's none within a minute, a notification asks the user to click in Work Hours.
- **R8.3** If a permission is declined, the app still works. It shows a permanent warning in the status bar and the tab title explaining what isn't protected.
- **R8.4** The Settings page has the check-in interval, the volume, a checklist of what's protected (with a way to rerun setup and to send a test alert), the location of the data folder, and export.
- **R8.5** Chrome's Memory Saver must not unload the Work Hours tab, because the tab is what detects absence and plays alerts. Setup explains the one-time Chrome setting that prevents it. If the tab is unloaded anyway, the app shows a warning the next time it is opened.

### 9. Data safety

- **R9.1** All data is in one SQLite file in `~/.workhours/`. The folder can be changed with a command-line option.
- **R9.2** A backup copy is made daily, and the last 14 are kept.
- **R9.3** Export as JSON (everything) and as CSV (reset history).
- **R9.4** Time is computed from stored start and end times, never kept as a running counter. A crash can't corrupt totals.

### 10. Running the app

- **R10.1** The `workhours` command starts the server on port 7420 and opens Chrome. Options: `--port`, `--data`, `--no-open`, plus `--help` and `--version`.
- **R10.2** If Work Hours is already running, the command opens Chrome to the running copy instead of starting a second one.
- **R10.3** Ctrl+C stops the server. A running timer is paused at that moment.
- **R10.4** On Node older than 24, the command prints a clear error message.

### 11. Look and feel

- **R11.1** The design is modern, minimal and clean. Fonts: Geist for text, Geist Mono for timers, both bundled with the app. Light and dark themes follow the OS setting.
- **R11.2** Keyboard shortcuts: `N` new project, `Space` pause/resume, `1`–`9` start the nth project, counting in the order they were added, so a key always starts the same project.
- **R11.3** The tab icon shows the state: green while running, grey on break. The tab title starts with ⚠ when alerts aren't fully working.

### 12. Documentation

- **R12.1** README.md covers everything a user needs to know or set up:
  - what Work Hours needs (Chrome only, Node 24 or newer, supported OSes);
  - what to expect (local only, no autostart, keep the terminal and tab open, sounds that can't be turned off, automatic pauses);
  - installing, running and the command-line options;
  - the one-time system settings (Chrome Memory Saver, OS notification settings, Focus, sound);
  - daily use, where the data lives, troubleshooting, and uninstalling.

## Out of scope

- Browsers other than Chrome.
- Desktop apps, mobile apps, a menu bar or tray icon, autostart.
- Users, login, teams, access from other devices, syncing between computers.
- Decimal hours and rounding rules.
- Renaming and deleting projects.

## Open items

- Minimum volume for the chime and alert tone: set after the user hears the sounds.
- Windows and Linux are untested. On Linux, confirm that Chrome's away detection works; some Wayland desktops may not support it.
