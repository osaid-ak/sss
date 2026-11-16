#!/usr/bin/env python3
"""Calendar overlay for the Phase 1 / VIP rotation (drop this file next to rotation.py).

The Shift Plan calendar tells the automation where a LEAD changed something. The automation still reads the sheet for the rotation itself,
and it stays the only thing that writes to Intercom. Everything here is a pure function (no Intercom, no Slack, no file access) except
`fetch_plan`, which makes one read-only HTTP call. Standard library only.

Vocabulary
  shift day   named by the date it starts on; runs from 15:00 PKT that day to 15:00 PKT the next day.
  kind        "weekday" (rotation applies), "saturday" (no rotation), "sunday" (closed: hold, change nothing).
              On a Saturday nobody moves unless the Weekend Cover sheet names them: those it names as VIP or Phase 1 are decisions with
              that queue (the rotation person goes to VIP only if named as a VIP rep, otherwise stays on Phase 1).
  decision    a person whose queue on that shift day differs from normal: {"name", "email", "queue", "reason", "lead"}.
              queue is "phase1", "vip" or "both" (in both teams).
  overlay     the decisions as {intercom_id: queue}, after names are mapped to Intercom IDs and checked against emails.

The one rule that keeps this safe: if anything about the calendar is wrong or unreachable, `fetch_plan` / `parse_plan` raise CalendarError
and the caller carries on with the sheet alone, exactly as it does today.
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


def revert_targets(previous, overlay, plan, exclude=()):
    """People the previous run's overlay moved that today's overlay no longer moves, with the queue they go back to.
    -> {intercom_id: queue}. `previous` is the marker saved last time (state["calendar"]); it remembers who was moved and their names.
    Pass the rotation people (the ids in rotation.py's `people`) as `exclude`: the normal baseline puts them right (the person on
    Phase 1 for the block goes back to Phase 1, everybody else to VIP), and the calendar's `normalQueue` must not override that.
    The queue is the calendar's `normalQueue` for that person."""
    normal = {p["name"].lower(): p.get("normalQueue") for p in plan["roster"] if isinstance(p, dict) and "name" in p}
    names = (previous or {}).get("names") or {}
    skip = {str(i) for i in exclude}
    back = {}
    for who in (previous or {}).get("overlay") or {}:
        if who in overlay or who in skip:
            continue
        q = normal.get(str(names.get(who, "")).lower())
        if q in QUEUES:
            back[who] = q
    return back


def state_marker(entry, overlay, names=None):
    """What to remember after a run: the overlay and the names behind the IDs. The rotation must run again exactly when this changes
    (a lead edit, a Saturday that names the rotation person, the Monday after it that no longer does), and NOT when only the date
    changes: a quiet day after a quiet day must not re-baseline the rotation people, or a manual /phase change to one of them would be
    undone at the next 3pm instead of lasting until the Monday check. `entry` is accepted only so callers keep one signature."""
    return {"overlay": dict(sorted(overlay.items())),
            "names": {k: v for k, v in sorted((names or {}).items()) if k in overlay}}


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
