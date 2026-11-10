# Shift Plan (SSS)

Support-floor coverage calendar. One HTML file. The live page is https://osaid-ak.github.io/sss/ and the header reads **Shift Plan**.

Read this file before changing the calendar. Update it in the same change when behavior, publish steps, or standing rules change.

## Files

- `coverage-calendar.html` is the working copy. It is not committed.
- `index.html` is the published page. It must match the working copy before a commit.
- `serve-calendar.py` is a local server only. Do not commit it.
- `README.md` is the short tester note. Keep it consistent with this file.

## Publish

1. Edit `coverage-calendar.html`.
2. Copy it over `index.html`.
3. Commit only `index.html` for calendar changes, plus this file when the rules changed.
4. Push `main`. GitHub Pages serves `/` from `main`.
5. Tell the user to hard-refresh with Ctrl+F5. Pages can keep the previous HTML while a build is running.

Do not commit `coverage-calendar.html`, `serve-calendar.py`, or secrets. On PowerShell, commit with `git commit -m "..."` and chain commands with `;`.

## How the data is shared

Edits sync through the shared plan named `TEAM_PLAN` in the calendar file. A browser also keeps a local copy. Do not describe the calendar as Export/Import only.

Each browser keeps up to 5 automatic backups (local storage key `coverage-calendar-backups`), taken before a teammate or merged update (at most every 15 minutes) and before a JSON import or restore. Lead tools has Restore backup. Import asks for confirmation because it replaces the shared plan. Browser panes that block storage skip backups silently.

Always read the Actual Cover columns on the sheet, not Planned. Actual updates itself when a swap happens. Swap, then Planned, only fill in when Actual is blank. Saturday names come from the Weekend Cover sheet. The sheet has no time columns. The product windows are Phase 1 8pm–2am and VIP 5pm–2am. Display re-applies those windows, then adds one hour on standard-time dates. Do not make that spreadsheet world-editable. Do not rewrite stored clocks unless the user asks.

The `2. VIP Coverage Plan` tab (gid 1563923804, same workbook) lists two-week Monday to Friday blocks. Each block names one VIP person on Late Shift and one on Phase 1, read from Actual Cover. The page polls it with the weekend sheet and stores the blocks in the shared plan as `vipPlan`. On weekdays inside a block, the Late Shift person works 9:30pm–6:30am PKT (10:30pm–7:30am on standard-time dates), keeping their usual break offset, and the Phase 1 person moves from VIP to Phase 1 for the whole shift. Days someone edited by hand keep their own edit. Saturdays and Sundays are not affected. A failed read keeps the last blocks.

## Standing rules

- Primary time is PKT. ET is the secondary label. Overnight hours stay on the start day. Sunday is closed.
- Sundays stay hidden until someone clicks Show Sundays. Show them only when local storage `coverage-calendar-show-closed` is `"1"`.
- Default role filters are Phase 1, VIP, and Support Line. Lead is off. Clear restores those three, not an empty set.
- Away is a separate multi-select for Off and PTO. Nothing is selected by default, so everyone shows. Select all checks both and shows only those people. Off is the holiday rotation. PTO is holiday PTO or approved leave.
- People who are Off or PTO stay visible, red and struck through, at the end of the time group. The count on a time chip does not include them.
- Week columns show shift times as chips: time on the left, working headcount on the right. Support Line is a separate section at the bottom of each weekday, grouped by start time only. Saturday has no Support Line section.
- The day view is one timeline list, grouped Leads, then VIP, then Phase 1. Do not put Phase 1 and VIP side by side unless the user asks again. The day view has no header block (no Back button, title, subtitle or peak chips) because the top bar already shows the date and view switch. Rows are compact so the day fits with little scrolling. Today's night shows a red Now line with a PKT time pill (real PKT clock, refreshed every 30 seconds), and the timeline scrolls sideways to it on narrow screens. A Gaps row under the peak band flags slots inside the peak window (Phase 1, VIP) and the Support Line window with 0 people (red) or 1 person (amber); it follows DST and is hidden on Saturdays and Sundays. Only a Saturday cover note and the edit-mode Reset button appear above the timeline.
- Year is hidden until lead access is unlocked, and it hides again when access is locked.
- Print and Export sit under Access. The header has Weekend shift and VIP coverage buttons that open that tab of the Google Sheet inside the calendar (an embedded editor; edit rights follow the viewer's Google account, and an Open in Google Sheets link is the fallback). Back to calendar, Escape, or changing view closes it and re-reads the sheet; while open it re-reads every 20 seconds. Sync sheet (weekend and VIP plan) stays in the header.
- DST is automatic and follows US Eastern time, because shifts are anchored to ET. Stored clocks are the summer (EDT) schedule. From the first Sunday of November to the second Sunday of March, every date shows its shifts, breaks, splits, line assignments and Saturday windows one hour later in PKT, and the Peak window (7pm–12am becomes 8pm–1am) and Support Line window (5pm–3am becomes 6pm–4am) move with them. The board itself stays 3pm–8am PKT. There is no DST button, and `dst` in saved data is always false. Older plans saved with the global switch on are converted back to the summer schedule on load. Per-day edits are stored as shown for that day. Do not reintroduce a manual switch unless asked.
- The lead PIN is in the page source. Do not print it in chat or in the UI.

## Already in place

Team sync, weekend sync from the sheet, role colors for night and frost, week time chips, Support Line section, Off/PTO filter, OOO styling, PKT-first roster times, peak and Support Line windows that follow DST, and Year behind lead access.
