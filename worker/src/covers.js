// Who is off and who is covering whom on a shift day, worked out on the server so the read API does not depend on an open browser.
//
// This is the calendar page's own logic (resolveDay and the functions it calls, coveringFor, the lead alerts), ported function by function
// with the same names and the same order so the two can be compared line by line. A port can drift, so it is checked against the page
// itself: over many dates and on plans with leave, holidays, covers, hand edits and Support Line rotations, the covers, the people who are
// off and the open needs are identical (see worker/test.mjs and AGENTS.md). Keep it in step with the page.
//
// `cal` is the stored team plan's calendar. `live` carries the Google Sheet tabs read just now (see sheets.js); a tab that could not be read is
// null and the stored copy in `cal` is used for it.

import { matchName, parseSheetTab } from "./sheets.js";

const START_MIN = 15 * 60;
const SLOT_MIN = 30;
const SLOTS = (32 * 60 - START_MIN) / SLOT_MIN;
const VIP_LATE_START = 13;
const VIP_LATE_LEN = 18;
// the break on the late shift is always 2am PKT on the standard clock (1am in summer): seven half-hours after it starts
const LATE_BRK_REL = 7;
const BRK_LEN = 2;
const LINE_START = 4;
const LINE_END = 24;
// The three Support Line slots on the summer schedule: 5-9pm, 9pm-12am, 12-3am PKT (6-10, 10-1, 1-4 in standard time).
const LINE_SLOTS = [{ start: 4, len: 8 }, { start: 12, len: 6 }, { start: 18, len: 6 }];
// The three anchor shifts (Osaid, Raza, Jawad) as summer-schedule slots: 5PM-2AM, 6PM-3AM, 8PM-5AM on the sheet's standard-time clock.
const ANCHORS = [{ start: 2, len: 18 }, { start: 4, len: 18 }, { start: 8, len: 18 }];
const KEY = /^\d{4}-\d{2}-\d{2}$/;

const clone = v => JSON.parse(JSON.stringify(v));
const addDaysK = (key, n) => { const [y, m, d] = key.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pad = n => String(n).padStart(2, "0");
function slotLabel(s) {
  const m = (START_MIN + s * SLOT_MIN) % (24 * 60);
  const hr = Math.floor(m / 60), mn = m % 60;
  let disp = hr % 12;
  if (disp === 0) disp = 12;
  const ap = hr < 12 ? "am" : "pm";
  return mn === 0 ? disp + ap : disp + ":30" + ap;
}
// The instant of a slot on the night that starts on `key`, in PKT (+05:00), as a UTC ISO string.
function slotInstant(key, slot) {
  const total = START_MIN + slot * SLOT_MIN;
  const extra = Math.floor(total / (24 * 60));
  const mins = ((total % (24 * 60)) + (24 * 60)) % (24 * 60);
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - 5 * 3600000 + extra * 86400000 + mins * 60000).toISOString();
}
const weekdayOf = key => { const [y, m, d] = key.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const isSunday = key => weekdayOf(key) === 0;
const isSaturday = key => weekdayOf(key) === 6;
// US Eastern: daylight time runs from the 2nd Sunday of March to the 1st Sunday of November; the stored clocks are the summer schedule.
function nthSunday(y, m, n) {
  const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
  return (7 - first) % 7 + 1 + 7 * (n - 1);
}
function dstSlots(key) {
  const y = Number(key.slice(0, 4));
  const start = y + "-03-" + pad(nthSunday(y, 2, 2));
  const end = y + "-11-" + pad(nthSunday(y, 10, 1));
  return key < start || key >= end ? 2 : 0;
}
// The shift day it is right now in PKT: before 08:00 it is still yesterday's night.
function nightAnchorKey(nowMs) {
  const d = new Date(nowMs + 5 * 3600000);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (d.getUTCHours() * 60 + d.getUTCMinutes() < 8 * 60) t -= 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

function normalizeRoles(p) {
  const r = p && p.roles;
  if (r && typeof r === "object") return { lead: !!r.lead, phase1: !!r.phase1, vip: !!r.vip, line: !!r.line };
  const group = (p && p.group) || "", queue = (p && p.queue) || "";
  return { lead: group === "Leads", phase1: queue === "phase1" || queue === "both", vip: queue === "vip" || queue === "both", line: !!(p && p.line) };
}
const rolesOf = p => p.roles || normalizeRoles(p);
const queueFromRoles = r => (r.phase1 && r.vip ? "both" : r.phase1 ? "phase1" : r.vip ? "vip" : "lead");

// ---------------------------------------------------------------------------------------------------------------- the engine
export function makeEngine(cal, live, nowMs) {
  live = live || {};
  const stored = key => cal[key];
  // roster: the plan's, with the sheet's ORIGINAL shifts written in (the page does this on every read)
  const roster = clone(Array.isArray(cal.people) ? cal.people : []);
  const sheetOff = dstSlots(nightAnchorKey(nowMs));
  const sheetTab = live.rows ? parseSheetTab(live.rows, roster, sheetOff) : null;

  function applyHoursToPerson(p, start, len, brk) {
    const rel = p.brk - p.start;
    const off = start - p.start;
    p.start = start;
    p.len = len;
    const next = Number.isFinite(brk) ? brk : start + rel;
    p.brk = clamp(next, start, Math.max(start, start + len - BRK_LEN));
    if (p.split) p.split.at = clamp((p.split.at || start) + off, p.start + 1, p.start + p.len - 1);
  }
  if (sheetTab) {
    Object.keys(sheetTab.originals).forEach(name => {
      const p = roster.find(x => x.name === name);
      const o = sheetTab.originals[name];
      if (!p || p.split) return;
      const inside = p.brk >= o.start && p.brk <= o.start + o.len - BRK_LEN;
      const brk = o.brk != null ? o.brk : (inside ? p.brk : o.start + Math.max(0, Math.floor(o.len / 2) - 1));
      if (p.start === o.start && p.len === o.len && (o.brk == null || p.brk === brk)) return;
      applyHoursToPerson(p, o.start, o.len, brk);
    });
  }

  // sheet data: the live read, or the stored copy (the page keeps the last Support Line rotation when the dates cannot be read)
  const storedSheet = stored("sheetPlan") || {};
  const sheetPlan = {
    hours: sheetTab ? sheetTab.hours : (storedSheet.hours || {}),
    line: sheetTab && sheetTab.line.length ? sheetTab.line : (storedSheet.line || [])
  };
  const blocks = (live.blocks
    ? live.blocks.map(b => ({
      start: b.start, end: b.end,
      late: matchName(b.late, roster), phase1: matchName(b.phase1, roster),
      cover1: matchName(b.cover1, roster), cover2: matchName(b.cover2, roster)
    })).filter(b => KEY.test(b.start) && KEY.test(b.end) && b.end >= b.start && (b.late || b.phase1)).sort((a, b) => a.start.localeCompare(b.start))
    : ((stored("vipPlan") || {}).blocks || []));
  const days = cal.days || {};
  const leaves = Array.isArray(cal.leaves) ? cal.leaves : [];
  const holidays = Array.isArray(cal.holidays) ? cal.holidays : [];

  const shiftPersonClock = (p, delta) => {
    if (!p || !Number.isFinite(p.start)) return;
    const len = Number.isFinite(p.len) ? p.len : 0;
    const start = clamp(p.start + delta, 0, Math.max(0, SLOTS - len));
    const applied = start - p.start;
    p.start = start;
    if (Number.isFinite(p.brk)) p.brk += applied;
    if (p.split && Number.isFinite(p.split.at)) p.split.at += applied;
  };
  const shiftBarClock = (b, delta) => {
    if (!b || !Number.isFinite(b.start)) return;
    const len = Number.isFinite(b.len) ? b.len : 0;
    b.start = clamp(b.start + delta, 0, Math.max(0, SLOTS - len));
  };

  const vipBlockFor = key => blocks.find(b => b.start <= key && key <= b.end) || null;
  const lineRotationFor = key => sheetPlan.line.find(b => b.start <= key && key <= b.end) || null;
  const lateStartFor = key => VIP_LATE_START + dstSlots(key);
  const lateCoverFor = key => (cal.lateCover && cal.lateCover[key]) || null;
  // ---- changes made by a command (the page's applyChanges): applied last, only on the nights named
  const changesFor = key => (cal.changes && Array.isArray(cal.changes[key]) ? cal.changes[key] : []);
  const queueFlags = q => (q === "phase1" ? { phase1: true, vip: false } : q === "vip" ? { vip: true, phase1: false } : { vip: true, phase1: true });
  function changeHours(key, shift) {
    const off = dstSlots(key);
    if (shift.kind === "late") return { start: lateStartFor(key), len: VIP_LATE_LEN };
    if (shift.kind === "anchor") { const a = ANCHORS[shift.n]; return a ? { start: a.start + off, len: a.len } : null; }
    return Number.isFinite(shift.start) && Number.isFinite(shift.len) ? { start: shift.start, len: shift.len } : null;
  }
  function takeHours(p, h) {
    const late = h.len === VIP_LATE_LEN && (h.start === VIP_LATE_START || h.start === VIP_LATE_START + 2);
    const rel = late ? LATE_BRK_REL : Number.isFinite(p.brk) && Number.isFinite(p.start) ? p.brk - p.start : Math.floor(h.len / 2) - 1;
    p.split = null;
    applyHoursToPerson(p, h.start, h.len, clamp(h.start + rel, h.start, h.start + h.len - BRK_LEN));
  }
  // Someone covering takes the covered person's whole shift: hours, break and split, as they stood before any change that night.
  function takeWhole(p, o, h) {
    if (!h || (h.start === o.start && h.len === o.len)) { applyHoursToPerson(p, o.start, o.len, o.brk); p.split = o.split ? clone(o.split) : null; return; }
    takeHours(p, h);
  }
  function applyChanges(people, key, baked) {
    const orig = {};
    people.forEach(x => { orig[x.name] = { start: x.start, len: x.len, brk: x.brk, split: x.split ? clone(x.split) : null }; });
    changesFor(key).forEach(c => {
      if (baked && baked.has(c.id)) return;
      const find = n => people.find(x => x.name === n);
      if (c.type === "queue") {
        const p = find(c.name);
        if (p) p.roles = Object.assign({}, rolesOf(p), queueFlags(c.queue));
      } else if (c.type === "shift") {
        const p = find(c.name), h = c.shift && changeHours(key, c.shift);
        if (p && h) takeHours(p, h);
      } else if (c.type === "takeover") {
        const p = find(c.name), from = find(c.from);
        if (!p || !from || p === from) return;
        const r = rolesOf(from);
        const o = orig[c.from] || { start: from.start, len: from.len, brk: from.brk, split: from.split };
        const h = c.shift && changeHours(key, c.shift);
        const holder = h && !(h.start === o.start && h.len === o.len) && Object.keys(orig).map(n => orig[n]).find(x => x.start === h.start && x.len === h.len);
        if (holder) takeWhole(p, holder, null || h); else takeWhole(p, o, h);
        // the anchor shifts are VIP seats; any other shift keeps the queue of the person being covered
        p.roles = Object.assign({}, rolesOf(p), c.shift && c.shift.kind === "anchor" ? { phase1: false, vip: true } : { phase1: r.phase1, vip: r.vip });
      } else if (c.type === "swap") {
        const a = find(c.a), b = find(c.b);
        if (!a || !b || a === b) return;
        const take = p => ({ start: p.start, len: p.len, brk: p.brk, split: p.split ? clone(p.split) : null, phase1: rolesOf(p).phase1, vip: rolesOf(p).vip });
        const sa = take(a), sb = take(b);
        [[a, sb], [b, sa]].forEach(([p, t]) => {
          p.start = t.start; p.len = t.len; p.brk = t.brk; p.split = t.split;
          p.roles = Object.assign({}, rolesOf(p), { phase1: t.phase1, vip: t.vip });
        });
      }
    });
  }

  // ---- leave and holidays
  const approvedLeaves = () => leaves.filter(l => l.status === "approved");
  const onLeave = (name, key) => approvedLeaves().some(l => l.name === name && l.start <= key && key <= l.end);
  function holidayMark(name, key) {
    for (let i = 0; i < holidays.length; i++) {
      if (holidays[i].status !== "confirmed") continue;
      const row = holidays[i].offs && holidays[i].offs[key];
      if (row && (row[name] === "off" || row[name] === "pto")) return row[name];
    }
    return "";
  }
  const isHolidayAway = (name, key) => !!holidayMark(name, key);
  function awayMark(name, key) {
    const mark = holidayMark(name, key);
    if (mark === "off") return "off";
    if (mark === "pto" || onLeave(name, key)) return "pto";
    return "";
  }

  // ---- the day is built in the page's order
  function applySheetPlan(people, lineBars, key) {
    Object.keys(sheetPlan.hours || {}).forEach(name => {
      const h = sheetPlan.hours[name];
      const p = people.find(x => x.name === name);
      if (!p) return;
      applyHoursToPerson(p, h.start, h.len, Number.isFinite(h.brk) ? h.brk : null);
    });
    const rot = lineRotationFor(key);
    if (!rot) return;
    const bars = [];
    rot.slots.forEach((owner, i) => {
      const p = owner && people.find(x => x.name === owner);
      if (!p || !LINE_SLOTS[i]) return;
      bars.push({ owner, start: LINE_SLOTS[i].start, len: LINE_SLOTS[i].len });
      p.roles = Object.assign({}, rolesOf(p), { line: true });
    });
    lineBars.splice(0, lineBars.length, ...bars);
  }
  function applyVipBlock(people, key) {
    const blk = vipBlockFor(key);
    if (!blk) return;
    const off = dstSlots(key);
    people.forEach(p => {
      if (blk.late && p.name === blk.late) {
        const start = VIP_LATE_START + off;
        p.split = null;
        applyHoursToPerson(p, start, VIP_LATE_LEN, start + LATE_BRK_REL);
      }
      if (blk.phase1 && p.name === blk.phase1) {
        p.roles = Object.assign({}, rolesOf(p), { phase1: true, vip: false });
        p.split = null;
      }
    });
  }
  // ---- Late shift and Phase 1 coverage on saved nights (the page's followsRotation / rotationBase / rotationNames / followRotation)
  // A saved night keeps its other shifts as saved, but from next week on the sheet's Late Shift and Phase 1 coverage always apply to it,
  // except for a person edited directly on that night (day.touched). This week is left as saved.
  const firstFollowKey = (() => { const a = nightAnchorKey(nowMs); const wd = weekdayOf(a); return addDaysK(a, 7 - (wd === 0 ? 6 : wd - 1)); })();
  function followsRotation(key) {
    const d = days[key];
    return !!d && !d.weekendCover && !isSaturday(key) && !isSunday(key) && key >= firstFollowKey;
  }
  function rotationBase(key) {
    const people = clone(roster);
    applySheetPlan(people, [], key);
    const off = dstSlots(key);
    if (off) people.forEach(p => shiftPersonClock(p, off));
    applyVipBlock(people, key);
    applyAnchorCover(people, key);
    return people;
  }
  function rotationNames(key, day) {
    const set = new Set();
    const blk = vipBlockFor(key);
    if (blk) [blk.late, blk.phase1, blk.cover1, blk.cover2].forEach(n => { if (n) set.add(n); });
    if (Array.isArray(day.rot)) day.rot.forEach(n => set.add(n));
    else if (Array.isArray(day.people)) {
      const off = dstSlots(key), lateAt = lateStartFor(key);
      day.people.forEach(p => {
        const r = roster.find(x => x.name === p.name);
        if (!r) return;
        const lateHours = p.len === VIP_LATE_LEN && p.start === lateAt;
        const phase1 = queueFromRoles(rolesOf(p)) === "phase1" && queueFromRoles(rolesOf(r)) !== "phase1";
        const anchor = ANCHORS.some(a => p.start === a.start + off && p.len === a.len) && !(p.start === r.start + off && p.len === r.len);
        if (lateHours || phase1 || anchor) set.add(p.name);
      });
    }
    return set;
  }
  function touchedNames(key, day) {
    const set = new Set(day.touched || []);
    const baked = new Set(day.baked || []);
    changesFor(key).forEach(c => { if (baked.has(c.id)) [c.name, c.from, c.a, c.b].forEach(n => { if (n) set.add(n); }); });
    return set;
  }
  function followRotation(people, key, day) {
    if (!followsRotation(key)) return;
    const touched = touchedNames(key, day);
    const fresh = rotationBase(key);
    rotationNames(key, day).forEach(name => {
      if (touched.has(name)) return;
      const p = people.find(x => x.name === name), f = fresh.find(x => x.name === name);
      if (!p || !f) return;
      p.start = f.start; p.len = f.len; p.brk = f.brk; p.split = f.split ? clone(f.split) : null;
      const rf = rolesOf(f);
      p.roles = Object.assign({}, rolesOf(p), { phase1: rf.phase1, vip: rf.vip });
    });
  }
  // the saved night's people with the sheet's rotation applied (no covers, no commands), or null when the night is not saved
  function storedPeopleFor(key) {
    const src = days[key];
    if (!src || !Array.isArray(src.people)) return null;
    const people = clone(src.people);
    followRotation(people, key, src);
    return people;
  }
  // When the block's Late Shift or Phase 1 person normally works an anchor shift, that anchor is vacated for the block. The same happens for
  // one night when a lead puts someone who works an anchor shift on late-shift cover (kind "cover"): the anchor they leave needs a holder.
  function anchorGaps(key) {
    if (isSunday(key) || isSaturday(key) || (days[key] && !followsRotation(key))) return [];
    // on a saved night only the sheet's rotation is followed; covers and commands are already part of what was saved
    const saved = !!days[key];
    const blk = vipBlockFor(key);
    const cov = saved ? null : lateCoverFor(key);
    if (!blk && !cov) return [];
    const base = clone(roster);
    applySheetPlan(base, [], key);
    const off = dstSlots(key);
    const gaps = [];
    const add = (kind, name, block, note) => {
      const p = name && base.find(x => x.name === name);
      if (!p || gaps.some(g => g.person === name)) return;
      const a = ANCHORS.find(x => x.start === p.start && x.len === p.len);
      if (a) gaps.push({ kind, person: name, start: a.start + off, len: a.len, brk: p.brk - p.start, block, note });
    };
    if (blk) [["late", blk.late], ["phase1", blk.phase1]].forEach(([kind, name]) => add(kind, name, blk.start));
    if (cov) [cov.vip, cov.phase1].forEach(name => add("cover", name, key, name + " is covering the late shift."));
    // someone a command moves off their own anchor shift leaves it open as well (a swap leaves nothing open)
    if (!saved) changesFor(key).forEach(c => {
      if (c.type === "shift") {
        const h = c.shift && changeHours(key, c.shift);
        const p = base.find(x => x.name === c.name);
        const a = p && ANCHORS.find(x => x.start === p.start && x.len === p.len);
        if (a && h && !(h.start === a.start + off && h.len === a.len)) add("cover", c.name, key, c.name + " is moved to " + slotLabel(h.start) + "–" + slotLabel(h.start + h.len) + ".");
      } else if (c.type === "takeover") {
        const h = c.shift && changeHours(key, c.shift);
        const p = base.find(x => x.name === c.name);
        const a = p && ANCHORS.find(x => x.start === p.start && x.len === p.len);
        if (!(a && h && h.start === a.start + off && h.len === a.len)) add("cover", c.name, key, c.name + " is covering " + c.from + ".");
      }
    });
    return gaps;
  }
  function anchorCoverFor(key) {
    const b = vipBlockFor(key);
    return { late: (b && b.cover1) || "", phase1: (b && b.cover2) || "" };
  }
  // Who holds a vacated anchor shift: the sheet's Anchor Cover for the block people, or the cover a lead picked for a late-shift cover person.
  function gapCover(key, g) {
    const picked = g.kind === "cover" ? ((lateCoverFor(key) || {}).anchor || {})[g.person] || "" : anchorCoverFor(key)[g.kind];
    if (picked) return picked;
    // somebody a command put on exactly that shift in place of the person who left it
    const t = changesFor(key).find(c => {
      if (c.type !== "takeover" || c.from !== g.person || !c.shift) return false;
      const h = changeHours(key, c.shift);
      return !!h && h.start === g.start && h.len === g.len;
    });
    return t ? t.name : "";
  }
  function applyAnchorCover(people, key) {
    anchorGaps(key).forEach(g => {
      const name = gapCover(key, g);
      const p = name && people.find(x => x.name === name);
      if (!p) return;
      p.split = null;
      applyHoursToPerson(p, g.start, g.len, clamp(g.start + g.brk, g.start, g.start + g.len - 2));
      p.roles = Object.assign({}, rolesOf(p), { vip: true, phase1: false });
    });
  }
  function applyLateCover(people, key) {
    const cov = lateCoverFor(key);
    if (!cov) return;
    const q = cov.p1q && people.find(x => x.name === cov.p1q);
    if (q) q.roles = Object.assign({}, rolesOf(q), { phase1: true, vip: false });
    const start = lateStartFor(key);
    [["vip", cov.vip], ["phase1", cov.phase1]].forEach(([kind, name]) => {
      const p = name && people.find(x => x.name === name);
      if (!p) return;
      p.split = null;
      applyHoursToPerson(p, start, VIP_LATE_LEN, start + LATE_BRK_REL);
      p.roles = Object.assign({}, rolesOf(p), kind === "vip" ? { vip: true, phase1: false } : { phase1: true, vip: false });
    });
  }
  // When the owner of a Support Line slot is off, the sheet's backup takes that slot.
  function applyLineBackup(people, lineBars, away, key) {
    const rot = lineRotationFor(key);
    if (!rot || !rot.backup) return;
    const bp = people.find(x => x.name === rot.backup);
    if (!bp || away.has(bp.name)) return;
    const missing = lineBars.filter(b => away.has(b.owner) && rot.slots.includes(b.owner)).sort((a, b) => a.start - b.start);
    let winLo = null, winHi = null;
    const taken = [];
    missing.forEach(b => {
      const lo = winLo == null ? b.start : Math.min(winLo, b.start);
      const hi = winHi == null ? b.start + b.len : Math.max(winHi, b.start + b.len);
      if (hi - lo > bp.len) { b.backupFail = true; return; }
      winLo = lo;
      winHi = hi;
      taken.push(b);
    });
    if (!taken.length) return;
    const from = [bp.start, bp.len];
    let start = bp.start;
    if (winLo < start) start = winLo;
    else if (winHi > start + bp.len) start = winHi - bp.len;
    start = clamp(start, 0, Math.max(0, SLOTS - bp.len));
    let to = null;
    if (start !== bp.start) {
      applyHoursToPerson(bp, start, bp.len, start + (bp.brk - bp.start));
      to = [bp.start, bp.len];
    }
    let used = false;
    taken.forEach(b => {
      const lo = Math.max(b.start, bp.start);
      const hi = Math.min(b.start + b.len, bp.start + bp.len);
      if (hi <= lo) return;
      const owner = b.owner;
      b.owner = bp.name;
      b.start = lo;
      b.len = hi - lo;
      b.backupInfo = { owner, from, to };
      used = true;
    });
    if (used) bp.roles = Object.assign({}, rolesOf(bp), { line: true });
  }
  function markBackupBars(lineBars, away, key) {
    const rot = lineRotationFor(key);
    if (!rot || !rot.backup) return;
    const off = dstSlots(key);
    rot.slots.forEach((owner, i) => {
      if (!owner || !away.has(owner) || !LINE_SLOTS[i]) return;
      const lo = LINE_SLOTS[i].start + off, hi = lo + LINE_SLOTS[i].len;
      lineBars.forEach(b => {
        if (b.owner === rot.backup && b.start < hi && b.start + b.len > lo) { b.backupMark = true; b.backupFor = owner; }
      });
    });
  }
  // A weekday, as the page builds it (Saturdays have no covers; Sundays are closed).
  function resolveDay(key) {
    const src = days[key];
    const people = clone(src ? src.people : roster);
    const lineBars = clone(src ? src.lineBars : (cal.lineBars || []));
    if (!src) {
      applySheetPlan(people, lineBars, key);
      const off = dstSlots(key);
      if (off) {
        people.forEach(p => shiftPersonClock(p, off));
        lineBars.forEach(b => shiftBarClock(b, off));
      }
      applyVipBlock(people, key);
      applyAnchorCover(people, key);
    } else followRotation(people, key, src);
    applyLateCover(people, key);
    applyChanges(people, key, new Set((src && src.baked) || []));
    const away = new Set(people.filter(p => isHolidayAway(p.name, key) || onLeave(p.name, key)).map(p => p.name));
    if (!src) applyLineBackup(people, lineBars, away, key);
    else markBackupBars(lineBars, away, key);
    return { people, lineBars, away };
  }

  function lateStatus(people, away, key) {
    const start = lateStartFor(key);
    const vip = [], phase1 = [], absent = [];
    (people || []).forEach(p => {
      if (!Number.isFinite(p.start) || p.start < start) return;
      if (away && away.has(p.name)) { absent.push(p.name); return; }
      const r = rolesOf(p);
      if (r.vip) vip.push(p.name);
      if (r.phase1) phase1.push(p.name);
    });
    const missing = [];
    if (!vip.length) missing.push("vip");
    if (!phase1.length) missing.push("phase1");
    return { start, vip, phase1, absent, missing };
  }
  // True when working people's Support Line bars already span the whole slot.
  function slotCovered(lineBars, away, start, len) {
    for (let t = start; t < start + len; t++) {
      if (!lineBars.some(b => !away.has(b.owner) && b.start <= t && t < b.start + b.len)) return false;
    }
    return true;
  }
  const span = (s, l) => slotLabel(s) + "–" + slotLabel(s + l);

  // Who is covering whom, and for what (the page's coveringFor). Each entry also carries its slots (`lo`, `hi`) for the times.
  function coveringFor(key, day) {
    const out = [];
    if (isSunday(key) || isSaturday(key)) return { covers: out, rotation: [] };
    const range = span(lateStartFor(key), VIP_LATE_LEN);
    const c = lateCoverFor(key) || {};
    const blk = vipBlockFor(key) || {};
    const st = lateStatus(day.people, day.away, key);
    const absentFor = kind => {
      const same = st.absent.filter(n => { const p = day.people.find(x => x.name === n); return p && rolesOf(p)[kind]; });
      return (same.length ? same : st.absent).join(", ");
    };
    const lateLo = lateStartFor(key), lateHi = lateLo + VIP_LATE_LEN;
    if (c.vip) out.push({ name: c.vip, kind: "late", for: absentFor("vip"), what: "the VIP late shift " + range, lo: lateLo, hi: lateHi });
    if (c.phase1) out.push({ name: c.phase1, kind: "late", for: absentFor("phase1"), what: "the Phase 1 late shift " + range, lo: lateLo, hi: lateHi });
    if (c.p1q) {
      const who = day.people.find(x => x.name === c.p1q);
      out.push({ name: c.p1q, kind: "queue", for: blk.phase1 || "", what: "Phase 1", lo: who ? who.start : null, hi: who ? who.start + who.len : null });
    }
    anchorGaps(key).forEach(g => {
      const name = gapCover(key, g);
      // a takeover a command made is worded as the takeover, so it is not said twice
      if (name && day.people.some(x => x.name === name) && !changesFor(key).some(c => c.type === "takeover" && c.name === name && c.from === g.person)) {
        out.push({ name, kind: "anchor", for: g.person, what: "the " + span(g.start, g.len) + " VIP shift", lo: g.start, hi: g.start + g.len });
      }
    });
    const rot = lineRotationFor(key);
    if (rot) {
      const off = dstSlots(key);
      rot.slots.forEach((owner, i) => {
        if (!owner || !day.away.has(owner) || !LINE_SLOTS[i]) return;
        const lo = LINE_SLOTS[i].start + off, hi = lo + LINE_SLOTS[i].len;
        const what = "Support Line " + slotLabel(lo) + "–" + slotLabel(hi);
        const auto = day.lineBars.find(b => b.backupInfo && b.backupInfo.owner === owner);
        if (auto) {
          const info = auto.backupInfo;
          const extra = info.to ? `${auto.owner}'s shift was adjusted to ${slotLabel(info.to[0])}–${slotLabel(info.to[0] + info.to[1])} to cover the Support Line.` : `${auto.owner}'s shift already covered it.`;
          out.push({ name: auto.owner, kind: "line", for: owner, what, extra, lo, hi });
          return;
        }
        if (slotCovered(day.lineBars, day.away, lo, hi - lo)) {
          [...new Set(day.lineBars.filter(b => !day.away.has(b.owner) && b.start < hi && b.start + b.len > lo).map(b => b.owner))]
            .forEach(name => out.push({ name, kind: "line", for: owner, what, lo, hi }));
        }
      });
    }
    // changes made by a command: who takes over whom, and everybody it moved (queue, hours, a swap)
    const chg = changesFor(key);
    if (chg.length) {
      const qLabel = q => (q === "phase1" ? "Phase 1" : q === "vip" ? "VIP" : "Phase 1 and VIP");
      const shiftOff = dstSlots(key);
      const touched = [];
      chg.forEach(c => {
        if (c.type === "takeover") {
          const p = day.people.find(x => x.name === c.name);
          if (p && !day.away.has(p.name)) out.push({ name: c.name, kind: "takeover", for: c.from, what: "their " + span(p.start, p.len) + " " + qLabel(queueFromRoles(rolesOf(p))) + " shift", lo: p.start, hi: p.start + p.len });
        } else if (c.type === "swap") {
          touched.push([c.a, "swapped with " + c.b], [c.b, "swapped with " + c.a]);
        } else touched.push([c.name, ""]);
      });
      const seen = new Set();
      touched.forEach(([name, prefix]) => {
        if (seen.has(name) && !prefix) return;
        const p = day.people.find(x => x.name === name);
        const usual = roster.find(x => x.name === name);
        if (!p || !usual || day.away.has(name) || out.some(e => e.name === name)) return;
        seen.add(name);
        const usualQ = blk.phase1 === name ? "phase1" : queueFromRoles(rolesOf(usual));
        const nowQ = queueFromRoles(rolesOf(p));
        const bits = [];
        if (nowQ !== usualQ) bits.push("on " + qLabel(nowQ) + " instead of " + qLabel(usualQ));
        if (p.start !== usual.start + shiftOff || p.len !== usual.len) bits.push("working " + span(p.start, p.len) + " instead of their usual " + span(usual.start + shiftOff, usual.len));
        if (bits.length || prefix) out.push({ name, kind: "change", for: "", what: "", text: "is " + (bits.length ? bits.join(" and ") : "on the same shift") + (prefix ? " (" + prefix + ")" : ""), lo: p.start, hi: p.start + p.len });
      });
    }
    // the two-week rotation: tagged "(Late Shift)" / "(Phase 1 Coverage)" on screen, not part of the covers list
    const rotation = [];
    if ((!days[key] || followsRotation(key)) && blk.start) {
      const tch = days[key] ? touchedNames(key, days[key]) : new Set();
      day.people.forEach(p => {
        if (day.away.has(p.name) || tch.has(p.name)) return;
        if (blk.late === p.name) rotation.push({ name: p.name, label: "Late Shift", lo: p.start, hi: p.start + p.len });
        else if (blk.phase1 === p.name) rotation.push({ name: p.name, label: "Phase 1 Coverage", lo: p.start, hi: p.start + p.len });
      });
    }
    // anyone else working hours other than their original (roster) shift is covering too
    const shift = dstSlots(key);
    day.people.forEach(p => {
      if (day.away.has(p.name) || out.some(e => e.name === p.name) || rotation.some(e => e.name === p.name)) return;
      const usual = roster.find(x => x.name === p.name);
      if (!usual || (p.start === usual.start + shift && p.len === usual.len)) return;
      out.push({ name: p.name, kind: "hours", for: "", what: "", text: "is working " + span(p.start, p.len) + " instead of their usual " + span(usual.start + shift, usual.len), lo: p.start, hi: p.start + p.len });
    });
    return { covers: out, rotation };
  }

  // Stretches of the Support Line window where nobody is on the line (the page's lineZeroRuns, from assignmentAt).
  function lineZeroRuns(day, key) {
    const off = dstSlots(key), lo = LINE_START + off, hi = LINE_END + off;
    const line = new Array(SLOTS).fill(0);
    day.people.forEach(p => {
      if (day.away.has(p.name)) return;
      for (let s = p.start; s < p.start + p.len; s++) {
        if (s >= p.brk && s < p.brk + BRK_LEN) continue;
        if (day.lineBars.some(b => b.owner === p.name && s >= b.start && s < b.start + b.len)) line[s]++;
      }
    });
    const runs = [];
    let from = -1;
    for (let x = lo; x <= hi; x++) {
      const zero = x < hi && !line[x];
      if (zero && from < 0) from = x;
      if (!zero && from >= 0) { runs.push({ start: from, end: x }); from = -1; }
    }
    return runs;
  }
  // What still needs a lead (the page's red alerts): a late shift without a VIP or Phase 1 person, an uncovered anchor,
  // a Phase 1 person who is off with no queue cover, a Support Line slot whose owner is off with nobody covering.
  function needsCover(key, day) {
    const out = [];
    if (isSunday(key) || isSaturday(key)) return out;
    const st = lateStatus(day.people, day.away, key);
    const range = span(st.start, VIP_LATE_LEN);
    const kindName = { vip: "VIP", phase1: "Phase 1" };
    st.missing.forEach(kind => {
      const who = st.absent.length ? " " + st.absent.join(", ") + (st.absent.length === 1 ? " is" : " are") + " off." : "";
      out.push({ kind: "late", text: "Late shift " + range + " needs a " + kindName[kind] + " person." + who });
    });
    anchorGaps(key).forEach(g => {
      if (gapCover(key, g)) return;
      if (g.kind === "cover") {
        out.push({ kind: "anchor", text: "Anchor shift " + span(g.start, g.len) + " VIP is uncovered. " + (g.note || g.person + " is covering the late shift.") });
        return;
      }
      const role = g.kind === "late" ? "Late Shift" : "Phase 1";
      out.push({ kind: "anchor", text: "Anchor shift " + span(g.start, g.len) + " VIP is uncovered. " + g.person + " is on " + role + " this block. Add a VIP rep under Anchor " + (g.kind === "late" ? "1" : "2") + " on the VIP Coverage Plan sheet." });
    });
    // Phase 1 queue cover: the sheet's Phase 1 person is off and no VIP rep was put on Phase 1 (not on days edited by hand)
    const blk = vipBlockFor(key);
    if ((!days[key] || followsRotation(key)) && blk && blk.phase1 && day.away.has(blk.phase1) && !(lateCoverFor(key) || {}).p1q && !(days[key] && touchedNames(key, days[key]).has(blk.phase1))) {
      out.push({ kind: "phase1", text: "Phase 1 needs cover. " + blk.phase1 + " is off. Add a VIP rep to Phase 1." });
    }
    const rot = lineRotationFor(key);
    if (rot) {
      const off = dstSlots(key);
      rot.slots.forEach((owner, i) => {
        if (!owner || !day.away.has(owner) || !LINE_SLOTS[i]) return;
        if (day.lineBars.some(b => b.backupInfo && b.backupInfo.owner === owner)) return;
        if (slotCovered(day.lineBars, day.away, LINE_SLOTS[i].start + off, LINE_SLOTS[i].len)) return;
        let why;
        if (!rot.backup) why = "No backup is listed on the sheet.";
        else if (day.away.has(rot.backup)) why = "Backup " + rot.backup + " is off too.";
        else if (day.lineBars.some(b => b.backupFail && b.owner === owner)) why = "Backup " + rot.backup + " is already covering another slot, and one shift cannot reach both.";
        else why = "Backup " + rot.backup + " could not be moved onto that slot.";
        const name = slotLabel(LINE_SLOTS[i].start + off) + "–" + slotLabel(LINE_SLOTS[i].start + LINE_SLOTS[i].len + off);
        out.push({ kind: "line", text: "Support Line " + name + " owner " + owner + " is off. " + why });
      });
    }
    // nobody on the Support Line for a stretch: a lead has to adjust a break or add cover
    lineZeroRuns(day, key).forEach(r => out.push({ kind: "line", text: "Support Line has nobody " + slotLabel(r.start) + "–" + slotLabel(r.end) + ". Adjust breaks or add cover." }));
    return out;
  }

  return { roster, storedPeopleFor, resolveDay, coveringFor, needsCover, vipBlockFor, awayMark, lateCoverFor, changesFor, anchorGaps, gapCover, anchorCoverFor, lateStartFor };
}

// ---------------------------------------------------------------------------------------------------------------- the day for the API
function coverEntry(key, e) {
  const text = e.text ? e.name + " " + e.text + "." : e.name + " is covering " + (e.for ? e.for + " on " : "") + e.what + "." + (e.extra ? " " + e.extra : "");
  const out = { kind: e.kind, name: e.name, for: e.for || null, what: e.what || null, text };
  if (e.extra) out.extra = e.extra;
  if (Number.isFinite(e.lo) && Number.isFinite(e.hi)) {
    out.from = slotLabel(e.lo);
    out.to = slotLabel(e.hi);
    out.fromAt = slotInstant(key, e.lo);
    out.toAt = slotInstant(key, e.hi);
  }
  return out;
}

// -> { away: [{ name, kind: "off" | "pto" }], covers: [...], needsCover: [...], rotation: { phase1, lateShift } } for one shift day.
export function coversForDay(engine, key, weekendNames) {
  if (isSunday(key)) return { away: [], covers: [], needsCover: [], rotation: { phase1: null, lateShift: null } };
  if (isSaturday(key)) {
    // a Saturday is the people the Weekend Cover names; there are no covers on it
    const names = (weekendNames || []).filter(Boolean);
    const away = names.map(n => ({ name: n, kind: engine.awayMark(n, key) })).filter(a => a.kind);
    return { away, covers: [], needsCover: [], rotation: { phase1: null, lateShift: null } };
  }
  const day = engine.resolveDay(key);
  const { covers } = engine.coveringFor(key, day);
  const blk = engine.vipBlockFor(key) || {};
  const away = day.people.filter(p => day.away.has(p.name)).map(p => ({ name: p.name, kind: engine.awayMark(p.name, key) || "pto" }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    away,
    covers: covers.map(e => coverEntry(key, e)),
    needsCover: engine.needsCover(key, day),
    rotation: { phase1: blk.phase1 || null, lateShift: blk.late || null }
  };
}

export { slotLabel, dstSlots, nightAnchorKey, ANCHORS, VIP_LATE_START, VIP_LATE_LEN, START_MIN, SLOT_MIN, SLOTS, isSaturday, isSunday };
