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
// The hand edits a swap already took into account (it recorded each person's shift as it was then) must not be put back on top of the swap.
export function dropFoldedEdits(ovr, list) {
  const same = (x, y) => JSON.stringify(x, Object.keys(x || {}).sort()) === JSON.stringify(y, Object.keys(y || {}).sort());
  let out = null;
  (list || []).forEach(c => {
    if (c.type !== "swap" || !c.edited) return;
    [[c.a, "a"], [c.b, "b"]].forEach(([n, s]) => { if (c.edited[s] && ovr && ovr[n] && same(ovr[n], c.edited[s])) { out = out || Object.assign({}, ovr); delete out[n]; } });
  });
  return out || ovr;
}

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
  // people's original shifts, from the top of the VIP Coverage Plan tab and of the Phase 1 / Support Line tab, go into the roster (the page does this on every read)
  const vipTab = live.vipRows ? parseSheetTab(live.vipRows, roster, sheetOff) : null;
  [vipTab, sheetTab].forEach(tab => {
    if (!tab) return;
    Object.keys(tab.originals).forEach(name => {
      const p = roster.find(x => x.name === name);
      const o = tab.originals[name];
      if (!p || p.split) return;
      const inside = p.brk >= o.start && p.brk <= o.start + o.len - BRK_LEN;
      const brk = o.brk != null ? o.brk : (inside ? p.brk : o.start + Math.max(0, Math.floor(o.len / 2) - 1));
      if (p.start === o.start && p.len === o.len && (o.brk == null || p.brk === brk)) return;
      applyHoursToPerson(p, o.start, o.len, brk);
    });
  });

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
    if (shift.kind === "usual") return null;
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
  // The Support Line goes with the shift: in a swap the two people exchange their slots, and whoever takes over somebody's whole shift takes their slots.
  function moveLine(c, people, bars) {
    const pair = c.type === "swap" ? [c.a, c.b] : [c.name, c.from];
    const had = pair.map(n => bars.some(b => b.owner === n));
    bars.forEach(b => {
      if (c.type === "swap") { if (b.owner === c.a) b.owner = c.b; else if (b.owner === c.b) b.owner = c.a; }
      else if (b.owner === c.from) b.owner = c.name;
    });
    pair.forEach((n, i) => {
      const p = people.find(x => x.name === n);
      if (!p) return;
      const has = bars.some(b => b.owner === n);
      if (has) p.roles = Object.assign({}, rolesOf(p), { line: true }); else if (had[i]) p.roles = Object.assign({}, rolesOf(p), { line: false });
    });
  }
  const barsSig = bars => JSON.stringify((bars || []).map(b => [b.owner, b.start, b.len]));
  function applyChanges(people, key, only, lineBars, usual) {
    const moved = new Set();
    const orig = {};
    people.forEach(x => { orig[x.name] = { start: x.start, len: x.len, brk: x.brk, split: x.split ? clone(x.split) : null }; });
    changesFor(key).forEach(c => {
      if (only && !only.has(c.id)) return;
      const find = n => people.find(x => x.name === n);
      if (c.type === "queue") {
        const p = find(c.name);
        if (p) p.roles = Object.assign({}, rolesOf(p), queueFlags(c.queue));
      } else if (c.type === "shift") {
        const p = find(c.name), h = c.shift && changeHours(key, c.shift);
        if (p && c.shift && c.shift.kind === "usual") {
          // their own (roster) hours, break and split; the queue stays as it is
          const u = rosterUsual(c.name, key);
          if (u) { applyHoursToPerson(p, u.start, u.len, u.brk); p.split = u.split ? clone(u.split) : null; }
        } else if (p && h) takeHours(p, h);
      } else if (c.type === "takeover") {
        const p = find(c.name), from = find(c.from);
        if (!p || !from || p === from) return;
        const r = rolesOf(from);
        const o = orig[c.from] || { start: from.start, len: from.len, brk: from.brk, split: from.split };
        const h = c.shift && changeHours(key, c.shift);
        const holder = h && !(h.start === o.start && h.len === o.len) && Object.keys(orig).map(n => orig[n]).find(x => x.start === h.start && x.len === h.len);
        if (holder) takeWhole(p, holder, null || h); else takeWhole(p, o, h);
        if (!h || (h.start === o.start && h.len === o.len)) { moved.add(c.id); if (lineBars) moveLine(c, people, lineBars); }
        // "replaces": the covered person goes back to the hours they would have without the block, cover or sheet change that put them there
        if (c.release === true && usual && usual[c.from]) {
          const u = usual[c.from];
          applyHoursToPerson(from, u.start, u.len, u.brk);
          from.split = u.split ? clone(u.split) : null;
        }
        // the anchor shifts are VIP seats; any other shift keeps the queue of the person being covered
        p.roles = Object.assign({}, rolesOf(p), c.shift && c.shift.kind === "anchor" ? { phase1: false, vip: true } : { phase1: r.phase1, vip: r.vip });
      } else if (c.type === "swap") {
        const a = find(c.a), b = find(c.b);
        if (!a || !b || a === b) return;
        const take = p => ({ start: p.start, len: p.len, brk: p.brk, split: p.split ? clone(p.split) : null, phase1: rolesOf(p).phase1, vip: rolesOf(p).vip });
        const sa = c.now ? c.now.a : take(a), sb = c.now ? c.now.b : take(b);
        moved.add(c.id);
        if (lineBars) moveLine(c, people, lineBars);
        [[a, sb], [b, sa]].forEach(([p, t]) => {
          p.start = t.start; p.len = t.len; p.brk = t.brk; p.split = t.split;
          p.roles = Object.assign({}, rolesOf(p), { phase1: t.phase1, vip: t.vip });
        });
      }
    });
    return moved;
  }

  // ---- leave and holidays
  const approvedLeaves = () => leaves.filter(l => l.status === "approved");
  const onLeave = (name, key) => approvedLeaves().some(l => l.name === name && l.start <= key && key <= l.end);
  const sickOn = (name, key) => approvedLeaves().some(l => l.sick === true && l.name === name && l.start <= key && key <= l.end);
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
    // the block's break rotation (a break that does not clash with anyone's Support Line duty), for the people it lists
    Object.keys(rot.breaks || {}).forEach(name => {
      const p = people.find(x => x.name === name), b = rot.breaks[name];
      if (p && Number.isFinite(b) && b >= p.start && b <= p.start + p.len - BRK_LEN) p.brk = b;
    });
    const bars = [];
    rot.slots.forEach((owner, i) => {
      const p = owner && people.find(x => x.name === owner);
      if (!p || !LINE_SLOTS[i]) return;
      bars.push({ owner, start: LINE_SLOTS[i].start, len: LINE_SLOTS[i].len });
      p.roles = Object.assign({}, rolesOf(p), { line: true });
    });
    lineBars.splice(0, lineBars.length, ...bars);
  }
  // The sheet's Late Shift person is released for a night when a lead puts somebody else on the VIP late shift (and both are working that night):
  // they work their usual hours, not the late hours. A cover person who is off, or a Late Shift person who is off, changes nothing.
  function lateReleased(key) {
    const blk = vipBlockFor(key), cov = lateCoverFor(key);
    return !!(blk && blk.late && cov && cov.vip && cov.vip !== blk.late && !isHolidayAway(blk.late, key) && !onLeave(blk.late, key) && !isHolidayAway(cov.vip, key) && !onLeave(cov.vip, key));
  }
  // released by a cover, or by a takeover a command made with release: the person keeps no rotation tag and their own anchor shift is not vacated
  function lateFree(key) {
    const blk = vipBlockFor(key);
    if (!blk || !blk.late) return false;
    if (lateReleased(key)) return true;
    return !isHolidayAway(blk.late, key) && !onLeave(blk.late, key) && changesFor(key).some(c => c.type === "takeover" && c.release === true && c.from === blk.late);
  }
  // a person's roster hours on a night (with the clock change), what "their usual shift" means to a command
  function rosterUsual(name, key) {
    const r = roster.find(x => x.name === name);
    if (!r) return null;
    const u = clone(r), off = dstSlots(key);
    if (off) shiftPersonClock(u, off);
    return u;
  }
  function applyVipBlock(people, key) {
    const blk = vipBlockFor(key);
    if (!blk) return;
    const off = dstSlots(key);
    people.forEach(p => {
      if (blk.late && p.name === blk.late && !lateReleased(key)) {
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
  // ---- Saved nights (the page's personDiff / applyEdits / buildNight / nightEdits / legacyEdits / rotationNames)
  // A saved weekday is { v: 2, ovr: { name: { start, len, brk, split, roles, c } }, lines } (only what a lead changed on it) or, from older versions, a whole
  // snapshot ({ people, lineBars, baked, touched, rot }), which is read through legacyEdits. The night is built like any other night and the overrides
  // are applied last, so everything a lead did not edit follows the sheet.
  const isLegacyDay = (key, d) => !!d && Array.isArray(d.people) && !d.weekendCover && !isSaturday(key);
  const barKey = b => b.owner + "|" + b.start + "|" + b.len;
  function sameBars(a, b) {
    const x = (a || []).map(barKey).sort(), y = (b || []).map(barKey).sort();
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  const plainBars = bars => (bars || []).map(b => ({ owner: b.owner, start: b.start, len: b.len }));
  function personDiff(w, b, withLine) {
    const o = {};
    if (w.start !== b.start) o.start = w.start;
    if (w.len !== b.len) o.len = w.len;
    if (w.brk !== b.brk) o.brk = w.brk;
    if (JSON.stringify(w.split || null) !== JSON.stringify(b.split || null)) o.split = w.split ? clone(w.split) : null;
    const rw = rolesOf(w), rb = rolesOf(b);
    if (["lead", "phase1", "vip"].concat(withLine ? ["line"] : []).some(k => !!rw[k] !== !!rb[k])) o.roles = { lead: !!rw.lead, phase1: !!rw.phase1, vip: !!rw.vip, line: withLine ? !!rw.line : !!rb.line };
    return Object.keys(o).length ? o : null;
  }
  function applyEdits(people, ovr) {
    Object.keys(ovr || {}).forEach(name => {
      const p = people.find(x => x.name === name), o = ovr[name];
      if (!p || !o) return;
      if (Number.isFinite(o.start)) p.start = o.start;
      if (Number.isFinite(o.len)) p.len = o.len;
      if (Number.isFinite(o.brk)) p.brk = o.brk;
      if ("split" in o) p.split = o.split ? clone(o.split) : null;
      if (o.roles) p.roles = Object.assign({}, rolesOf(p), o.roles);
    });
  }
  // Confirmed holiday plans set hours for people on nights.
  function applyHolidayHours(people, key) {
    holidays.forEach(h => {
      if (h.status !== "confirmed") return;
      const row = h.hours && h.hours[key];
      if (!row) return;
      Object.keys(row).forEach(name => {
        const x = row[name], p = people.find(q => q.name === name);
        if (p && x && Number.isFinite(x.start) && Number.isFinite(x.end)) applyHoursToPerson(p, x.start, x.end - x.start, clamp(p.brk, x.start, Math.max(x.start, x.end - 2)));
      });
    });
  }
  function buildNight(key, edits, opts) {
    const people = clone(roster);
    const lineBars = clone(cal.lineBars || []);
    applySheetPlan(people, lineBars, key);
    const off = dstSlots(key);
    if (off) {
      people.forEach(p => shiftPersonClock(p, off));
      lineBars.forEach(b => shiftBarClock(b, off));
    }
    // the night as the sheet alone gives it (before the block, covers and changes): what a command's "replaces" sends the covered person back to
    const usual = {};
    people.forEach(p => { usual[p.name] = { start: p.start, len: p.len, brk: p.brk, split: p.split ? clone(p.split) : null }; });
    applyVipBlock(people, key);
    applyAnchorCover(people, key);
    applyHolidayHours(people, key);
    applyLateCover(people, key);
    const lineMoved = applyChanges(people, key, opts && opts.onlyChanges, lineBars, usual);
    if (edits) {
      applyEdits(people, dropFoldedEdits(edits.ovr, changesFor(key)));
      if (edits.lines) {
        lineBars.splice(0, lineBars.length, ...clone(edits.lines));
        const sig = barsSig(edits.lines);
        changesFor(key).forEach(c => { if (lineMoved.has(c.id) && c.fold === sig) moveLine(c, people, lineBars); });
      }
    }
    return { people, lineBars };
  }
  function nightEdits(key) {
    const d = days[key];
    if (!d || d.weekendCover || isSaturday(key) || isSunday(key)) return null;
    return isLegacyDay(key, d) ? legacyEdits(key, d) : { ovr: d.ovr || {}, lines: d.lines || null };
  }
  function legacyEdits(key, d) {
    const baked = new Set(d.baked || []);
    const usual = buildNight(key, null, { onlyChanges: baked });
    const touched = new Set(d.touched || []);
    changesFor(key).forEach(c => { if (baked.has(c.id)) [c.name, c.from, c.a, c.b].forEach(n => { if (n) touched.add(n); }); });
    const rot = rotationNames(key, d);
    // the late-shift covers a lead added decided those people's hours and queue on that night (they were applied on top of the snapshot), so a
    // snapshot that still shows them somewhere else is not an edit
    const cov = lateCoverFor(key) || {};
    const covered = new Set([cov.vip, cov.phase1].filter(Boolean));
    const ovr = {};
    d.people.forEach(p => {
      const b = usual.people.find(x => x.name === p.name);
      if (!b || covered.has(p.name)) return;
      const diff = personDiff(p, b, false);
      if (!diff) return;
      if (!touched.has(p.name)) {
        if (rot.has(p.name)) return;
        if (Object.keys(diff).every(k => k === "brk")) return;
      }
      ovr[p.name] = diff;
    });
    const lines = touched.size && Array.isArray(d.lineBars) && !sameBars(d.lineBars, usual.lineBars) ? plainBars(d.lineBars) : null;
    return { ovr, lines };
  }
  function rotationNames(key, day) {
    const set = new Set();
    const blk = vipBlockFor(key);
    if (blk) [blk.late, blk.phase1, blk.cover1, blk.cover2].forEach(n => { if (n) set.add(n); });
    if (Array.isArray(day.rot)) day.rot.forEach(n => set.add(n));
    else if (Array.isArray(day.people)) {
      const off = dstSlots(key), lateAt = lateStartFor(key);
      // somebody covering because the block's person is away, or because the holder of an anchor shift moved elsewhere, is a lead's cover, not the rotation
      const lateGone = !!(blk && blk.late && (isHolidayAway(blk.late, key) || onLeave(blk.late, key)));
      const p1Gone = !!(blk && blk.phase1 && (isHolidayAway(blk.phase1, key) || onLeave(blk.phase1, key)));
      day.people.forEach(p => {
        const r = roster.find(x => x.name === p.name);
        if (!r) return;
        const q = queueFromRoles(rolesOf(p));
        const lateHours = p.len === VIP_LATE_LEN && p.start === lateAt && !(lateGone && q === "vip");
        const phase1 = q === "phase1" && queueFromRoles(rolesOf(r)) !== "phase1" && !p1Gone;
        const a = ANCHORS.find(x => p.start === x.start + off && p.len === x.len);
        const holder = a && roster.find(x => x.name !== p.name && x.start + off === p.start && x.len === p.len);
        const holderMoved = !!holder && (() => { const h = day.people.find(x => x.name === holder.name); return !!h && !(h.start === p.start && h.len === p.len); })();
        const anchor = !!a && !(p.start === r.start + off && p.len === r.len) && !holderMoved;
        if (lateHours || phase1 || anchor) set.add(p.name);
      });
    }
    return set;
  }
  // When the block's Late Shift or Phase 1 person normally works an anchor shift, that anchor is vacated for the block. The same happens for
  // one night when a lead puts someone who works an anchor shift on late-shift cover (kind "cover"): the anchor they leave needs a holder.
  function anchorGaps(key) {
    if (isSunday(key) || isSaturday(key)) return [];
    const blk = vipBlockFor(key);
    const cov = lateCoverFor(key);
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
    if (blk) [["late", lateFree(key) ? null : blk.late], ["phase1", blk.phase1]].forEach(([kind, name]) => add(kind, name, blk.start));
    if (cov) [cov.vip, cov.phase1].forEach(name => add("cover", name, key, name + " is covering the late shift."));
    // someone a command moves off their own anchor shift leaves it open as well (a swap leaves nothing open)
    changesFor(key).forEach(c => {
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
    const edits = nightEdits(key);
    const { people, lineBars } = buildNight(key, edits);
    const away = new Set(people.filter(p => isHolidayAway(p.name, key) || onLeave(p.name, key)).map(p => p.name));
    if (edits && edits.lines) markBackupBars(lineBars, away, key);
    else applyLineBackup(people, lineBars, away, key);
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
  // a swap tag says what the person now works when that is the Phase 1 queue or the late shift
  const swapTag = (p, key) => (p.len === VIP_LATE_LEN && p.start === lateStartFor(key) ? "Swap - Late Shift" : queueFromRoles(rolesOf(p)) === "phase1" ? "Swap - Phase 1" : "Swap");

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
      return same.join(", ");
    };
    const lateLo = lateStartFor(key), lateHi = lateLo + VIP_LATE_LEN;
    if (c.vip) out.push({ name: c.vip, kind: "late", tag: "Covering - Late Shift", for: lateReleased(key) ? blk.late : absentFor("vip"), what: "the VIP late shift " + range, lo: lateLo, hi: lateHi });
    if (c.phase1) out.push({ name: c.phase1, kind: "late", tag: "Covering - Phase 1", for: absentFor("phase1"), what: "the Phase 1 late shift " + range, lo: lateLo, hi: lateHi });
    if (c.p1q) {
      const who = day.people.find(x => x.name === c.p1q);
      out.push({ name: c.p1q, kind: "queue", tag: "Covering - Phase 1", for: blk.phase1 || "", what: "Phase 1", lo: who ? who.start : null, hi: who ? who.start + who.len : null });
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
      touched.sort((x, y) => (y[1] ? 1 : 0) - (x[1] ? 1 : 0));
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
        if (prefix) out.push({ name, kind: "change", label: "Swap", tag: swapTag(p, key), for: "", what: "", text: prefix.replace("swapped with", "swapped shifts with") + (bits.length ? ": " + bits.join(" and ") : ""), lo: p.start, hi: p.start + p.len });
        else if (bits.length) out.push({ name, kind: "change", label: "Moved", for: "", what: "", text: "is " + bits.join(" and "), lo: p.start, hi: p.start + p.len });
      });
    }
    // the two-week rotation: tagged "(Late Shift)" / "(Phase 1)" on screen, not part of the covers list
    const rotation = [];
    if (blk.start) {
      const tch = new Set(Object.keys((nightEdits(key) || { ovr: {} }).ovr));
      day.people.forEach(p => {
        if (tch.has(p.name)) return;
        if (blk.late === p.name && lateFree(key)) return;
        if (blk.late === p.name) rotation.push({ name: p.name, label: "Late Shift", lo: p.start, hi: p.start + p.len });
        else if (blk.phase1 === p.name) rotation.push({ name: p.name, label: "Phase 1", lo: p.start, hi: p.start + p.len });
      });
    }
    // anyone else working hours other than their original (roster) shift is covering too
    const shift = dstSlots(key);
    day.people.forEach(p => {
      if (day.away.has(p.name) || out.some(e => e.name === p.name) || rotation.some(e => e.name === p.name)) return;
      const usual = roster.find(x => x.name === p.name);
      if (!usual || (p.start === usual.start + shift && p.len === usual.len)) return;
      // exactly the usual shift of somebody who is away, in the same queue: that is who they are covering
      const away = roster.filter(q => q.name !== p.name && day.away.has(q.name) && q.start + shift === p.start && q.len === p.len && queueFromRoles(rolesOf(q)) === queueFromRoles(rolesOf(p))).map(q => q.name);
      const instead = "working " + span(p.start, p.len) + " instead of their usual " + span(usual.start + shift, usual.len);
      out.push({ name: p.name, kind: "hours", for: away.join(", "), what: "", text: away.length ? "is covering " + away.join(", ") + ": " + instead : "is " + instead, lo: p.start, hi: p.start + p.len });
    });
    // somebody who is away is not covering anyone that night (only the sheet rotation tag stays)
    return { covers: out.filter(e => e.kind === "rotation" || !day.away.has(e.name)), rotation };
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
      const off = st.absent.filter(n => { const pp = day.people.find(x => x.name === n); return pp && rolesOf(pp)[kind]; });
      const who = off.length ? " " + off.join(", ") + (off.length === 1 ? " is" : " are") + " off." : "";
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
    if (blk && blk.phase1 && day.away.has(blk.phase1) && !(lateCoverFor(key) || {}).p1q && !(nightEdits(key) || { ovr: {} }).ovr[blk.phase1]
      && !changesFor(key).some(c =>
        (c.type === "takeover" && c.from === blk.phase1 && !day.away.has(c.name)) ||
        (c.type === "swap" && ((c.a === blk.phase1 && !day.away.has(c.b)) || (c.b === blk.phase1 && !day.away.has(c.a)))) ||
        (c.type === "queue" && c.queue !== "vip" && c.name !== blk.phase1 && !day.away.has(c.name)))) {
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

  return { roster, lateReleased, lateFree, rosterUsual, nightEdits, rolesOf, barsSig, resolveDay, coveringFor, needsCover, vipBlockFor, awayMark, sickOn, lateCoverFor, changesFor, anchorGaps, gapCover, anchorCoverFor, lateStartFor };
}

// ---------------------------------------------------------------------------------------------------------------- the day for the API
function coverEntry(key, e) {
  const text = e.text ? e.name + " " + e.text + "." : e.name + " is covering " + (e.for ? e.for + " on " : "") + e.what + "." + (e.extra ? " " + e.extra : "");
  const out = { kind: e.kind, name: e.name, for: e.for || null, what: e.what || null, text };
  if (e.extra) out.extra = e.extra;
  if (e.label) out.label = e.label;
  if (e.tag) out.tag = e.tag;
  if (Number.isFinite(e.lo) && Number.isFinite(e.hi)) {
    out.from = slotLabel(e.lo);
    out.to = slotLabel(e.hi);
    out.fromAt = slotInstant(key, e.lo);
    out.toAt = slotInstant(key, e.hi);
  }
  return out;
}

// -> { away: [{ name, kind: "off" | "pto", sick?: true }], covers: [...], needsCover: [...], rotation: { phase1, lateShift } } for one shift day.
export function coversForDay(engine, key, weekendNames) {
  if (isSunday(key)) return { away: [], covers: [], needsCover: [], rotation: { phase1: null, lateShift: null } };
  if (isSaturday(key)) {
    // a Saturday is the people the Weekend Cover names; there are no covers on it
    const names = (weekendNames || []).filter(Boolean);
    const away = names.map(n => ({ name: n, kind: engine.awayMark(n, key) })).filter(a => a.kind).map(a => (engine.sickOn(a.name, key) ? Object.assign(a, { sick: true }) : a));
    return { away, covers: [], needsCover: [], rotation: { phase1: null, lateShift: null } };
  }
  const day = engine.resolveDay(key);
  const { covers } = engine.coveringFor(key, day);
  const blk = engine.vipBlockFor(key) || {};
  const away = day.people.filter(p => day.away.has(p.name)).map(p => (({ name: p.name, kind: engine.awayMark(p.name, key) || "pto" })))
    .map(a => (engine.sickOn(a.name, key) ? Object.assign(a, { sick: true }) : a))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    away,
    covers: covers.map(e => coverEntry(key, e)),
    needsCover: engine.needsCover(key, day),
    rotation: { phase1: blk.phase1 || null, lateShift: blk.late || null }
  };
}

export { slotLabel, dstSlots, nightAnchorKey, ANCHORS, VIP_LATE_START, VIP_LATE_LEN, START_MIN, SLOT_MIN, SLOTS, isSaturday, isSunday };
