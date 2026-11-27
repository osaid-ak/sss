# Slack `/calendar`: what to build in the Intercom Phase Assignment project (the Slack side)

The calendar side is built and tested (`worker/src/commands.js`, `dates.js`, the `/api/v1/calendar/*` routes). This folder is the brief for the Slack side: `README.md` (this), `ops_schema.json` (the JSON the bot sends), `golden.json` (29 phrases with the exact operations each must become, and the ones that must be refused; the calendar's own tests run them, so they are known-good).

## 1. What the leads get

A lead types in the leads' Slack channel:

```
/calendar jawad is off today and raza is covering him
/calendar jawad is off this week and next and raza will cover him today and tomorrow only
/calendar jawad swapped with raza from coming monday to thursday
/calendar jawad switched to Phase 1 from VIP for today
/calendar move Jawad to Phase 1 and 10.30 shift from 20th Nov to 25th Nov
/calendar jawad is off today, raza covers him at 10.30 and zarminay covers raza at 6pm
/calendar undo
```

The bot answers **privately first** with exactly what it understood and what would change, and a **Confirm** / **Cancel** button. Nothing changes until Confirm. After Confirm it posts to the channel, naming who asked, what changed in the calendar, and what is still open for a lead. The calendar then shows the change, with a "Moved by <name> via Slack" line for leads (and a Remove button), the "(moved)" / "(covering)" tags, and its usual red Lead action alerts for anything still open. The calendar's activity log records the change under the lead's name, marked "via Slack".

Never written to: the Google Sheet. The calendar's API cannot touch it and neither should the bot.

## 2. The flow, step by step

1. **Slack request** arrives (reuse the `/phase` plumbing: signature check, allowed channel, answer in under 3 seconds, work in the background).
2. **Who may run it**: the Slack user must be on an allowlist (config, Slack user IDs). Look up their email with Slack's `users.info` (the verified profile email, never text from the message). The calendar then checks again that this email is an Admin or the Super Admin and refuses otherwise, so the allowlist is a first lock and the calendar is the second.
3. **Parse** the text into operations (section 5). If the text is unclear, **ask a question, do not guess** (an ephemeral reply, nothing sent to the calendar).
4. **Preview**: `POST /api/v1/calendar/command` with `dryRun: true` (the default). Show the lead `summary`, `warnings`, `skipped` and `needsCover`, plus a Confirm / Cancel button. Keep `previewHash` and the operations in the button's payload (or in your state store keyed by a button id).
5. **Confirm**: `POST` the same operations with `dryRun: false`, a fresh `commandId` (a UUID, kept for this command) and the `previewHash`. If the calendar changed since the preview it answers 409 and applies nothing: tell the lead to run the command again.
6. **Report** in the channel (section 6). Keep the `commandId` for `/calendar undo`.
7. **Undo**: `/calendar undo` (the last command by that lead, or `undo <commandId>`) calls `/api/v1/calendar/undo`.

A repeated click on Confirm is harmless: the same `commandId` returns the stored result with `replayed: true` and changes nothing twice.

## 3. The calendar API

Base `https://shift-plan.autoleap-sss.workers.dev`. Both endpoints are `POST` with `Authorization: Bearer <write key>` and `Content-Type: application/json`. The write key is its own secret (`WRITE_KEYS` in the calendar's Cloudflare settings, in Secret Manager here as `calendar-write-key`): a read key (the Intercom automation's) cannot write, and a write key cannot read. Never log the key.

### `POST /api/v1/calendar/command`

```json
{
  "actor": { "email": "<the verified email of the Slack user>" },
  "ops": [ { "op": "off", "people": ["Jawad"], "dates": "this week and next" },
           { "op": "takeover", "name": "Raza", "from": "Jawad", "dates": "today and tomorrow" } ],
  "dryRun": true
}
```

To apply: the same `ops`, `"dryRun": false`, `"commandId": "<uuid>"`, `"previewHash": "<from the preview>"`.

Answer (200):

```json
{
  "ok": true, "dryRun": true, "previewHash": "9f2c…", "commandId": null, "actor": "Osaid",
  "summary": ["Jawad is off Wed 18 Nov to Fri 20 Nov, Mon 23 Nov to Fri 27 Nov (approved leave).",
              "Raza takes over Jawad's shift and queue Wed 18 Nov to Thu 19 Nov."],
  "warnings": [],
  "skipped": ["Sat 21 Nov: …"],
  "dates": ["2026-11-18", "…"],
  "needsCover": [{ "date": "2026-11-18", "kind": "late", "text": "Late shift 10:30pm–7:30am needs a Phase 1 person.", "new": false }],
  "calendarSays": [{ "date": "2026-11-18", "covers": ["Raza is covering Jawad on their 8pm–5am Phase 1 shift."] }],
  "source": { "weekendCover": "sheet", "rotation": "sheet" }
}
```

- `summary`: one sentence per operation, ready to post.
- `skipped`: days left out and why (Sunday, already past, Saturday for shifts, already off).
- `needsCover`: what still needs a lead **after** the change, for the nights it touched. `new: true` marks what this change opened (post those prominently).
- `calendarSays`: how the calendar will word the covers on those nights.
- **Errors**: `422 { ok:false, errors:[…] }` the command cannot be done (the reasons are plain sentences; show them); `401` bad key; `403` not an Admin / not on the list; `409` changed since the preview, or the calendar kept changing; `400` malformed; `503` no plan. On any non-200 **nothing was changed**.

### `POST /api/v1/calendar/undo`

`{ "actor": { "email": "…" }, "commandId": "<the command to undo>" }` → `200 { ok:true, undone:true, summary:[…], notes:[…] }`. It takes back exactly what that command added. `notes` lists anything it left alone because somebody changed it since. `409` if already undone, `404` if unknown.

## 4. The operations (see `ops_schema.json`)

| op | fields | what the calendar does |
| --- | --- | --- |
| `off` | `people[]`, `dates`, `note?`, `sick?` | approved leave on those days (Saturdays too; Sundays skipped). `sick: true` when they are off sick: the calendar shows a 🤒 beside the name wherever it is crossed out |
| `back` | `people[]`, `dates` | cancels leave for those days (the rest of the leave stays) |
| `takeover` | `name`, `from`, `shift?`, `release?`, `dates` | `name` works `from`'s queue and shift. `shift` names the shift when it is not `from`'s own that night (for example the 6pm anchor `from` left). `release: true` (for "replaces", not plain "covers") sends `from` back to their usual hours when they are working, so two people do not hold the same shift |
| `move` | `name`, `queue?`, `shift?`, `dates` | other queue (`phase1`, `vip`, `both`) and/or other hours that night. `shift: "usual"` ("his own shift", "original shift") puts the person on their own roster hours, break and split; the queue stays. A person who is already on their usual hours is reported as such, not as an error, when another step of the same command changed something |
| `swap` | `a`, `b`, `dates` | the two exchange shifts and queues |
| `cover` | `kind` (`late`, `phase1`, `p1q`, `anchor`), `name`, `for?`, `dates` | the calendar's own cover slots: VIP / Phase 1 late-shift cover, a VIP rep moved to Phase 1, or the anchor a late-shift cover left (`for` = whose) |

**`shift`**: the lead's words are fine: `"late"`, `"the late shift"`, `"10.30"`, `"the 10:30 shift"`, `"9.30"`, `"1030"`, `"10:30pm"`, `"6pm"`, `"the 6 pm anchor shift"`, `"7pm-4am"`, `"from 7pm to 4am"`. **The late shift is a word, not a clock**: however it is written (including 10.30 or 9.30) it means the late shift of that night, 10:30pm in standard time and 9:30pm in summer time, per date, and the preview says so when the clock written differs from that night's. `"6pm"` means the anchor that starts at 6pm that night (on the summer clock the anchors start 4pm, 5pm and 7pm and a standard-time clock is mapped with a note). A queue can be written `Phase 1`, `phase one`, `p1`, `Phase 1 team`, `VIP`, `vip handling`, `both`. Anything it cannot place (for example "night shift", or "10pm", which is no shift) comes back as a plain error that lists the shifts that night: show it to the lead, and add the new wording to the bot's prompt or map it yourself; no calendar change is needed.

**`dates`**: **pass the lead's words, never convert them yourself.** The calendar's resolver is deterministic and tested; the preview echoes the exact days so a mistake is visible before Confirm. It reads: `today`, `tomorrow`, `20th Nov`, `Nov 20`, `20/11`, `2026-11-20`, `20th Nov to 25th Nov`, `from coming Monday to Thursday`, `this week`, `next week`, `this week and next`, `rest of the week`, `today and tomorrow`, `mon, tue and thu`, `next 3 days`, `till Friday`. Rules: a bare weekday is the nearest one on or after today; `coming Monday` is the nearest one after today; `next Monday` is the one in next week; a date like `12/11` is read **day first** (the preview shows how it was read, and a warning says so). If the text gave no dates at all, send `"today"` and let the preview show it.

Rules the calendar enforces (so the bot does not need to): names must be on the roster (a first name is enough, an ambiguous one is an error that lists the choices); past days and Sundays are skipped; shifts and swaps are refused on Saturdays (the Weekend Cover sheet rules those; marking someone off on a Saturday is allowed); leads are not used as cover; a person who is off cannot cover; one person never gets two jobs on a night.

## 5. Turning the text into operations

Use a language model for this, constrained to the schema, because leads will phrase things in many ways. Safeguards that make it safe:

- The model may only output the operations in `ops_schema.json` (use a tool / structured-output call with that schema). It never writes dates, never invents names, and never decides anything the calendar decides.
- **Ask, don't guess**: a pronoun with no name ("raza covers him" with nothing before it), a missing person, a missing "for whom", or two possible meanings: reply with one short question and stop.
- Resolve names to the roster **spelling** by sending the roster names (from `GET /api/v1/intercom-plan` → `roster[].name`) in the prompt; pass exactly one of them.
- Everything is previewed and confirmed, so a misread costs a click, not a wrong calendar.
- Keep the original text with the command (log it): the calendar stores "who and what" and the Slack message holds the words.
- Test with `golden.json` (each entry: the phrase, the operations it must become, and whether the calendar accepts it). Also test a set of your own variants; the point is that the model's output equals the golden operations.

Suggested system prompt:

```
You turn a support lead's /calendar message into operations for the shift calendar. Reply only by calling the tool.
- People are first names from this roster: <roster names>. Use exactly one of them, spelled as listed. If a name is not on it, ask.
- "X is off" -> off. "X is off sick" / "X called in sick" / "X is unwell" -> off with `sick: true`. "X is back" -> back. "X covers Y" / "X takes Y's shift" -> takeover (name X, from Y). Add shift when a clock or shift is named ("at 6pm", "the 10.30 shift").
- "swapped with" -> swap. "switched / moved to Phase 1 (or VIP)" -> move with queue. "and the 10.30 shift" -> the same move with shift.
- "X replaces Y" -> takeover with `release: true`; "X covers Y" stays a plain takeover. "Y will do his/her original / own / usual shift" -> move with `shift: "usual"`. A VIP late-shift cover (`cover` kind `late`) automatically sends the sheet's late-shift person back to their usual hours that night (the summary says so), so "X will do the late shift and Y will do their original shift" needs no extra step (sending the second step as well is harmless).
- "X covers the late shift" -> cover kind late. "X covers the Phase 1 late shift" -> kind phase1. "X moves to Phase 1 because Y is off" -> cover kind p1q.
- Copy the date words exactly as written ("from coming Monday to Thursday", "20th Nov to 25th Nov", "today and tomorrow"). Never convert them. If there are no dates, use "today".
- A pronoun (him, her, them) refers to the person named earlier in the same message. If it is unclear who, ask.
- If you are not sure what is wanted, ask one short question instead of guessing.
```

## 6. Messages

- **Preview (private to the lead)**: `Here is what I understood:` then the `summary` lines, `Skipped:` lines, `Warnings`, and `Still open after this:` with the `needsCover` lines (those with `new: true` first, marked). Buttons **Confirm** and **Cancel**. Say clearly that nothing has changed yet.
- **Confirmed (channel)**: `:white_check_mark: <name> updated the calendar:` the `summary` lines; if `needsCover` is not empty, `:warning: Still needs a lead:` and the lines; the calendar's own wording for covers from `calendarSays` can be added. Mention it can be undone (`/calendar undo`).
- **Refused or failed**: say what happened and that **nothing was changed**, with the calendar's reasons (422) or a plain "the calendar is not reachable, nothing changed" (network errors). Never retry an apply on a timeout without checking the result by repeating the same `commandId` (it returns the stored result if the first call went through).
- Accountability: the Slack message names the lead; the calendar's activity log records the same person (their name and email) with "via Slack".

## 7. Safety checklist

- Only the allowlisted Slack users, only in the approved channel(s); the actor's email comes from Slack's profile.
- The write key only in Secret Manager, mounted on the service that handles `/calendar`; not in the repo, not in logs.
- Rate limit per user (for example 10 commands a minute) and cap the text length.
- Start with **preview only** for the first week: show the preview with the buttons disabled, or apply nothing, and compare what the bot understood with what the leads meant. Then enable Confirm.
- If anything about the calendar answer is unexpected, say so and stop. The calendar never half-applies a command.

## 8. Setting up the write key (once)

In the calendar's `worker` folder: `npx wrangler@4 secret put WRITE_KEYS` with `slack:<a long random key>` (several keys can be comma separated; remove an entry to revoke it), then `.\deploy.ps1`. A refused call is logged in the calendar's activity log as "api refused". Put the same key (without `slack:`) in Secret Manager for the service.
