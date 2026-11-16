# Calendar -> Intercom: what to change in the Intercom Phase Assignment project

Give this whole folder to whoever updates the automation (`calendar_overlay.py`, `test_calendar_overlay.py`, `sample_response.json` and this file).

## 1. The model, in one page

**Two inputs, one rule.**

1. **The intended state is the sheet's.** The automation keeps reading the `2. VIP Coverage Plan` tab (the Actual Cover column) exactly as it does today: the Phase 1 person for the block is on Phase 1, everybody else in the rotation is in VIP.
2. **The calendar's changes win.** The calendar tells the automation where a **lead changed something**: a rep moved VIP <-> Phase 1 for a day, a Phase 1 queue cover, the people a Saturday names. Wherever the calendar says something about a person, it overrides the sheet. Where it says nothing, the sheet stands.

**Hourly, acting on changes.** The job runs every hour (it already does). Each run works out what it wants (calendar over sheet) for the shift day that is running, and acts on the people whose wanted queue **changed since the last run**:

| When | What happens |
| --- | --- |
| a lead edits today in the calendar | applied at the next hourly run |
| 15:00 PKT, a new shift day starts | the new day's wanted state is applied (an edit for that day, or the edit of the day before ending) |
| Monday 15:00, a new rotation block | the sheet's new Phase 1 person goes on Phase 1, the old one back to VIP |
| the Monday 15:00 / 18:00 weekly check | everybody is brought in line with sheet + calendar (this is also what undoes manual `/phase` changes, as today) |
| **Saturday 15:00** | the rotation person goes to VIP **only if the Weekend Cover names them as a VIP rep**, otherwise they stay on Phase 1. The Weekend Cover's Phase 1 person (a VIP rep) goes on Phase 1. |
| Monday 15:00 after a Saturday | back to the rotation as above |
| **Sunday** | closed: change nothing |

Because it acts on **changes**, a manual `/phase` move lasts until the sheet or the calendar next changes something for that person, or the Monday check. That is the behaviour the leads have today.

**The right person.** The calendar sends each person's **email**; the automation checks that the Intercom ID it is about to move belongs to the teammate with that email. A mismatch skips that person only.

**It must not fail.** If the calendar is unreachable, slow or does not make sense, the automation ignores it for that run and does what it did before the calendar existed (sheet only), with one Slack warning.

**Always live.** On every API call the calendar reads the Google Sheet itself and its lead decisions are saved on the server the moment a lead saves them. Nobody has to open the calendar.

## 2. The API (already built and deployed in the calendar worker)

`GET https://shift-plan.autoleap-sss.workers.dev/api/v1/intercom-plan?from=YYYY-MM-DD&days=N`

- Header `Authorization: Bearer <API key>`. No Google sign-in, no cookies. Read only (any other method is 405).
- `from` defaults to the shift day running now, `days` defaults to 8 (1 to 31). The automation asks for `from = today's shift day` and `days = 1` (shadow mode: 4, to preview the Saturday).
- Errors: 401 bad or missing key, 400 bad parameters, 503 the calendar has no plan yet. Answers are never cached.
- Allow up to 10 seconds: the worker reads the Google Sheet on every call.

Answer (see `sample_response.json`, a real answer from the worker's code):

```json
{
  "version": 1,
  "generatedAt": "2026-11-16T10:00:00.000Z",
  "planUpdatedAt": "2026-11-16T09:00:00.000Z",
  "sheetReadAt": "2026-11-16T08:00:00.000Z",
  "sources": { "weekendCover": "sheet", "rotation": "sheet" },
  "timezone": "UTC+05:00",
  "boundary": "15:00",
  "currentShiftDay": "2026-11-16",
  "roster": [{ "name": "Ivan", "email": "ivan@autoleap.com", "normalQueue": "vip", "lead": false }],
  "days": [
    {
      "date": "2026-11-17", "weekday": "Tue", "kind": "weekday",
      "boundary": "2026-11-17T15:00:00+05:00",
      "rotationPhase1": "Jawad", "edited": true,
      "decisions": [{ "name": "Ivan", "email": "ivan@autoleap.com", "queue": "phase1", "reason": "day edited by a lead", "lead": false }],
      "queues": { "Ivan": "phase1", "Jawad": "phase1", "Raza": "vip" },
      "lateShift": "Ammana",
      "away": [{ "name": "Jawad", "kind": "pto" }],
      "covers": [
        { "kind": "late", "name": "Ivan", "for": null, "what": "the VIP late shift 10:30pm–7:30am",
          "text": "Ivan is covering the VIP late shift 10:30pm–7:30am.",
          "from": "10:30pm", "to": "7:30am", "fromAt": "2026-11-17T17:30:00.000Z", "toAt": "2026-11-18T02:30:00.000Z" }
      ],
      "needsCover": []
    }
  ]
}
```

- **Shift day** = the date it starts on, 15:00 PKT to 15:00 PKT. After midnight it is still the previous date's shift day.
- `kind`: `weekday`, `saturday` (no rotation), `sunday` (closed: `decisions` empty, `queues` null: hold).
- **`decisions`** is what the automation uses: the people whose queue that day **differs from normal**, where normal = the roster's queue with the rotation's Phase 1 person on Phase 1. On a **Saturday** it lists **everyone the Weekend Cover names** (Phase 1 person as `phase1`, VIP people as `vip`); anyone not named is not in the list and must be left alone. `queue` is `phase1`, `vip`, `both` or `lead` (ignore `lead`: no Phase 1 / VIP role that day).
- `reason`: `day edited by a lead`, `Phase 1 queue cover`, `VIP late shift cover`, `Phase 1 late shift cover`, `weekend cover`, `anchor shift cover`, `calendar command` (a lead's Slack `/calendar` command: a queue move, a takeover or a swap for that night). Use it in the Slack message.
- **`queues`** is the calendar's own full picture (every roster person's queue that day, including the sheet rotation). The automation does **not** act on it; use it only as a cross-check in shadow mode (`cross_check`): a difference means the sheet and the calendar disagree about someone.
- `email` (decisions and roster): the one written on the roster entry in the calendar, otherwise the single allowed teammate email that contains the person's name (`muhammad.jawad@...` for Jawad), otherwise `null` (cannot be verified).
- **`away`**: who is off that shift day: `kind` is `off` (a confirmed holiday "off") or `pto` (holiday PTO or approved leave). Pending leave and draft holiday plans do not count, exactly as on the calendar.
- **`covers`**: who is covering whom, as the calendar words it. `kind` is `late` (a lead added late-shift cover), `queue` (a VIP rep moved to Phase 1 because the Phase 1 person is off), `anchor` (the sheet's Anchor Cover 1 / 2 covering an anchor shift the block's Late Shift or Phase 1 person normally works), `line` (the Support Line backup, or whoever holds the slot of an owner who is off) `takeover` (a lead's command had someone work another person's shift, for example "Raza is covering Jawad on their 10:30pm–7:30am VIP shift."), `change` (a command moved someone's queue or hours, or swapped two people: "Jawad is on VIP instead of Phase 1 and working 6pm–3am instead of their usual 8pm–5am (swapped with Raza).") or `hours` (anyone else working hours other than their original shift). Each has `name`, `for` (who they cover, or null), `what`, a ready sentence in `text` (the same sentence as the calendar's "Covering tonight" box), `extra` when the calendar adds a note (for example how the backup's shift moved), and the times: `from` / `to` in PKT as the calendar shows them (for example `10:30pm`, `7:30am`) and `fromAt` / `toAt` as UTC instants. The times follow daylight saving like the calendar. The block's Late Shift and Phase 1 Coverage people are not in `covers` (they are the rotation: see `lateShift` and `rotationPhase1`).
- **`needsCover`**: what still needs a lead, as the calendar's red alerts word it: a late shift without a VIP or Phase 1 person, an uncovered anchor shift, a Phase 1 person who is off with no queue cover, a Support Line slot whose owner is off and nobody can take it. `kind` is `late`, `anchor`, `phase1` or `line`. Empty when everything is arranged. `kind: "line"` also covers a stretch of the Support Line window with nobody on the line ("Support Line has nobody 9pm–11pm. Adjust breaks or add cover."): a break inside the owner's own slot, or nobody scheduled. Saved nights (a day a lead edited or copied) follow the sheet's Late Shift and Phase 1 coverage from next week on, so `queues` and `decisions` for those nights already reflect it.
- **`lateShift`**: the block's Late Shift person.
- All of this is computed on the server with the calendar page's own logic (ported function by function and compared with the page itself, see the end of this section). Saturdays have no covers (only `away` for the people the Weekend Cover names); Sundays have nothing.
- `rotationPhase1` is who the **sheet** (read live by the calendar) says is on Phase 1; on a Saturday it is Friday's block person. Information for shadow mode.
- `roster[].normalQueue` is each person's queue with nothing decided (used to put people back).
- `sources` says where the sheet data came from (`sheet` = read just now, `stored` = the calendar's saved copy because Google could not be read). Log it when it is `stored`.
- Names are the calendar's roster names (first names). Match them to Intercom IDs with the map in your config and **verify with the email**. **Never guess a name.**

The weekday queue rules were checked against the calendar page itself on 800 person-days of the real plan (hand edits and covers included): no differences. The cover logic (`away`, `covers`, `needsCover`) was checked against the page itself on the real plan and on 13 randomised plans (leave, holiday offs, late and queue covers, anchor covers, hand-edited days, Support Line backups, changed shift hours, across the November, March and November clock changes): about 1,900 covers of all five kinds, 800+ people off and 400+ open needs, identical to the page. The sheet readers (Weekend Cover, VIP Coverage Plan with the anchor columns, and the Phase 1 / Support Line tab) were compared with the page's readers on the live tabs: identical.

## 3. Changes to make in the automation

Add `calendar_overlay.py` next to `rotation.py` and to the `Dockerfile` `COPY` line (standard library only). **If you already integrated an earlier version of this module, replace it and adjust: it no longer has `state_marker` / `revert_targets`; the state is now `state["calendar"] = {"desired": {id: queue}, "names": {id: name}}`, and a run happens whenever what is wanted changes, not on a date change.**

### 3.1 Config (`rotation_config.cloud.json`)

```json
"calendar": {
  "mode": "off",
  "url": "https://shift-plan.autoleap-sss.workers.dev",
  "apply_to_leads": false,
  "require_email": true,
  "max_changes": 8,
  "people": { "Raza": "5573818", "Ivan": "5861947", "Raahym": "6472238", "Zarminay": "6745226", "Jawad": "7061104", "Ammana": "7665017" }
}
```

- `mode`: `off` (exactly the old behaviour), `shadow` (read the calendar, post what it *would* change, change nothing), `on` (apply). Go off -> shadow -> on.
- `people`: name -> Intercom ID, used to map the calendar's decisions. Start with the six rotation people. To let leads move other reps too add them from `intercom_phase_users.csv`: Ayeshah 8660665, Laraib 6472290, Qasim 10783248, Schanzae 7113103, Zunair 10510117 (and, only used when `apply_to_leads` is true, Ashraf 6472226, Osaid 6745352). A decision for a name that is not in the map is skipped and reported, unless the email identifies exactly one Intercom teammate.
- `require_email`: a decision whose email the calendar could not provide is not applied (the ID cannot be verified).
- `max_changes`: if more than this many people would move in one run, nothing is applied and a warning is posted (a mistake is more likely than a real mass change). The very first run in `on` mode may move several people; raise it for that run or use `--force`.

Check each person's real Intercom team before relying on the map. For example the CSV lists Jawad as "Phase 1, Phase 2" without VIP, but he is a rotation person, so sending him back to "VIP" adds him to VIP.

### 3.2 Secret

Environment variable `CALENDAR_API_KEY` from Secret Manager (`calendar-api-key`, already created and mounted on the `phase-rotation` job). Never in the repo; `.env.example` gets only an empty `CALENDAR_API_KEY=` line.

### 3.3 The hourly run, step by step (`mode == "on"`; with `off` nothing below runs)

```python
import calendar_overlay as co

cal = cfg.get("calendar") or {}
mode = cal.get("mode", "off")
day = co.shift_day(now)            # the shift day running now (15:00 PKT boundary)
kind = co.day_kind(day)            # "weekday" | "saturday" | "sunday", from the date alone
```

1. **Sunday** (`on` and `kind == "sunday"`): print "Sunday: closed, holding" and `return "waiting"`. Do not touch the state.
2. **The sheet's block** (the intended state). Look it up as today, except on a Saturday, when the Monday-to-Friday block has ended and `active_block` would return None and the run would stop: ask as of Friday.

   ```python
   when = now.astimezone(tz) if kind == "weekday" else datetime.combine(co.rotation_day(day), handover_time, tzinfo=tz)
   block = active_block(blocks, when, handover_time, tz)       # your existing helper
   ```

   On a weekday keep your existing "no block active: waiting" path. `person = block["person"]`.
3. **The baseline** from the sheet: `baseline = co.sheet_baseline([str(i) for i in cfg["people"].values()], ids.get(person))`.
4. **Fetch the calendar** (one read-only call) and the Intercom teammates for the email check:

   ```python
   try:
       import phase1_cmd  # lazy: it imports this module
       admins = phase1_cmd.list_admins(client)                       # id + email of every Intercom teammate
       plan = co.fetch_plan(cal["url"], os.environ["CALENDAR_API_KEY"], day, days=1)
       entry = co.day_entry(plan, day)
   except (co.CalendarError, KeyError, SystemExit) as e:             # SystemExit: Intercom's helper exits on an API error
       plan = None   # fall back to the sheet-only run you have today (section 3.7), warn once
   ```
5. **Decide** (pure, no side effects). Use the memberships *after* undoing recorded manual changes on a weekly reset, as your code already computes (`p1_eff`, `vip_eff`):

   ```python
   state = load_state(cfg)
   reset = sync_reset or force            # your existing weekly_sync() result: the Monday 15:00 / 18:00 check
   r = co.run_plan(plan, entry, cal["people"], state.get("calendar"), p1_eff, vip_eff, baseline, reset=reset,
                   apply_to_leads=cal.get("apply_to_leads", False), admins=admins,
                   require_email=cal.get("require_email", True), max_changes=cal.get("max_changes", 8))
   # raises co.CalendarError if too many people would move: treat it like a failed calendar (warn, sheet-only run)
   ```

   `r["hold"]` is True on a Sunday. `r["changed"]` lists the Intercom IDs that actually move; `r["p1"]` / `r["vip"]` are the two lists to write (additions first, then removals, as you already do); `r["problems"]` are people skipped (wrong email, unknown name, a lead).
6. **If nothing changed** (`r["changed"] == []`): store `state["calendar"] = r["new_state"]` if it differs, and return "unchanged". No Slack message.
7. **Otherwise write it** with your existing safe path: snapshot, additions before removals, re-read and verify, the "no team may end up empty" rule, and only the people in `r["changed"]` may change. Then `state["calendar"] = r["new_state"]`, `state["applied"] = key` and `save_state`. Keep your existing Monday reset of recorded manual changes (`state["manual"]`), and the leads' `default_vip_only` reset, as they are.
8. **Slack**: name who moved and why. The calendar's reason is `co.reasons(entry)[name]`, e.g. "Ivan has been added to Phase 1 (calendar: day edited by a lead)". Post `r["problems"]` and `co.source_notes(plan)` to the alert channel (once per distinct text).

**Do not change** the hourly schedule, `/phase`, the evening cover (`surge.py`), the state bucket layout (you only add the `calendar` key), or the safety rules.

### 3.4 What the manual `/phase` changes do

- A manual move of a **rotation person** (e.g. Ivan to Phase 1) stays until the sheet or the calendar changes what is wanted for Ivan (for example the next day's decisions, or a new block), or until the Monday check.
- A manual move of someone **outside** the rotation people and outside the calendar's decisions is not in the plan at all, so only your existing recorded-manual reset (Monday 15:00) undoes it, as today.
- The evening cover (`surge.py`) adds and removes VIP people on Phase 1 in the evening; it is unchanged. The weekly check runs at 15:00 and 18:00 PKT, before its 19:15 window, so they do not meet. If a missed weekly slot is caught up during the window, the next surge check puts its people back.

### 3.5 Shadow mode (do this first, for about two weeks)

In `shadow` run steps 1 to 5 with `days=4` (so Saturday is previewed) and **write nothing to Intercom**. Post to the alert channel (`C0BEH2T7L1Y`), once per distinct text (remember it in `state["calendar_shadow"]`):

- what it **would** change: `"Calendar (shadow): Ivan would move to Phase 1 for Tue 17 Nov (day edited by a lead)"`; and the Saturday plan: `"Sat 21 Nov 15:00: Jawad (named as VIP on the Weekend Cover) would move to VIP, Ivan to Phase 1; Mon 23 Nov: Jawad back to Phase 1"`;
- `co.cross_check(entry, r["desired"], {id: name})`: places where the sheet and the calendar disagree;
- `r["problems"]` and `co.source_notes(plan)`.

Go to `on` when two weeks of shadow messages are all what the leads meant and nothing looked wrong in the cross-checks.

### 3.6 The start-of-day cover message (Slack)

A message once per shift day, listing what the calendar knows about cover. Everything in it comes from the API; nothing is computed in the automation.

- **When**: the first hourly run of the shift day, which is the 15:00 PKT run (or another time you choose; the API is current at any hour). Remember the day you posted for in the state (`state["cover_digest"] = {"day": "2026-11-17", "text": "<what was posted>"}`) so a second run the same day posts nothing.
- **What**: `text = co.cover_digest(entry)` for the day's entry (`days=1` is enough). It returns `None` when nobody is off, nothing is covered and nothing is open: then post nothing. Example:

  ```
  *Cover for Wed 18 Nov*
  • Off: Jawad (PTO or leave)
  • Ivan is covering the VIP late shift 10:30pm–7:30am.
  • Ammana is covering Jawad on Phase 1.
  • Raza is covering Jawad on the 8pm–5am VIP shift.
  ```

  Open needs appear as `:warning:` lines, for example "Late shift 10:30pm–7:30am needs a Phase 1 person."
- **Changes during the day**: if a lead adds or removes a cover after the message went out, the text of a later run differs. Post a short thread reply with the new full text (`state["cover_digest"]["text"] != text`), once per change; or post nothing and let the 15:00 message stand. Choose one and keep it simple.
- **Where**: the support channel the leads use; it is not an alert, so keep it out of #support-leads unless that is where they want it.
- If a day carries `coversError` (the calendar could not work out its cover list; the queue answer is still fine) `co.cover_digest` returns None; log `co.cover_error(entry)` and carry on.
- It is independent of `mode`: it only reads the calendar, and a calendar failure just means no message that day (log it, do not retry in a loop, never block the Intercom work).

Anchor shifts: when a lead puts someone who works an anchor shift (for example Raza, 6pm–3am) on late-shift cover, the calendar treats the anchor they leave as open for that night. It shows up in `needsCover` ("Anchor shift 6pm–3am VIP is uncovered. Raza is covering the late shift.") until a lead picks a VIP rep in the calendar, and then as a cover ("Zarminay is covering Raza on the 6pm–3am VIP shift."). So the two-step story (Raza covers the late shift, Zarminay covers Raza's 6pm) is in the message as two lines once both are entered.

### 3.7 If the calendar is unavailable (the must-not-fail rule)

| Situation | What happens |
| --- | --- |
| unreachable, timeout (10 s), 5xx | one retry after 2 s, then ignore the calendar for this run |
| 401 (key wrong or revoked) | no retry, ignore the calendar, warn |
| not JSON, wrong `version`, a missing day, malformed decisions or queues, calendar and automation disagree on what kind of day it is | `CalendarError`, ignore the calendar |
| `max_changes` exceeded | `CalendarError`, nothing applied, warn |
| a decision names someone not in the map / wrong email / a lead | that person skipped and reported, the rest applied |
| Intercom write fails | your existing refusal / verification / Slack error path |

"Ignore the calendar" means the **sheet-only run you have today** (the existing `run()` path, untouched). Use your existing `report_problem(..., transient=True)` with its own key (`"calendar: ..."`) so one problem posts once after two failures in a row, and a "working again" note on recovery, separate from the sheet problems.

Rollback: set `"mode": "off"` and redeploy the config. Or revoke the key (section 6): the fetch then fails and the automation falls back to the sheet.

## 4. Tests

- `python -m unittest test_calendar_overlay -v` runs 59 checks of the module: shift day boundary, plan validation, the calendar's moves, both Saturday cases, Sunday, the email check, leads, limits, `desired_state` precedence, acting on changes only, and **hourly simulations against a fake Intercom** (lead edit applied at the next run and undone the next day, the calendar beating the sheet, manual moves lasting until something changes, the Monday check, Saturday and Monday, the next block).
- Add to the automation's own suite (it already has `calendar_test.py`): with the calendar on, two consecutive quiet weekdays and a manual `/phase` move of a rotation person in between leave that move in place at the next 3pm run.
- Dry runs with your existing `--now` (no `--apply`), using the calendar's real data for those dates. All times PKT:

| `--now` | Expected |
| --- | --- |
| Mon 15:00 | the sheet's Phase 1 person on Phase 1 (as today) |
| Tue 15:00 with a lead's "Ivan -> Phase 1" for Tuesday | Ivan added to Phase 1, removed from VIP |
| Tue 15:00 + any later hour the same day | nothing (already done) |
| Wed 15:00, no decision | Ivan back in VIP only |
| a lead edits Wed at 18:30 | applied at the 19:00 run |
| Sat 15:00, the rotation person is named as a VIP rep on the Weekend Cover | rotation person to VIP; the Weekend Cover Phase 1 person (a VIP rep) to Phase 1 |
| Sat 15:00, the rotation person is **not** named | rotation person stays on Phase 1 |
| Sun 15:00 | "closed, holding", nothing changes |
| Mon 15:00 | the sheet's rotation again |
| a decision whose email does not match the Intercom ID | that person skipped and reported, the rest applied |
| calendar unreachable | exactly today's sheet-only behaviour plus one warning after two failed runs |

## 5. Things you need to know

- **An edited night keeps only what was edited.** If a lead edits a person on a weekday (hours, break or queue), that person keeps the edit on that night and everyone else follows the sheet, including a later change of the block's Phase 1 person. The calendar's decisions for that night show the edited person's queue with the reason `day edited by a lead`, and Intercom follows the calendar. "Reset this day to default" (or Edited nights in the calendar) makes the night follow the sheet again. This is how the calendar behaves on screen.
- **Late shift** is time of day, not a team: it moves nobody. **Anchor cover** is sheet-driven and VIP-only: not a decision. **Leave / PTO** are not used: if the Phase 1 rep is off, a lead adds a VIP rep as "Phase 1 queue cover" in the calendar and that arrives as a decision.
- **Saturday** names come from the Weekend Cover (Actual, then Swap, then Planned), read live by the calendar. If Google cannot be read, its stored copy is used and `sources` says so.
- **New roster people** with an ambiguous name need an email written on their roster entry in the calendar, or they are skipped (and reported) until they have one. (There is no field for it in the calendar yet; ask for it.)
- **Timing**: the hourly job moves people at the first run at or after 15:00 PKT, and an edit made in the calendar is applied at the next hourly run. The API reads the saved plan on every call, so edits are visible immediately.

## 6. The API key (done once)

The calendar side: `npx wrangler@4 secret put API_KEYS` with `label:key` pairs (`intercom:<key>`, comma-separated for more), then `.\deploy.ps1`. Remove a pair to revoke it. A refused call is logged in the calendar's activity log as "api refused", at most once every 10 minutes. Google side: Secret Manager `calendar-api-key` holds only the key (without `intercom:`).

## 7. What is deliberately not done

- The calendar does not write to Intercom and the worker has no Intercom token: one writer only.
- The calendar does not replace the automation's own sheet read: the sheet stays the intended state, so the automation keeps working if the calendar is down.
- Nothing in the existing automation was modified by this package; everything above is for you to apply and test in that project.
