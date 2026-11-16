# Calendar -> Intercom: what to change in the Intercom Phase Assignment project

Give this whole folder to whoever updates the automation (`calendar_overlay.py`, `test_calendar_overlay.py`, `sample_response.json` and this file).

## 1. What is being added, in one paragraph

The Shift Plan calendar now has a read-only API. It tells the automation where a **lead changed a person's queue** (VIP <-> Phase 1) in the calendar, for any shift day. The automation keeps reading the sheet for the rotation itself and stays the **only thing that writes to Intercom**. The calendar's answer is an *overlay* on top of what the automation already does. If the calendar is down, wrong or confusing, the automation ignores it for that run and behaves exactly as it does today.

Rules the leads asked for:

1. A rep moved VIP -> Phase 1 (or Phase 1 -> VIP) on a day in the calendar is moved in Intercom at **15:00 PKT of that day**, and goes back to their normal team at 15:00 PKT the next shift day unless that day also says otherwise.
2. **Saturday**: the rotation does not apply, and **nobody moves unless the Weekend Cover sheet names them**. The rep on Phase 1 for the rotation goes to **VIP at Saturday 15:00 PKT only if the Weekend Cover names them as a VIP rep that Saturday**, and returns to **Phase 1 at Monday 15:00 PKT**. If they are not named, they stay on Phase 1. The Weekend Cover Phase 1 person (if they are a VIP rep) is on Phase 1 for Saturday. **Sunday is closed: change nothing.**
3. **The right person**: the calendar sends each person's **email**, and the automation checks that the Intercom ID it is about to move belongs to the teammate with that email. A mismatch skips that person only (section 3.3).
4. It must not fail: every problem falls back to the sheet-only behaviour, with one Slack warning.
5. **Always live**: the calendar reads the Google Sheet itself on every API call and its lead decisions are saved on the server the moment a lead saves. Nobody has to open the calendar (section 2).

## 2. The API (already built in the calendar worker)

`GET https://shift-plan.autoleap-sss.workers.dev/api/v1/intercom-plan?from=YYYY-MM-DD&days=N`

- Header `Authorization: Bearer <API key>`. No Google sign-in, no cookies. Read only (any other method is 405).
- `from` defaults to the shift day running now, `days` defaults to 8 (1 to 31).
- Errors: 401 bad or missing key, 400 bad parameters, 503 the calendar has no plan yet. Answers are never cached.

**Is it live? Does it need someone to open the calendar? No.** On every call the worker:
1. reads the team plan from its own storage. A lead's edit, cover or roster change is saved there the moment the lead saves it, so it is visible to the next API call (no browser has to stay open);
2. reads the **Weekend Cover** and **VIP Coverage Plan** tabs of the Google Sheet itself (about a second), so Saturday names and the rotation are the sheet's current ones, not a copy left by whoever last opened the calendar;
3. if a tab cannot be read (Google down, the sheet no longer link-readable), it uses the copy stored in the plan for that tab and says so in `sources` (`"stored"` instead of `"sheet"`). The automation should log that (`source_notes` in the module) but can keep going: the stored copy is right unless the sheet changed since someone last opened the calendar.

The one thing that is not live is anything nobody has ever entered: for example, nothing new happens in Intercom for a change a lead *intends* but did not save in the calendar.

Answer (see `sample_response.json`):

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
      "decisions": [{ "name": "Ivan", "email": "ivan@autoleap.com", "queue": "phase1", "reason": "day edited by a lead", "lead": false }]
    }
  ]
}
```

(`sample_response.json` is a real answer from the worker's code, with a Saturday where the rotation person is named as VIP and one where they are not.)

- **Shift day** = the date it starts on, 15:00 PKT to 15:00 PKT. After midnight it is still the previous date's shift day.
- `kind`: `weekday` (rotation applies), `saturday` (no rotation), `sunday` (closed, `decisions` is always empty: hold).
- `decisions` on a weekday lists only people whose queue that day **differs from normal**. Normal = the roster's queue, with the rotation's Phase 1 person on Phase 1. On a **Saturday** it lists **everyone the Weekend Cover names** (Phase 1 person as `phase1`, VIP people as `vip`), whatever their normal queue is; a person who is not named is not in the list and must be left alone. `queue` is `phase1`, `vip`, `both` or `lead` (ignore `lead`: no Phase 1 / VIP role that day).
- `reason` is one of: `day edited by a lead`, `Phase 1 queue cover`, `VIP late shift cover`, `Phase 1 late shift cover`, `weekend cover`.
- `email` (on decisions and the roster) is the person's email: the one written on their roster entry in the calendar if there is one, otherwise the single allowed teammate email that contains their name (`muhammad.jawad@...` for Jawad), otherwise `null`. A `null` email means the person cannot be verified (section 3.3).
- `rotationPhase1` is who the **sheet** (read live) says is on Phase 1 for the block; on a Saturday it is Friday's block person. It is information for shadow mode; your own sheet read stays the source of truth for the rotation.
- `roster[].normalQueue` is each person's queue with nothing decided (used to put people back).
- `sources` says where the sheet data came from (`sheet` = read just now, `stored` = the calendar's saved copy).
- Names are the calendar's roster names (first names). Match them to Intercom IDs with the map in your config (section 3.1) and **verify with the email** (section 3.3). **Never guess a name.**

How the calendar produces it (so you can trust it): the rules are the calendar page's own. A day a lead edited by hand keeps its stored roles; a Phase 1 queue cover moves a VIP rep to Phase 1 for that night; late shift cover sets the covering person's queue; a Saturday follows the Weekend Cover names. The weekday rules were checked against the page itself on 800 person-days of the real plan, including hand edits and covers: no differences. The Saturday rule (everyone the Weekend Cover names, with that queue) is simpler than the page's, which builds a Saturday only from those names; it is covered by the worker's tests, and the sheet reader was compared with the page's reader on the live tabs (41 weekends and 50 blocks, identical).

## 3. Changes to make in the automation

Files to add: `calendar_overlay.py` (next to `rotation.py`) and its test. Add `calendar_overlay.py` to the `Dockerfile` `COPY` line. It needs only the standard library.

### 3.1 Config (`rotation_config.cloud.json`)

```json
"calendar": {
  "mode": "off",
  "url": "https://shift-plan.autoleap-sss.workers.dev",
  "apply_to_leads": false,
  "require_email": true,
  "people": { "Raza": "5573818", "Ivan": "5861947", "Raahym": "6472238", "Zarminay": "6745226", "Jawad": "7061104", "Ammana": "7665017" }
}
```

`mode`: `off` (today's behaviour, nothing changes), `shadow` (read the calendar, post what it *would* do, change nothing), `on` (apply). Start at `off`, go to `shadow`, then `on`.

`people` is the name -> Intercom ID map used for calendar decisions. Start with the six rotation people. To let leads move other reps too, add them from `intercom_phase_users.csv`:
Ayeshah 8660665, Laraib 6472290, Qasim 10783248, Schanzae 7113103, Zunair 10510117, and (leads, only used when `apply_to_leads` is true) Ashraf 6472226, Osaid 6745352. A decision for a name that is not in this map is skipped and reported (unless the email identifies exactly one Intercom teammate).

`require_email` (default true): a decision whose email the calendar could not provide is not applied, because the ID cannot be verified. Set it to false only if you accept the name map alone for those people.

Check each person's real Intercom team before adding them. For example the CSV lists Jawad as "Phase 1, Phase 2" without VIP, but he is in the rotation people, so moving him back to VIP would add him to VIP.

### 3.2 Secret

Environment variable `CALENDAR_API_KEY` from Secret Manager (create `calendar-api-key`, mount it on the **phase-rotation job** and, if you want it in `/phase status`, on `phase1-commands`). Never put it in the repo, `.env.example` gets only an empty `CALENDAR_API_KEY=` line.

### 3.3 `rotation.run()` flow

Everything below is `mode == "on"` unless it says shadow. With `mode == "off"` none of it runs.

```python
import calendar_overlay as co

# at the top of run(), after `tz` / `handover_time` are known
cal = cfg.get("calendar") or {}
mode = cal.get("mode", "off")
day = co.shift_day(now)            # the shift day running now (15:00 PKT boundary)
kind = co.day_kind(day)            # "weekday" | "saturday" | "sunday"   (from the date alone, not from the calendar)
plan = entry = overlay = None
notes, names = [], {}
if mode in ("shadow", "on"):
    try:
        import phase1_cmd  # lazy: it imports this module
        admins = phase1_cmd.list_admins(client)   # Intercom teammates: id + email, for the email check
        plan = co.fetch_plan(cal["url"], os.environ["CALENDAR_API_KEY"], day, days=1)
        entry = co.day_entry(plan, day)
        overlay, notes, names = co.overlay_for(entry, cal["people"], cal.get("apply_to_leads", False),
                                               admins=admins, require_email=cal.get("require_email", True))
        notes += co.source_notes(plan)
    except (co.CalendarError, KeyError, SystemExit) as e:   # KeyError: key or config missing; SystemExit: Intercom's helper exits on an API error
        # carry on with the sheet only; warn once (see 3.6)
        overlay = None
```

1. **Sunday** (`mode == "on"` and `kind == "sunday"`): print "Sunday: closed, holding" and `return "waiting"`. Nothing changes until Monday 15:00. This does not need the calendar.
2. **Saturday** (`mode == "on"` and `kind == "saturday"`): there is no rotation, but **nobody moves unless the calendar says so** (the Weekend Cover names). So the baseline is *the same person as Friday*, and the calendar's overlay does the rest:
   - Your current code returns "waiting" after Saturday 15:00 because the Monday-to-Friday block has ended (`active_block` returns None). Look the block up **as of Friday** instead, before that early return: `block = active_block(blocks, datetime.combine(co.rotation_day(day), handover_time, tzinfo=tz), handover_time, tz)`. Use that `block` and its `person`/`target` exactly as on a weekday. (`rotation_day` is the day itself on weekdays, Friday on Saturday and Sunday.)
   - the state `key` stays `f"{block['n']}:{person}"`; what makes the run happen on Saturday is the overlay marker (step 4).
   - If the Weekend Cover names the rotation person as a VIP rep, the calendar sends `{"name": <them>, "queue": "vip"}` and the overlay moves them to VIP for the Saturday. If it does not name them, there is no decision and they stay on Phase 1.
3. **Weekday**: unchanged (`active_block`, `person`, `key`), except the "already applied" test below.
4. **"Already applied" test**. Today `state["applied"] == key and not force and not sync` returns "unchanged". With the calendar the run must also happen when the **overlay changes** (an edit in the calendar, a Saturday that names the rotation person, the Monday that no longer does). It must **not** run just because the date changed: a quiet day after a quiet day leaves the rotation people alone, so manual `/phase` changes last until the Monday check as they do today.

   ```python
   marker = co.state_marker(entry, overlay, names) if (mode == "on" and overlay is not None) else None
   unchanged = state.get("applied") == key and (marker is None or state.get("calendar") == marker)
   if unchanged and not force and not sync:
       return "unchanged"
   ```

   This is also what moves the rotation person **back to Phase 1 on Monday**: Saturday's marker (an overlay with them as VIP) differs from Monday's (empty), so the run happens even though the block number and person are the same as last Friday, and the baseline puts them back on Phase 1. If the Weekend Cover did not name them, nothing moved on Saturday and nothing needs to run on Monday.
5. After your existing `p1_final` / `vip_final` are computed (baseline), and **before** the "Safety" check, apply the overlay:

   ```python
   if mode == "on" and overlay is not None:
       M_ids = [str(i) for i in cfg["people"].values()]
       back = co.revert_targets(state.get("calendar"), overlay, plan, exclude=M_ids)
       p1_final, vip_final = co.apply_overlay(p1_final, vip_final, {**back, **overlay})
       touchable |= set(back) | set(overlay)          # the safety rule may now change these ids
       # keep additions-before-removals: recompute p1_add / vip_add from the new finals exactly as you do now
   ```

   `back` puts people the *previous* overlay moved (and today's does not) back to their `normalQueue`. The rotation people are excluded: the baseline decides where they go.
6. After a successful apply, store the marker: `if marker is not None: state["calendar"] = marker`. **Do not touch `state["calendar"]` when the calendar failed** (overlay is None): the next good run still needs the old overlay to revert people.
7. Slack: your message builder already names anyone outside the rotation people who moved ("has been added to Phase 1"). For a rotation person moved by the calendar the normal builder names them too. Append the reason when you can, from `entry["decisions"][i]["reason"]`, e.g. `(calendar: Phase 1 queue cover)`, and post the `notes` (people skipped because of an email mismatch, unknown names, leads).

**The email check, exactly.** For every decision the module (with `admins` passed) requires: the Intercom ID from your name map belongs to a teammate, and that teammate's email equals the email the calendar sent (case-insensitive). If not, **that person is skipped and reported, everyone else is still handled**. If the name is not in your map but the email identifies exactly one Intercom teammate, that teammate is used. If the calendar has no email for the person (`null`), the decision is skipped unless `require_email` is false. The calendar's email is the one written on the roster entry, or the single allowed teammate email that contains the person's name, so a new roster person with an ambiguous name needs an email on their roster entry or they will be skipped (and reported) until they have one.

Leave alone, exactly as they are: the hourly schedule, the Monday 15:00 / 18:00 weekly check (its reset still undoes recorded manual `/phase` changes, then the overlay is applied on top), `/phase`, the evening cover (`surge.py`), the state bucket layout (you only add the `calendar` key), and the safety rules (only named people change, no team empty).

### 3.4 Shadow mode (do this first, for about two weeks)

In `shadow`, run the fetch and `overlay_for`, then **write nothing to Intercom**. Post (to the alert channel `C0BEH2T7L1Y`, once per `(day, marker)`, remember it in `state["calendar_shadow"]`):

- what the overlay *would* do: `"Calendar (shadow): Ivan would move to Phase 1 for Tue 17 Nov (Phase 1 queue cover)"`;
- the Saturday/Sunday plan: `"Calendar (shadow): Sat 21 Nov 15:00: Jawad (named as VIP on the Weekend Cover) would move to VIP, Ivan to Phase 1; Mon 23 Nov: Jawad back to Phase 1"`;
- the cross-check `co.rotation_check(entry, sheet_person)`: both sides read the sheet live, so a difference is worth looking at (for example the sheet changed between the two reads, or `sources` says the calendar used its stored copy).
- every string in `notes` (unknown names, leads skipped).

Go to `on` when two weeks of shadow messages are all what the leads meant.

### 3.5 Rollback

Set `"mode": "off"` and redeploy the config (the image does not need rebuilding if config is mounted; otherwise rebuild). Or revoke the key (section 6): the calendar fetch then fails and the automation falls back to the sheet. Note that with `mode: on` the **weekend rule is date-based** and still applies without the calendar; `off` is the only full rollback.

### 3.6 Failure handling ("must not fail")

| Situation | What happens |
| --- | --- |
| calendar unreachable, timeout (10 s), 5xx | one retry after 2 s, then ignore the calendar for this run |
| 401 (key wrong or revoked) | no retry, ignore the calendar, warn |
| answer is not JSON, wrong `version`, missing day, a malformed decision, calendar and automation disagree on the day kind | `CalendarError`, ignore the calendar |
| more than 8 people changed on one day | `CalendarError`, ignore the calendar, warn (looks like a mistake) |
| a decision names someone not in `cal["people"]` | that decision is skipped and reported, the rest apply |
| a lead is in the decisions | skipped unless `apply_to_leads` |
| Intercom write fails | your existing refusal/verification/Slack error path, unchanged |

"Ignore the calendar" always means: carry on with the sheet-only logic. Warn with your existing `report_problem(cfg, slack, "calendar: " + text, ..., transient=True)` so it posts once after two failures in a row, and `clear_problem` style "working again" when it recovers (use a separate key from the sheet problems so one does not clear the other).

## 4. Tests

- `python -m unittest test_calendar_overlay -v` runs 40 checks of the module (shift day boundary, plan validation, decisions, both Saturday cases, Sunday, name map, the email check, leads, limits, overlay on the team lists, reverting, retries).
- Dry runs with your existing `--now` option, once the flow is in (use a **dry run**, no `--apply`). The calendar must have the matching decisions for the dates you test; use the day-by-day table below as the acceptance list. All times are PKT.

| `--now` | Expected |
| --- | --- |
| Mon 15:00 | rotation person on Phase 1 (as today) |
| Tue 15:00 with a calendar decision "Ivan -> Phase 1" | Ivan added to Phase 1, removed from VIP |
| Wed 15:00, no decision | Ivan back in VIP only (baseline) |
| Fri 14:59 | still Friday's shift day, nothing new |
| Sat 15:00, the rotation person is named as a VIP rep on the Weekend Cover | rotation person: out of Phase 1, into VIP. The Weekend Cover Phase 1 person (a VIP rep) added to Phase 1 |
| Sat 15:00, the rotation person is **not** named | rotation person stays on Phase 1, nobody else of the rotation moves |
| Sat 18:00, Sun 15:00 | unchanged, "closed, holding" on Sunday |
| Mon 15:00 | rotation person back on Phase 1, weekend cover person back to VIP |
| a decision whose email does not match the Intercom ID's email | that person skipped and reported, others applied |
| any time with the calendar unreachable | exactly today's behaviour (plus the Saturday rule if `on`) |
| a decision for a name not in `people` | skipped, reported, the rest applied |

## 5. Things you need to know

- **Hand-edited days are frozen in the calendar.** If a lead edits a weekday (hours, anything) it keeps that day's roles from then on. If the sheet later swaps the Phase 1 person for that block, the calendar shows (and the API reports) the *edited* day. Intercom will follow the calendar for that day. "Reset this day to default" in the calendar makes the day follow the sheet again. This is how the calendar already behaves on screen.
- **Saturday names are read from the sheet live** on every call (Weekend Cover tab, Actual Cover, then Swap, then Planned). If Google cannot be read, the calendar's stored copy is used and `sources` says so.
- **Late shift** (the Late Shift person's 10:30pm hours) is a time-of-day thing and does **not** move anyone between teams. Only queue changes do.
- **Anchor shift cover** is sheet-driven and VIP-only: not a decision.
- **Leave / PTO** are not used. If the Phase 1 rep is off, a lead adds a VIP rep as "Phase 1 queue cover" in the calendar and that appears as a decision.
- **Surge** (evening cover) works on live Intercom state and is unchanged. A person the calendar moved to VIP while surge has them added is a rare overlap: surge only releases people it added, and the safety rules still apply.
- **Manual `/phase` changes** stay until the Monday 15:00 reset or the next overlay change; when the overlay changes the rotation people are re-baselined (the same thing a new block does today).
- **Timing**: the hourly job moves people at the first run at or after 15:00 PKT (minute 0 of the 15:00 hour), and an edit made in the calendar for the running shift day is applied at the next hourly run. Calendar edits are visible to the API immediately (it reads the saved plan on every call).

## 6. Setting up the API key (you, once)

The calendar side (done in this repo; goes live with `.\deploy.ps1`):

1. In the `worker` folder, make a long random key and store it as a secret named `API_KEYS` in the form `label:key`, for example `intercom:` followed by 64 random hex characters:

   ```
   npx wrangler@4 secret put API_KEYS
   ```

   (paste `intercom:<the key>` at the hidden prompt). Several automations can share the secret as a comma-separated list (`intercom:<key1>,other:<key2>`), and removing one entry revokes only that one. The key is never logged or returned. A refused request (no or wrong key) is written to the activity log as "api refused", at most one line every 10 minutes.
2. Deploy: `.\deploy.ps1` (this also signs everyone out of the calendar once, as every deploy does).
3. Test from any terminal (replace the key):

   ```
   curl -s -H "Authorization: Bearer <key>" "https://shift-plan.autoleap-sss.workers.dev/api/v1/intercom-plan?days=3"
   ```

   Without the header you must get 401.

Then store the same key (only the part after `intercom:`) in Secret Manager as `calendar-api-key`.

## 7. What is deliberately not done

- The calendar does not write to Intercom, and the worker has no Intercom token. One writer only.
- The calendar does not decide the rotation for the automation: the automation keeps its own live sheet read for who is on Phase 1 for the block. The calendar reads the same tabs on every API call only to answer the Saturday names and to judge edited days against the current rotation.
- Nothing in the existing automation was modified; everything above is for you to apply and test in that project.
