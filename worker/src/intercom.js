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
// rep to Phase 1 for that night, late shift cover sets the queue of the person covering, and a Saturday follows the Weekend Cover sheet
// (no rotation). Sunday is closed.

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

function blockOn(cal, key) {
  const blocks = (cal.vipPlan && cal.vipPlan.blocks) || [];
  return blocks.find(b => b && b.start <= key && key <= b.end) || null;
}

// One shift day: kind, what the calendar thinks the rotation is, and the decisions (people whose queue differs from normal).
export function dayPlan(cal, key) {
  const dow = weekdayOf(key);
  const out = { date: key, weekday: WEEKDAYS[dow], kind: dow === 0 ? "sunday" : dow === 6 ? "saturday" : "weekday", rotationPhase1: null, edited: false, decisions: [] };
  out.boundary = key + "T15:00:00+05:00";
  if (out.kind === "sunday") return out; // closed: nothing is decided, the automation holds what it has
  const roster = Array.isArray(cal.people) ? cal.people : [];
  const rosterQ = new Map(roster.map(p => [p.name, personQueue(p)]));
  const block = out.kind === "weekday" ? blockOn(cal, key) : null;
  out.rotationPhase1 = block && block.phase1 ? String(block.phase1) : null;
  // what each person's queue would be with nobody having decided anything
  const normal = name => (out.rotationPhase1 && name === out.rotationPhase1 ? "phase1" : rosterQ.get(name));
  const stored = (cal.days && cal.days[key]) || null;
  const decided = new Map(); // name -> { queue, reason }
  const set = (name, queue, reason) => { if (name) decided.set(name, { queue, reason }); };

  if (out.kind === "saturday") {
    const wc = stored && stored.weekendCover;
    if (wc) {
      out.edited = false;
      set(wc.phase1, "phase1", "weekend cover");
      (wc.vip || []).forEach(n => set(n, "vip", "weekend cover"));
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
    // on Saturday the rotation does not apply, so "normal" is the roster's own queue
    const base = out.kind === "saturday" ? rosterQ.get(p.name) : normal(p.name);
    if (d.queue === base) return;
    out.decisions.push({ name: p.name, queue: d.queue, reason: d.reason, lead: isLead(p) });
  });
  out.decisions.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// The response for GET /api/v1/intercom-plan. `doc` is the stored team plan document ({ updatedAt, calendar }).
export function intercomPlan(doc, fromKey, days, nowMs) {
  const cal = (doc && doc.calendar) || {};
  const list = [];
  for (let i = 0; i < days; i++) list.push(dayPlan(cal, addDaysKey(fromKey, i)));
  return {
    version: 1,
    generatedAt: new Date(nowMs).toISOString(),
    planUpdatedAt: (doc && doc.updatedAt) || null,
    sheetReadAt: (cal.vipPlan && cal.vipPlan.readAt) || null,
    timezone: "UTC+05:00",
    boundary: "15:00",
    currentShiftDay: shiftDayAt(nowMs),
    roster: (Array.isArray(cal.people) ? cal.people : []).map(p => ({ name: p.name, normalQueue: personQueue(p), lead: isLead(p) })),
    days: list
  };
}

export function validDate(value) {
  return KEY.test(String(value || "")) && keyOf(utcDate(value)) === value;
}
