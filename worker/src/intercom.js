// Read-only plan for automations (Intercom team moves): which people the calendar says are in Phase 1 or VIP on a given shift day.
//
// A "shift day" is named by the date it starts on and runs from 15:00 PKT that day to 15:00 PKT the next day (the board is 3pm to 8am PKT,
// and overnight hours stay on the start day, as everywhere in the calendar).
//
// The calendar does not say where everybody is. It says only where a LEAD CHANGED something, as "decisions": a person whose queue on that
// day differs from the normal one. The normal queue is the roster's, with the sheet's rotation Phase 1 person on Phase 1 (Monday to Friday).
// Everything else (the rotation itself) stays with the automation, which reads the sheet live.
//
// The rules below are the calendar page's own (resolveDay): a hand-edited day keeps its stored roles, a Phase 1 queue cover moves a VIP
// rep to Phase 1 for that night, late shift cover sets the queue of the person covering, and a Saturday follows the Weekend Cover sheet.
// Sunday is closed.
//
// Saturday: there is no rotation, so nobody moves unless the Weekend Cover sheet names them. Everyone it names as Phase 1 or VIP that day is
// reported as a decision with that queue (so the rotation person, if named as a VIP, goes to VIP for the Saturday, and one who is not named
// stays where they are). Sheet data is read live when the caller passes it (see sheets.js); the stored copy is the fallback.

const DAY_MS = 86400000;
const PKT_MS = 5 * 3600000;
const KEY = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function utcDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function keyOf(date) {
  return date.toISOString().slice(0, 10);
}
export function addDaysKey(key, n) {
  return keyOf(new Date(utcDate(key).getTime() + n * DAY_MS));
}
// The shift day that is running at this moment: from 15:00 PKT it is today's date, before that it is still yesterday's.
export function shiftDayAt(nowMs) {
  return keyOf(new Date(nowMs + PKT_MS - 15 * 3600000));
}
export function weekdayOf(key) {
  return utcDate(key).getUTCDay();
}

export function queueOfRoles(roles) {
  if (!roles) return "lead";
  if (roles.phase1 && roles.vip) return "both";
  if (roles.phase1) return "phase1";
  if (roles.vip) return "vip";
  return "lead";
}
function personQueue(p) {
  if (p && p.roles && typeof p.roles === "object") return queueOfRoles(p.roles);
  // an older stored person without roles: the group and queue words it carries
  const q = p && p.queue;
  if (q === "both" || q === "phase1" || q === "vip") return q;
  return "lead";
}
function isLead(p) {
  return !!(p && ((p.roles && p.roles.lead) || p.group === "Leads"));
}

function blockOn(blocks, key) {
  return (blocks || []).find(b => b && b.start <= key && key <= b.end) || null;
}
// The sheet's spelling of a name -> the roster's: exact (any case), then a single roster name that starts the other way round, else as written.
function matchName(raw, roster) {
  const needle = String(raw || "").trim().toLowerCase();
  if (!needle) return "";
  const exact = roster.find(p => p.name.toLowerCase() === needle);
  if (exact) return exact.name;
  const loose = roster.filter(p => p.name.toLowerCase().startsWith(needle) || needle.startsWith(p.name.toLowerCase()));
  return loose.length === 1 ? loose[0].name : String(raw).trim();
}
// The person's email: the one written on the roster entry, otherwise the one allowed email whose name part contains their name
// (muhammad.jawad@ for Jawad). More than one candidate, or none: null, so the caller cannot treat it as verified.
export function emailFor(person, emails) {
  const own = person && typeof person.email === "string" ? person.email.trim().toLowerCase() : "";
  if (own.includes("@")) return own;
  const name = String((person && person.name) || "").trim().toLowerCase();
  if (!name) return null;
  const hits = [...(emails || [])].filter(e => String(e).split("@")[0].toLowerCase().split(/[._-]+/).includes(name));
  return hits.length === 1 ? String(hits[0]).toLowerCase() : null;
}

// One shift day: kind, what the calendar thinks the rotation is, the decisions (people whose queue differs from normal) and `queues`
// (everyone's queue that day; null on a Sunday, which is closed).
// `live` = { weekends: Map date -> { phase1, vip[] } | null, blocks: [...] | null } from the sheet (null: use the stored copy); `emails` = allowed emails.
export function dayPlan(cal, key, live, emails) {
  live = live || {};
  const dow = weekdayOf(key);
  const out = { date: key, weekday: WEEKDAYS[dow], kind: dow === 0 ? "sunday" : dow === 6 ? "saturday" : "weekday", rotationPhase1: null, edited: false, decisions: [], queues: {} };
  out.boundary = key + "T15:00:00+05:00";
  if (out.kind === "sunday") { out.queues = null; return out; } // closed: nothing is decided and nothing is intended, the automation holds what it has
  const roster = Array.isArray(cal.people) ? cal.people : [];
  const rosterQ = new Map(roster.map(p => [p.name, personQueue(p)]));
  const blocks = live.blocks || (cal.vipPlan && cal.vipPlan.blocks) || [];
  // On a Saturday the block that matters is the one Friday was in (blocks run Monday to Friday).
  const block = blockOn(blocks, out.kind === "saturday" ? addDaysKey(key, -1) : key);
  const rotation = block && block.phase1 ? matchName(block.phase1, roster) : null;
  out.rotationPhase1 = rotation || null;
  // what each person's queue would be with nobody having decided anything
  const normal = name => (out.kind === "weekday" && rotation && name === rotation ? "phase1" : rosterQ.get(name));
  const stored = (cal.days && cal.days[key]) || null;
  const decided = new Map(); // name -> { queue, reason }
  const set = (name, queue, reason) => { if (name) decided.set(name, { queue, reason }); };

  if (out.kind === "saturday") {
    const wc = live.weekends ? live.weekends.get(key) : stored && stored.weekendCover;
    if (wc) {
      set(matchName(wc.phase1, roster), "phase1", "weekend cover");
      (wc.vip || []).forEach(n => set(matchName(n, roster), "vip", "weekend cover"));
    }
  } else {
    if (stored && Array.isArray(stored.people)) {
      out.edited = true;
      stored.people.forEach(p => set(p.name, personQueue(p), "day edited by a lead"));
    }
    const cov = (cal.lateCover && cal.lateCover[key]) || null;
    if (cov) {
      set(cov.vip, "vip", "VIP late shift cover");
      set(cov.phase1, "phase1", "Phase 1 late shift cover");
      set(cov.p1q, "phase1", "Phase 1 queue cover");
    }
  }
  roster.forEach(p => {
    const d = decided.get(p.name);
    if (!d) return;
    // weekdays: only a difference from normal is a decision; on a Saturday everyone the sheet names is one
    if (out.kind === "weekday" && d.queue === normal(p.name)) return;
    out.decisions.push({ name: p.name, email: emailFor(p, emails), queue: d.queue, reason: d.reason, lead: isLead(p) });
  });
  out.decisions.sort((a, b) => a.name.localeCompare(b.name));
  // The whole intended state for the day: every roster person's queue (phase1, vip, both or lead). On a weekday the rotation person is on
  // Phase 1; on a Saturday they stay on Phase 1 unless the Weekend Cover names them as VIP; decisions win over both.
  const base = name => (out.kind === "saturday" ? (rotation && name === rotation ? "phase1" : rosterQ.get(name)) : normal(name));
  roster.forEach(p => { const d = decided.get(p.name); out.queues[p.name] = d ? d.queue : base(p.name); });
  return out;
}

// The response for GET /api/v1/intercom-plan. `doc` is the stored team plan document ({ updatedAt, calendar }); `ctx` = { live, emails, fetchedAt }.
export function intercomPlan(doc, fromKey, days, nowMs, ctx) {
  const cal = (doc && doc.calendar) || {};
  const roster = Array.isArray(cal.people) ? cal.people : [];
  const emails = (ctx && ctx.emails) || [];
  let live = (ctx && ctx.live) || {};
  const liveFor = {
    weekends: live.weekends ? new Map(live.weekends.map(w => [w.date, w])) : null,
    blocks: live.blocks && live.blocks.length ? live.blocks : null
  };
  const list = [];
  for (let i = 0; i < days; i++) list.push(dayPlan(cal, addDaysKey(fromKey, i), liveFor, emails));
  return {
    version: 1,
    generatedAt: new Date(nowMs).toISOString(),
    planUpdatedAt: (doc && doc.updatedAt) || null,
    sheetReadAt: (cal.vipPlan && cal.vipPlan.readAt) || null,
    // where the sheet data in this answer came from: read from the Google Sheet just now, or the copy stored in the plan
    sources: { weekendCover: liveFor.weekends ? "sheet" : "stored", rotation: liveFor.blocks ? "sheet" : "stored" },
    timezone: "UTC+05:00",
    boundary: "15:00",
    currentShiftDay: shiftDayAt(nowMs),
    roster: roster.map(p => ({ name: p.name, email: emailFor(p, emails), normalQueue: personQueue(p), lead: isLead(p) })),
    days: list
  };
}

export function validDate(value) {
  return KEY.test(String(value || "")) && keyOf(utcDate(value)) === value;
}
