#!/usr/bin/env python3
"""Sheet baseline + calendar changes for the Phase 1 / VIP moves (drop this file next to rotation.py).

Two inputs, one rule. The INTENDED state is the sheet's (the Actual Cover column the automation already reads live: who is on Phase 1
for the block, everybody else in VIP). On top of it come the calendar's CHANGES (a lead moved someone between Phase 1 and VIP, a Phase 1
queue cover, a Saturday that names people). The calendar wins wherever it says something. The automation runs every hour and acts on what
CHANGED since its last run, so a lead's edit made today is applied at the next hourly run, the next day follows at 15:00 PKT, the next
rotation block on its Monday, and the Monday check brings everybody in line. The automation stays the only thing that writes to Intercom.

Everything here is a pure function (no Intercom, no Slack, no file access) except `fetch_plan`, which makes one read-only HTTP call.
Standard library only.

Vocabulary
  shift day   named by the date it starts on; runs from 15:00 PKT that day to 15:00 PKT the next day.
  kind        "weekday", "saturday" (no rotation: nobody moves unless the Weekend Cover names them) or "sunday" (closed: hold).
  decision    a person whose queue that shift day differs from normal in the calendar: {"name", "email", "queue", "reason", "lead"}.
              queue is "phase1", "vip" or "both" (in both teams).
  baseline    {intercom_id: queue} from the sheet, for the rotation people.
  moves       the calendar's decisions as {intercom_id: queue}, after names are mapped to Intercom IDs and checked against emails.
  desired     what the automation wants for each person today: moves over baseline.

The one rule that keeps this safe: if the calendar cannot be read or does not make sense, `fetch_plan` / `parse_plan` raise CalendarError and
the caller carries on with the sheet alone, exactly as it did before the calendar existed.
"""
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import timedelta, timezone

PKT = timezone(timedelta(hours=5))
QUEUES = ("phase1", "vip", "both")
MAX_OVERLAY = 8  # more people than this changed on one shift day looks like a mistake: refuse and warn instead of moving them


class CalendarError(Exception):
    """The calendar could not be read or did not make sense. The caller ignores the calendar for this run."""


# --------------------------------------------------------------------------- time

def shift_day(now):
    """The shift day running at `now`: from 15:00 PKT it is today's date, before that it is still yesterday's."""
    return (now.astimezone(PKT) - timedelta(hours=15)).date()


def day_kind(day):
    wd = day.weekday()  # Monday is 0
    return "sunday" if wd == 6 else "saturday" if wd == 5 else "weekday"


def rotation_day(day):
    """The date whose sheet block decides who the rotation puts on Phase 1 for this shift day: the day itself on weekdays, and Friday
    for Saturday and Sunday (blocks run Monday to Friday, so the block is over on Saturday, but its person is who stays on Phase 1
    unless the Weekend Cover says otherwise). Use it to find `block` / `person` for a Saturday instead of treating the block as ended."""
    return day - timedelta(days={5: 1, 6: 2}.get(day.weekday(), 0))


# --------------------------------------------------------------------------- read

def fetch_plan(base_url, api_key, day, days=3, timeout=10, retries=1, opener=None):
    """GET {base_url}/api/v1/intercom-plan?from=<day>&days=<n>. Returns the parsed, validated plan or raises CalendarError.
    One retry on a network error or a 5xx; a 401/403/4xx is not retried (the key or the request is wrong). The calendar reads the Google
    Sheet itself on every call (a few seconds at most), so allow it time: the default timeout is 10 seconds."""
    url = f"{base_url.rstrip('/')}/api/v1/intercom-plan?" + urllib.parse.urlencode({"from": day.isoformat(), "days": days})
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json",
                                               "User-Agent": "phase-rotation/1"})
    last = None
    for attempt in range(retries + 1):
        try:
            with (opener or urllib.request.urlopen)(req, timeout=timeout) as resp:
                return parse_plan(resp.read().decode("utf-8"), day, days)
        except urllib.error.HTTPError as e:
            last = CalendarError(f"calendar answered HTTP {e.code}")
            if e.code < 500:
                break
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            last = CalendarError(f"calendar not reachable: {e}")
        if attempt < retries:
            time.sleep(2)
    raise last


def parse_plan(text, day, days=1):
    """Validate the answer. Anything unexpected raises CalendarError: a half-understood plan must never move people."""
    try:
        plan = json.loads(text)
    except ValueError:
        raise CalendarError("calendar answer is not JSON")
    if not isinstance(plan, dict) or plan.get("version") != 1:
        raise CalendarError(f"unsupported calendar plan version: {plan.get('version') if isinstance(plan, dict) else None!r}")
    entries = plan.get("days")
    if not isinstance(entries, list) or not entries:
        raise CalendarError("calendar plan has no days")
    seen = {}
    for e in entries:
        if not isinstance(e, dict) or not isinstance(e.get("date"), str) or e.get("kind") not in ("weekday", "saturday", "sunday"):
            raise CalendarError("calendar plan has a malformed day")
        if not isinstance(e.get("decisions"), list):
            raise CalendarError(f"calendar plan day {e.get('date')} has no decisions list")
        q = e.get("queues")
        if q is not None and (not isinstance(q, dict) or any(v not in QUEUES + ("lead",) for v in q.values())):
            raise CalendarError(f"calendar plan day {e['date']} has malformed queues")
        for d in e["decisions"]:
            if not isinstance(d, dict) or not isinstance(d.get("name"), str) or d.get("queue") not in QUEUES + ("lead",):
                raise CalendarError(f"calendar plan day {e['date']} has a malformed decision: {d!r}")
        seen[e["date"]] = e
    for i in range(days):
        want = (day + timedelta(days=i)).isoformat()
        if want not in seen:
            raise CalendarError(f"calendar plan does not include {want}")
        if day_kind(day + timedelta(days=i)) != seen[want]["kind"]:
            raise CalendarError(f"calendar and automation disagree on what kind of day {want} is")
    if not isinstance(plan.get("roster"), list):
        raise CalendarError("calendar plan has no roster")
    return plan


def day_entry(plan, day):
    for e in plan["days"]:
        if e["date"] == day.isoformat():
            return e
    raise CalendarError(f"calendar plan does not include {day.isoformat()}")


# --------------------------------------------------------------------------- decisions -> overlay

def overlay_for(entry, name_ids, apply_to_leads=False, admins=None, require_email=True):
    """-> (overlay {intercom_id: queue}, problems [text], names {intercom_id: calendar name}).

    Who is who: the name is looked up in `name_ids` ({"Raza": "5573818", ...}, case-insensitive). A name that is not in the map is
    skipped and reported, never guessed, unless the calendar sent that person's email and exactly one Intercom teammate has it.

    Email check (the fallback that makes sure the right person is moved): pass `admins`, the Intercom teammates as
    [{"id": ..., "email": ...}] (phase1_cmd.list_admins(client) already returns this). Then every decision's Intercom ID must belong to a
    teammate whose email equals the email the calendar sent. A different email, an ID that is not a teammate, or (with `require_email`)
    a decision without an email: that person is skipped and reported, nobody else is affected. Without `admins` the check is skipped.

    Leads are skipped unless `apply_to_leads`. More than MAX_OVERLAY people raises CalendarError."""
    ids = {n.lower(): str(i) for n, i in name_ids.items()}
    by_id, by_email = {}, {}
    for a in admins or []:
        mail = (a.get("email") or "").strip().lower()
        by_id[str(a["id"])] = mail
        if mail:
            by_email.setdefault(mail, []).append(str(a["id"]))
    overlay, problems, names = {}, [], {}
    if entry["kind"] == "sunday":
        return overlay, problems, names  # closed: nobody is decided, the caller holds what it has
    for d in entry["decisions"]:
        q = d["queue"]
        if q not in QUEUES:
            continue  # "lead" (no Phase 1 / VIP role that day): nothing to do in these two teams
        mail = (d.get("email") or "").strip().lower()
        who = ids.get(d["name"].lower())
        if admins is not None:
            if who is None:
                found = by_email.get(mail, []) if mail else []
                if len(found) != 1:
                    problems.append(f"{d['name']} ({d.get('reason', '')}) is not in the Intercom name map and the email "
                                    f"{mail or '(none)'} does not identify one teammate; skipped")
                    continue
                who = found[0]
            elif who not in by_id:
                problems.append(f"{d['name']}: Intercom ID {who} is not a teammate; skipped")
                continue
            elif mail and by_id[who] != mail:
                problems.append(f"{d['name']}: the calendar says {mail} but Intercom ID {who} is {by_id[who] or 'without an email'}; skipped")
                continue
            elif not mail and require_email:
                problems.append(f"{d['name']}: the calendar has no email for them, so the Intercom ID {who} cannot be checked; skipped")
                continue
        elif who is None:
            problems.append(f"{d['name']} ({d.get('reason', '')}) is not in the Intercom name map; skipped")
            continue
        if d.get("lead") and not apply_to_leads:
            problems.append(f"{d['name']} is a lead; the calendar says {q} but leads are left alone")
            continue
        overlay[who] = q
        names[who] = d["name"]
    if len(overlay) > MAX_OVERLAY:
        raise CalendarError(f"the calendar changes {len(overlay)} people on {entry['date']} (limit {MAX_OVERLAY}); ignoring it")
    return overlay, problems, names


def apply_overlay(p1, vip, overlay):
    """The two team lists after the overlay: phase1 = in Phase 1 and out of VIP, vip = the opposite, both = in both."""
    p1, vip = list(p1), list(vip)
    for who, q in overlay.items():
        if q in ("phase1", "both") and who not in p1:
            p1.append(who)
        if q in ("vip", "both") and who not in vip:
            vip.append(who)
        if q == "phase1":
            vip = [i for i in vip if i != who]
        if q == "vip":
            p1 = [i for i in p1 if i != who]
    return p1, vip


def reasons(entry):
    """{calendar name: why the calendar moved them} for a day's decisions, for the Slack message."""
    return {d["name"]: d.get("reason", "") for d in entry.get("decisions", [])}


# --------------------------------------------------------------------------- the hourly decision

def sheet_baseline(rotation_ids, person_id):
    """What the sheet intends for the rotation people: the block's Phase 1 person on Phase 1, everybody else in VIP.
    `rotation_ids` = the IDs in rotation.py's `people`; `person_id` = the Phase 1 person's ID (None: nobody)."""
    return {str(i): ("phase1" if person_id is not None and str(i) == str(person_id) else "vip") for i in rotation_ids}


def desired_state(baseline, moves, last_names, plan):
    """-> {intercom_id: queue}. Precedence: the calendar's moves, then the sheet's baseline, then (for people the calendar moved on an
    earlier run and no longer does, who the baseline does not cover) their normal queue from the calendar's roster, so they go back."""
    normal = {p["name"].lower(): p.get("normalQueue") for p in plan["roster"] if isinstance(p, dict) and "name" in p}
    desired = {}
    for who, name in (last_names or {}).items():
        q = normal.get(str(name).lower())
        if q in QUEUES:
            desired[who] = q
    desired.update(baseline)
    desired.update(moves)
    return desired


def pending_targets(desired, last, reset=False):
    """Who to act on this run. The automation acts on CHANGES in what it wants, so a manual /phase change lasts until what the sheet or the
    calendar wants for that person next changes (or the weekly check). On a reset (the Monday check, --force) and on the very first run
    (`last` is None) everybody is brought in line. `last` is the "desired" stored by the previous run."""
    if reset or last is None:
        return dict(desired)
    return {who: q for who, q in desired.items() if last.get(who) != q}


def run_plan(plan, entry, name_ids, state, p1, vip, baseline, reset=False, apply_to_leads=False, admins=None, require_email=True,
             max_changes=8):
    """The whole decision for one hourly run, as a pure function (no Intercom, no state writes).

    `state` is what the previous run stored (None the first time): {"desired": {id: queue}, "names": {id: name}}.
    `p1` / `vip` are the current Intercom memberships (lists of ID strings), `baseline` is `sheet_baseline(...)`.
    Returns a dict:
      hold      True on a Sunday: change nothing and do not touch the state
      desired   what is wanted today          targets  the part of it to act on now
      p1, vip   the two team lists after the moves (the caller writes additions before removals, as rotation.py already does)
      changed   IDs whose membership actually differs from now
      problems  people skipped (email mismatch, unknown name, lead...)       moves   the calendar's moves today
      new_state what to store after a successful, verified write
    Raises CalendarError if more than `max_changes` people would move (a mistake is more likely than a real mass change)."""
    if entry["kind"] == "sunday":
        return {"hold": True, "desired": {}, "targets": {}, "p1": list(p1), "vip": list(vip), "changed": [], "problems": [], "moves": {},
                "new_state": state}
    moves, problems, names = overlay_for(entry, name_ids, apply_to_leads, admins, require_email)
    state = state or {}
    desired = desired_state(baseline, moves, state.get("names"), plan)
    last = state.get("desired")
    targets = pending_targets(desired, last, reset)
    new_p1, new_vip = apply_overlay(p1, vip, targets)
    changed = sorted({i for i in set(p1) | set(vip) | set(new_p1) | set(new_vip) if (i in p1, i in vip) != (i in new_p1, i in new_vip)})
    if len(changed) > max_changes:
        raise CalendarError(f"{len(changed)} people would move at once (limit {max_changes}); not applying it")
    return {"hold": False, "desired": desired, "targets": targets, "p1": new_p1, "vip": new_vip, "changed": changed, "problems": problems,
            "moves": moves, "new_state": {"desired": {**(last or {}), **desired}, "names": names}}


def cross_check(entry, desired, id_names):
    """Shadow-mode check: where the calendar says each person is (its `queues`) against what the automation wants. -> [text].
    A difference means the sheet and the calendar disagree about someone (or the sheet changed between the two reads): look at it, do not
    act on it. `id_names` = {intercom_id: calendar name}."""
    queues = entry.get("queues")
    if queues is None:
        return []
    by_name = {n.lower(): q for n, q in queues.items()}
    out = []
    for who, q in sorted(desired.items()):
        name = id_names.get(who, "")
        theirs = by_name.get(name.lower())
        if theirs and theirs != q:
            out.append(f"{entry['date']}: {name}: the automation wants {q} but the calendar has {theirs}")
    return out


def source_notes(plan):
    """Information for the log: the calendar could not read the sheet itself just now, so part of its answer comes from its stored copy
    (still right unless the sheet changed since someone last opened the calendar). -> [text]."""
    out = []
    src = plan.get("sources") or {}
    if src.get("weekendCover") != "sheet":
        out.append("the calendar used its stored Weekend Cover names (it could not read the sheet just now)")
    if src.get("rotation") != "sheet":
        out.append("the calendar used its stored rotation (it could not read the sheet just now)")
    return out


def rotation_check(entry, sheet_person):
    """Shadow-mode cross-check: the calendar's idea of the rotation person against the sheet's. -> warning text or None.
    A difference usually means the calendar had to use its stored copy; see `source_notes`. Information, not an error."""
    if entry["kind"] == "sunday":
        return None
    cal = entry.get("rotationPhase1")
    if (cal or None) != (sheet_person or None):
        return f"{entry['date']}: the sheet puts {sheet_person or 'nobody'} on Phase 1 but the calendar has {cal or 'nobody'}"
    return None
