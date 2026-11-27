// Commands that change the calendar (from a Slack /calendar command, or anything else with a write key): validate, preview, apply, undo.
//
// Everything here is pure: it takes the stored plan and returns the new plan, nothing is written here. A command is a short list of
// structured operations (the Slack side turns what a lead typed into them; dates may still be words, they are resolved here, deterministically).
// A dry run returns exactly what would change; an apply makes exactly the same change. The Google Sheet is never touched: everything lands in
// the calendar's own plan (leave, covers, and per-night changes that apply to the nights named and nothing else).
//
// Operations:
//   { op: "off",      people: ["Jawad"], dates, note?, sick? }                  approved leave on those days (sick: true = off sick, shown with a thermometer face)
//   { op: "back",     people: ["Jawad"], dates }                               cancel leave on those days (the rest of the leave stays)
//   { op: "takeover", name: "Raza", from: "Jawad", shift?, release?, dates }    Raza works Jawad's queue and shift on those nights; "shift" names
//                                                                                the shift when it is not Jawad's own that night (the 6pm anchor he left);
//                                                                                release: true sends Jawad back to usual hours ("replaces" rather than "covers")
//   { op: "move",     name: "Jawad", queue?: "phase1"|"vip"|"both", shift?, dates }   other queue and/or other hours on those nights
//   { op: "swap",     a: "Jawad", b: "Raza", dates }                            the two exchange shifts and queues on those nights
//   { op: "cover",    kind: "late"|"phase1"|"p1q"|"anchor", name, for?, dates } the calendar's own cover slots (late shift VIP / Phase 1, Phase 1 queue,
//                                                                                the anchor a late-shift cover or a moved person left)
// shift: "late", a clock ("10:30", "6pm" = the late shift or the anchor that starts then), { kind, clock }, hours ("7pm-4am", { from, to }),
//        or "usual" ("original", "own"): the person's own roster hours, break and split (queue and roles stay) - for move only.
// dates: text ("20th Nov to 25th Nov", "coming Monday to Thursday"), { text }, { from, to } or { dates: [...] } (see dates.js).

import { makeEngine, coversForDay, slotLabel, dstSlots, nightAnchorKey, ANCHORS, VIP_LATE_LEN, START_MIN, SLOT_MIN, SLOTS, isSaturday, isSunday } from "./covers.js";
import { resolveDates, DateError, dayLabel, addDays } from "./dates.js";

const clone = v => JSON.parse(JSON.stringify(v));
export class OpError extends Error {}

export function displayName(email) {
  return String(email || "").split("@")[0].split(/[._-]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
}

// ---------------------------------------------------------------------------------------------------------------- small helpers
function person(raw, roster) {
  const needle = String(raw || "").trim().toLowerCase().replace(/['’]s$/, "");
  if (!needle) throw new OpError("a name is missing");
  const by = test => roster.filter(p => test(p.name.toLowerCase()));
  let hits = by(n => n === needle);
  if (!hits.length) hits = by(n => n.startsWith(needle));
  if (!hits.length) hits = by(n => needle.startsWith(n));
  if (!hits.length) hits = by(n => n.includes(needle));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new OpError('I don\'t know anyone called "' + raw + '" on the roster');
  throw new OpError('"' + raw + '" could mean ' + hits.map(h => h.name).join(" or ") + ": say which");
}
const queueWord = q => {
  const t = String(q || "").toLowerCase().replace(/[\s_-]+/g, "").replace(/(?:the|queue|team|teams|handling)/g, "").replace(/one$/, "1");
  if (t === "phase1" || t === "p1" || t === "phase" || t === "tier1") return "phase1";
  if (t === "vip") return "vip";
  if (t === "both" || t === "phase1andvip" || t === "phase1+vip" || t === "vipandphase1" || t === "bothphase1andvip") return "both";
  return null;
};
// "the late shift", "late-shift", "10.30 shift", "the 6 pm anchor", "1030", "from 7pm to 4am" -> the plain words and clocks the rest reads
function cleanShiftText(x) {
  return String(x == null ? "" : x).toLowerCase()
    .replace(/\b(the|a|an|at|from|starting|please|shift|shifts|anchor|slot|seat)\b/g, " ")
    .replace(/(?<=[a-z])[-\u2013\u2014]+(?=\s|$)/g, " ").replace(/\s+/g, " ").trim()
    .replace(/^(\d{1,2})(\d{2})$/, "$1:$2");
}
const qLabel = q => (q === "phase1" ? "Phase 1" : q === "vip" ? "VIP" : "Phase 1 and VIP");
// "his own", "original", "usual hours", "their usual" ... : the person's own roster shift
const USUAL = /^(?:(?:his|her|their|my|its)\s+)?(?:usual|original|own|normal|regular|default)(?:\s+hours)?$/;

// "Mon 23 Nov to Wed 25 Nov, Fri 27 Nov": runs of days (a Sunday between two days does not break a run)
export function describeDates(keys) {
  const list = [...keys].sort();
  const runs = [];
  list.forEach(k => {
    const last = runs[runs.length - 1];
    const gap = last ? (Date.parse(k) - Date.parse(last[last.length - 1])) / 86400000 : 0;
    const sundayOnly = gap === 2 && new Date(Date.parse(last[last.length - 1]) + 86400000).getUTCDay() === 0;
    if (last && (gap === 1 || sundayOnly)) last.push(k); else runs.push([k]);
  });
  return runs.map(r => (r.length === 1 ? dayLabel(r[0]) : dayLabel(r[0]) + " to " + dayLabel(r[r.length - 1]))).join(", ");
}

function clockMinutes(text) {
  const t = String(text || "").trim().toLowerCase().replace(/\s+/g, "");
  const m = t.match(/^(\d{1,2})(?:[.:](\d{2}))?(am|pm|a\.m\.|p\.m\.)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (min > 59 || h > 24) return null;
  const ap = m[3] ? m[3][0] : "";
  if (ap === "p" && h < 12) h += 12;
  else if (ap === "a" && h === 12) h = 0;
  else if (!ap && h >= 3 && h <= 11) h += 12; // the board is 3pm to 8am: 10.30 is 10:30pm (1 and 2 stay as written: 1am, 2am)
  return (h % 24) * 60 + min;
}
const minutesToSlot = min => { let m = min; if (m < START_MIN) m += 24 * 60; return (m - START_MIN) / SLOT_MIN; };

// -> { kind: "late" } | { kind: "anchor", n } | { kind: "hours", start, len } for one night, plus a warning text when the clocks differ
function shiftFor(spec, key) {
  const off = dstSlots(key);
  const lateMin = START_MIN + (13 + off) * SLOT_MIN;
  const anchorMin = n => START_MIN + (ANCHORS[n].start + off) * SLOT_MIN;
  const warn = [];
  let s = spec;
  if (s && typeof s === "object" && (s.kind === "usual" || (s.clock != null && USUAL.test(cleanShiftText(s.clock))))) return { shift: { kind: "usual" }, warn };
  if (typeof s === "string" && USUAL.test(cleanShiftText(s))) return { shift: { kind: "usual" }, warn };
  if (typeof s === "string") {
    const t = cleanShiftText(s);
    const range = t.match(/^(.+?)\s*(?:-|–|—|\bto\b|\btill\b|\buntil\b)\s*(.+)$/);
    if (/^late$/.test(t)) s = { kind: "late" };
    else if (range && clockMinutes(range[1]) != null && clockMinutes(range[2]) != null) s = { hours: { from: range[1], to: range[2] } };
    else s = { clock: t };
  } else if (s && typeof s === "object" && s.clock != null) {
    s = Object.assign({}, s, { clock: cleanShiftText(s.clock) });
    if (/^late$/.test(s.clock)) s = { kind: "late" };
  }
  if (!s || typeof s !== "object") throw new OpError("the shift is missing");
  if (s.hours) {
    const a = clockMinutes(s.hours.from), b = clockMinutes(s.hours.to);
    if (a == null || b == null) throw new OpError('I could not read the hours "' + s.hours.from + " to " + s.hours.to + '"');
    const start = minutesToSlot(a);
    const len = ((b - a + 24 * 60) % (24 * 60)) / SLOT_MIN;
    if (!Number.isInteger(start) || !Number.isInteger(len) || len < 2 || start < 0 || start + len > SLOTS) throw new OpError('"' + s.hours.from + " to " + s.hours.to + '" is outside the 3pm to 8am board or not on the half hour');
    return { shift: { kind: "hours", start, len }, warn };
  }
  if (s.kind === "late") return { shift: { kind: "late" }, warn };
  let clock = s.clock != null ? clockMinutes(s.clock) : null;
  if (s.kind === "anchor" && s.n != null) return { shift: { kind: "anchor", n: Number(s.n) }, warn };
  if (clock == null) throw new OpError('I could not read "' + (s.clock || "") + '" as a shift');
  if (clock === lateMin) return { shift: { kind: "late" }, warn };
  for (let n = 0; n < ANCHORS.length; n++) if (clock === anchorMin(n)) return { shift: { kind: "anchor", n }, warn };
  // "10.30" always means the late shift to the team, even on the other clock (9:30pm in summer time)
  if (clock === START_MIN + 13 * SLOT_MIN || clock === START_MIN + 15 * SLOT_MIN) { warn.push("the late shift starts " + slotLabel(13 + off) + " on " + dayLabel(key) + ", not " + (s.clock || "") + "; used the late shift"); return { shift: { kind: "late" }, warn }; }
  // an anchor named by its standard-time start (5pm, 6pm, 8pm) on a summer-time night
  for (let n = 0; n < ANCHORS.length; n++) if (clock === START_MIN + (ANCHORS[n].start + 2) * SLOT_MIN) { warn.push("on " + dayLabel(key) + " that anchor starts " + slotLabel(ANCHORS[n].start + off) + "; used it"); return { shift: { kind: "anchor", n }, warn }; }
  throw new OpError("no shift starts at " + s.clock + " on " + dayLabel(key) + " (the late shift starts " + slotLabel(13 + off) + "; the anchors start " + ANCHORS.map(a => slotLabel(a.start + off)).join(", ") + "); give the hours instead, like 7pm-4am");
}
const shiftLabel = (shift, key) => {
  const off = dstSlots(key);
  if (shift.kind === "usual") return "usual hours";
  if (shift.kind === "late") return "the late shift " + slotLabel(13 + off) + "–" + slotLabel(13 + off + VIP_LATE_LEN);
  if (shift.kind === "anchor") return "the " + slotLabel(ANCHORS[shift.n].start + off) + "–" + slotLabel(ANCHORS[shift.n].start + off + ANCHORS[shift.n].len) + " shift";
  return slotLabel(shift.start) + "–" + slotLabel(shift.start + shift.len);
};

// ---------------------------------------------------------------------------------------------------------------- the command
// -> { ok: true, cal, result, undo } or { ok: false, errors: [text] }
export function planCommand(doc, req, live, nowMs) {
  const before = doc.calendar || {};
  const cal = clone(before);
  cal.leaves = Array.isArray(cal.leaves) ? cal.leaves : [];
  cal.changes = cal.changes && typeof cal.changes === "object" ? cal.changes : {};
  cal.lateCover = cal.lateCover && typeof cal.lateCover === "object" ? cal.lateCover : {};
  const roster = Array.isArray(cal.people) ? cal.people : [];
  const todayKey = /^\d{4}-\d{2}-\d{2}$/.test(req.today || "") ? req.today : nightAnchorKey(nowMs);
  const cmd = String(req.commandId || "preview");
  const by = displayName(req.actor && req.actor.email) || "someone";
  const via = String(req.via || "Slack");
  const stamp = new Date(nowMs).toISOString();
  const errors = [], warnings = [], lines = [], skipped = [];
  const touched = new Set();
  const undo = { leavesAdded: [], leavesBefore: [], changesAdded: [], cover: [] };
  let seq = 0;
  const eng = () => makeEngine(cal, live, nowMs);
  // the reasons days were skipped by the operation that is running now, to put in its error
  let startSkip = 0;
  const why = () => (skipped.length > startSkip ? " (" + skipped.slice(startSkip).join("; ") + ")" : "");

  const ops = Array.isArray(req.ops) ? req.ops : [];
  if (!ops.length) return { ok: false, errors: ["there is nothing to do: no operations were given"] };
  if (ops.length > 8) return { ok: false, errors: ["too many operations in one command (limit 8)"] };

  // the days an operation may use: dates resolved, Sundays skipped, past nights skipped, Saturdays only when allowed
  function days(op, { saturday }) {
    let r;
    try { r = resolveDates(op.dates, todayKey); } catch (e) { if (e instanceof DateError) throw new OpError(e.message); throw e; }
    r.warnings.forEach(w => warnings.push(w));
    const use = [], why = [];
    r.dates.forEach(k => {
      if (isSunday(k)) why.push(dayLabel(k) + ": Sunday is closed");
      else if (k < todayKey) why.push(dayLabel(k) + ": already past");
      else if (isSaturday(k) && !saturday) why.push(dayLabel(k) + ": Saturdays follow the Weekend Cover sheet, so shifts cannot be changed here");
      else use.push(k);
    });
    why.forEach(w => skipped.push(w));
    if (!use.length) throw new OpError("none of those days can be changed (" + why.join("; ") + ")");
    return use;
  }
  // everybody already used for something that night (one person never gets two jobs)
  function committed(key) {
    const e = eng();
    const c = e.lateCoverFor(key) || {};
    const a = e.anchorCoverFor(key);
    const names = new Set([c.vip, c.phase1, c.p1q, a.late, a.phase1].concat(Object.values(c.anchor || {})).filter(Boolean));
    e.changesFor(key).forEach(ch => [ch.name, ch.from, ch.a, ch.b].forEach(n => n && names.add(n)));
    return names;
  }
  // the Support Line bars a lead had arranged by hand on that night (a swap or takeover moves them too, see covers.js buildNight)
  const linesFold = key => { const e = eng(), ed = e.nightEdits(key); return ed && ed.lines ? e.barsSig(ed.lines) : null; };
  // who holds which Support Line slot on a night, and the sentences for the slots that change hands when `change` runs (a swap or takeover moves them)
  const slotOwners = key => eng().resolveDay(key).lineBars.map(b => ({ at: b.start + "+" + b.len, from: b.start, len: b.len, owner: b.backupInfo ? b.backupInfo.owner : b.owner, holder: b.owner }));
  function withLineMoves(key, change) {
    const before = slotOwners(key);
    change();
    const after = slotOwners(key);
    const moves = [];
    if (before.length === after.length) after.forEach((a, i) => {
      const was = before[i];
      if (was.at === a.at && was.holder !== a.holder) moves.push(was.owner + "'s " + slotLabel(a.from) + "–" + slotLabel(a.from + a.len) + " slot goes to " + a.holder);
    });
    return moves;
  }
  const lineNotes = new Map(); // sentence -> dates it applies to
  const noteLine = (moves, key) => moves.forEach(m => { (lineNotes.get(m) || lineNotes.set(m, []).get(m)).push(key); });
  const flushLineNotes = () => { lineNotes.forEach((keys, m) => lines.push("Support Line: " + m + " " + describeDates(keys) + ".")); lineNotes.clear(); };
  const working = (name, key) => !eng().resolveDay(key).away.has(name);
  function addChange(key, rec) {
    const id = "chg-" + cmd + "-" + (++seq);
    const full = Object.assign({ id, cmd, by, via, at: stamp }, rec);
    (cal.changes[key] = cal.changes[key] || []).push(full);
    undo.changesAdded.push({ date: key, id });
    touched.add(key);
  }

  const handlers = {
    off(op) {
      const names = (Array.isArray(op.people) ? op.people : [op.name]).map(n => person(n, roster).name);
      if (!names.length) throw new OpError("who is off? a name is missing");
      const use = days(op, { saturday: true });
      const sick = op.sick === true || op.sick === "true";
      names.forEach(name => {
        const already = k => eng().awayMark(name, k);
        const kept = use.filter(k => !already(k));
        use.filter(k => already(k)).forEach(k => skipped.push(name + " is already off on " + dayLabel(k)));
        if (!kept.length) return;
        // one leave per run of days (a Sunday between two days does not break it)
        const runs = [];
        kept.forEach(k => {
          const last = runs[runs.length - 1];
          const gap = last ? (Date.parse(k) - Date.parse(last[last.length - 1])) / 86400000 : 0;
          const sundayOnly = gap === 2 && new Date(Date.parse(last[last.length - 1]) + 86400000).getUTCDay() === 0;
          if (last && (gap === 1 || sundayOnly)) last.push(k); else runs.push([k]);
        });
        runs.forEach(run => {
          const id = "lv-cmd-" + cmd + "-" + (++seq);
          cal.leaves.push({ id, name, start: run[0], end: run[run.length - 1], note: String(op.note || ((sick ? "Off sick, added by " : "Added by ") + by + " via " + via)).slice(0, 200), ...(sick ? { sick: true } : {}), status: "approved", requestedAt: stamp, reviewedAt: stamp, reviewNote: "Approved by " + by + " via " + via });
          undo.leavesAdded.push(id);
          run.forEach(k => touched.add(k));
        });
        lines.push(name + " is off " + (sick ? "sick " : "") + describeDates(kept) + " (approved leave).");
        if (kept.some(isSaturday)) warnings.push(name + " is off on a Saturday: the Weekend Cover sheet decides who works it, so the spot needs a name there");
      });
    },

    back(op) {
      const names = (Array.isArray(op.people) ? op.people : [op.name]).map(n => person(n, roster).name);
      const use = days(op, { saturday: true });
      names.forEach(name => {
        const cut = new Set(use);
        let changed = false;
        cal.leaves.slice().forEach(l => {
          if (l.name !== name || l.status !== "approved") return;
          const overlap = use.filter(k => l.start <= k && k <= l.end);
          if (!overlap.length) return;
          changed = true;
          undo.leavesBefore.push(clone(l));
          const lo = overlap[0], hi = overlap[overlap.length - 1];
          const pieces = [];
          if (l.start < lo) pieces.push(Object.assign({}, l, { end: addDays(lo, -1) }));
          pieces.push(Object.assign({}, l, { id: "lv-cmd-" + cmd + "-" + (++seq), start: lo, end: hi, status: "cancelled", reviewNote: "Back early (" + by + " via " + via + ")" }));
          if (hi < l.end) pieces.push(Object.assign({}, l, { id: "lv-cmd-" + cmd + "-" + (++seq), start: addDays(hi, 1) }));
          const at = cal.leaves.indexOf(l);
          cal.leaves.splice(at, 1, ...pieces);
          pieces.slice(1).forEach(pc => undo.leavesAdded.push(pc.id));
          overlap.forEach(k => touched.add(k));
        });
        if (changed) lines.push(name + " is back " + describeDates(use) + " (leave cancelled for those days).");
        else skipped.push(name + " has no approved leave on those days");
        cut.clear();
      });
    },

    takeover(op) {
      const p = person(op.name, roster), from = person(op.from, roster);
      if (p.name === from.name) throw new OpError("someone cannot take over their own shift");
      if (p.roles && p.roles.lead) throw new OpError(p.name + " is a lead; leads are not used as cover");
      const use = days(op, { saturday: false });
      const release = op.release === true || op.release === "true";
      const ok = [], released = [];
      use.forEach(k => {
        if (!working(p.name, k)) { skipped.push(p.name + " is off on " + dayLabel(k) + ", so cannot cover"); return; }
        if (committed(k).has(p.name)) { skipped.push(p.name + " already has a cover or move on " + dayLabel(k)); return; }
        if (working(from.name, k) && op.shift == null) warnings.push(from.name + " is not marked off on " + dayLabel(k));
        let sh = null;
        if (op.shift != null) { const r = shiftFor(op.shift, k); sh = r.shift; r.warn.forEach(w => warnings.push(w)); }
        if (sh && sh.kind === "usual") throw new OpError("a takeover needs a real shift, not usual hours (use move to put someone back on their usual hours)");
        const rec = sh ? { type: "takeover", name: p.name, from: from.name, shift: sh } : { type: "takeover", name: p.name, from: from.name };
        if (release) {
          if (working(from.name, k)) { rec.release = true; released.push(k); }
          else warnings.push(from.name + " is off on " + dayLabel(k) + ", so there is nothing to release");
        }
        const fold = linesFold(k);
        if (fold) rec.fold = fold;
        noteLine(withLineMoves(k, () => addChange(k, rec)), k);
        ok.push(k);
      });
      if (!ok.length) throw new OpError(p.name + " cannot take over " + from.name + "'s shift on any of those days" + why());
      lines.push(p.name + " takes over " + from.name + "'s " + (op.shift != null ? "shift (" + shiftLabel(shiftFor(op.shift, ok[0]).shift, ok[0]).replace(/^the /, "") + ") and queue " : "shift and queue ") + describeDates(ok) + ".");
      flushLineNotes();
      if (released.length) lines.push(from.name + " goes back to usual hours " + describeDates(released) + ".");
    },

    move(op) {
      const p = person(op.name, roster);
      const queue = op.queue != null ? queueWord(op.queue) : null;
      if (op.queue != null && !queue) throw new OpError('"' + op.queue + '" is not a queue (Phase 1, VIP or both)');
      if (!queue && op.shift == null) throw new OpError("move " + p.name + " where? give a queue, a shift, or both");
      const use = days(op, { saturday: false });
      const ok = [], text = [], already = [];
      use.forEach(k => {
        if (!working(p.name, k)) { skipped.push(p.name + " is off on " + dayLabel(k)); return; }
        let sh = null;
        if (op.shift != null) { const r = shiftFor(op.shift, k); sh = r.shift; r.warn.forEach(w => warnings.push(w)); }
        if (sh && sh.kind === "usual") {
          // nothing to record when the night already shows their usual hours (a cover put on the late shift has already sent the sheet's person back)
          const e = eng(), cur = e.resolveDay(k).people.find(x => x.name === p.name), u = e.rosterUsual(p.name, k);
          const same = !!cur && !!u && cur.start === u.start && cur.len === u.len && cur.brk === u.brk && JSON.stringify(cur.split || null) === JSON.stringify(u.split || null);
          if (same) { sh = null; if (!queue) { already.push(k); return; } }
        }
        if (queue) addChange(k, { type: "queue", name: p.name, queue });
        if (sh) addChange(k, { type: "shift", name: p.name, shift: sh });
        ok.push(k);
        if (sh && !text.length) text.push(shiftLabel(sh, k));
      });
      if (!ok.length && !already.length) throw new OpError("nothing to change for " + p.name + why());
      if (already.length) {
        skipped.push(p.name + " is already on usual hours " + describeDates(already));
        lines.push(p.name + " is already on usual hours " + describeDates(already) + ".");
      }
      if (ok.length) {
        const bits = [];
        if (queue) bits.push("to " + qLabel(queue));
        if (op.shift != null && text.length) bits.push("to " + text[0]);
        if (!queue && text[0] === "usual hours") lines.push(p.name + " works usual hours " + describeDates(ok) + ".");
        else lines.push(p.name + " moved " + (bits.join(" and ") || "to the new shift") + " " + describeDates(ok) + ".");
      }
    },

    swap(op) {
      const a = person(op.a, roster), b = person(op.b, roster);
      if (a.name === b.name) throw new OpError("a swap needs two different people");
      const use = days(op, { saturday: false });
      const ok = [];
      use.forEach(k => {
        const bad = [a, b].find(x => !working(x.name, k));
        if (bad) { skipped.push(bad.name + " is off on " + dayLabel(k) + ", so no swap"); return; }
        const used = committed(k);
        const busy = [a, b].find(x => used.has(x.name));
        if (busy) { skipped.push(busy.name + " already has a cover or move on " + dayLabel(k)); return; }
        // each person's shift as it is now (covers and hand edits included): that is what the other one takes over
        const e = eng(), day = e.resolveDay(k), ed = e.nightEdits(k);
        const cur = n => { const p = day.people.find(x => x.name === n); if (!p) return null; const r = e.rolesOf(p); return { start: p.start, len: p.len, brk: p.brk, split: p.split ? clone(p.split) : null, phase1: !!r.phase1, vip: !!r.vip }; };
        const na = cur(a.name), nb = cur(b.name);
        const rec = { type: "swap", a: a.name, b: b.name };
        const fold = linesFold(k);
        if (fold) rec.fold = fold;
        if (na && nb) {
          rec.now = { a: na, b: nb };
          const eo = {};
          if (ed && ed.ovr && ed.ovr[a.name]) eo.a = clone(ed.ovr[a.name]);
          if (ed && ed.ovr && ed.ovr[b.name]) eo.b = clone(ed.ovr[b.name]);
          if (Object.keys(eo).length) rec.edited = eo;
        }
        noteLine(withLineMoves(k, () => addChange(k, rec)), k);
        ok.push(k);
      });
      if (!ok.length) throw new OpError("the swap cannot be made on any of those days" + why());
      lines.push(a.name + " and " + b.name + " swap shifts " + describeDates(ok) + ".");
      flushLineNotes();
    },

    cover(op) {
      const kind = String(op.kind || "").toLowerCase();
      if (!["late", "phase1", "p1q", "anchor"].includes(kind)) throw new OpError('cover kind must be "late", "phase1", "p1q" or "anchor"');
      const p = person(op.name, roster);
      if (p.roles && p.roles.lead) throw new OpError(p.name + " is a lead; leads are not used as cover");
      const use = days(op, { saturday: false });
      const forP = op.for ? person(op.for, roster) : null;
      const ok = [];
      use.forEach(k => {
        const e = eng();
        const day = e.resolveDay(k);
        if (day.away.has(p.name)) { skipped.push(p.name + " is off on " + dayLabel(k)); return; }
        const used = committed(k);
        if (used.has(p.name)) { skipped.push(p.name + " already has a cover or move on " + dayLabel(k)); return; }
        const entry = (cal.lateCover[k] = Object.assign({}, cal.lateCover[k] || {}));
        const field = kind === "late" ? "vip" : kind;
        if (kind === "anchor") {
          if (!forP) throw new OpError("an anchor cover needs the person whose anchor shift it is (for)");
          const gap = e.anchorGaps(k).find(g => g.person === forP.name && g.kind === "cover");
          if (!gap) throw new OpError("there is no open anchor shift left by " + forP.name + " on " + dayLabel(k) + (e.anchorGaps(k).some(g => g.person === forP.name) ? " (that one is filled in on the sheet, which this cannot change)" : ""));
          const rp = day.people.find(x => x.name === p.name);
          if (!(rp && rp.roles && rp.roles.vip)) throw new OpError(p.name + " is not a VIP rep, so cannot hold a VIP anchor shift");
          if (rp.start >= e.lateStartFor(k)) throw new OpError(p.name + " already works the late shift on " + dayLabel(k));
          undo.cover.push({ date: k, field: "anchor", who: forP.name, previous: (entry.anchor || {})[forP.name] || null, now: p.name });
          entry.anchor = Object.assign({}, entry.anchor || {}, { [forP.name]: p.name });
        } else {
          const rp = day.people.find(x => x.name === p.name);
          const rolesNow = (rp && rp.roles) || {};
          if (kind === "late" && !rolesNow.vip) throw new OpError(p.name + " is not a VIP rep, so cannot cover the VIP late shift");
          if (kind === "phase1" && !rolesNow.phase1) throw new OpError(p.name + " is not a Phase 1 rep, so cannot cover the Phase 1 late shift");
          if (kind === "p1q" && !rolesNow.vip) throw new OpError(p.name + " is not a VIP rep, so cannot be moved to Phase 1");
          if (entry[field] && entry[field] !== p.name && !op.replace) throw new OpError(dayLabel(k) + " already has " + entry[field] + " for that (say replace to change it)");
          undo.cover.push({ date: k, field, previous: entry[field] || null, now: p.name });
          entry[field] = p.name;
        }
        cal.lateCover[k] = entry;
        touched.add(k);
        ok.push(k);
      });
      if (!ok.length) throw new OpError(p.name + " cannot be used as that cover on any of those days" + why());
      const what = kind === "late" ? "the VIP late shift" : kind === "phase1" ? "the Phase 1 late shift" : kind === "p1q" ? "Phase 1 (from VIP)" : (forP ? forP.name + "'s anchor shift" : "the anchor shift");
      lines.push(p.name + " covers " + what + " " + describeDates(ok) + ".");
      if (kind === "late") {
        // the sheet's Late Shift person is sent back to usual hours on the nights this covers (see covers.js lateReleased)
        const e = eng(), freed = new Map();
        ok.forEach(k => { if (e.lateReleased(k)) { const n = e.vipBlockFor(k).late; (freed.get(n) || freed.set(n, []).get(n)).push(k); } });
        freed.forEach((keys, n) => lines.push(n + " (the sheet's late-shift person) goes back to usual hours " + describeDates(keys) + "."));
      }
    }
  };

  ops.forEach((op, i) => {
    try {
      const h = handlers[op && op.op];
      if (!h) throw new OpError('unknown operation "' + (op && op.op) + '"');
      startSkip = skipped.length;
      h(op);
    } catch (e) {
      if (e instanceof OpError) errors.push((ops.length > 1 ? "Step " + (i + 1) + ": " : "") + e.message);
      else throw e;
    }
  });
  if (errors.length) return { ok: false, errors, warnings, skipped };
  if (!touched.size) return { ok: false, errors: ["nothing changes: " + (skipped.join("; ") || "no days could be used")], warnings, skipped };

  // what the calendar says about the nights this touched, after the change (and what was already open before it)
  const dates = [...touched].sort();
  const eAfter = makeEngine(cal, live, nowMs), eBefore = makeEngine(before, live, nowMs);
  const open = [], already = new Set();
  dates.forEach(k => {
    coversForDay(eBefore, k, []).needsCover.forEach(n => already.add(k + "|" + n.text));
    coversForDay(eAfter, k, []).needsCover.forEach(n => open.push({ date: k, kind: n.kind, text: n.text, new: !already.has(k + "|" + n.text) }));
  });
  const result = {
    summary: lines, warnings, skipped, dates,
    needsCover: open,
    calendarSays: dates.filter(k => !isSaturday(k)).map(k => ({ date: k, covers: coversForDay(eAfter, k, []).covers.map(c => c.text) })).filter(x => x.covers.length)
  };
  return { ok: true, cal, result, undo };
}

// ---------------------------------------------------------------------------------------------------------------- undo
// Takes back exactly what a command added, and says what it could not (because somebody changed it since).
export function undoCommand(doc, record, nowMs) {
  const cal = clone(doc.calendar || {});
  cal.leaves = Array.isArray(cal.leaves) ? cal.leaves : [];
  cal.changes = cal.changes || {};
  cal.lateCover = cal.lateCover || {};
  const u = record.undo || {};
  const notes = [], lines = [];
  (u.leavesAdded || []).forEach(id => {
    const at = cal.leaves.findIndex(l => l.id === id);
    if (at >= 0) cal.leaves.splice(at, 1); else notes.push("a leave added by that command was already removed");
  });
  (u.leavesBefore || []).forEach(l => {
    // the leave that "back" split: the new pieces were removed above, the first piece still has the original id, so the original goes back in its place
    const cur = cal.leaves.findIndex(x => x.id === l.id);
    if (cur >= 0) cal.leaves.splice(cur, 1, clone(l)); else cal.leaves.push(clone(l));
  });
  (u.changesAdded || []).forEach(({ date, id }) => {
    const list = cal.changes[date] || [];
    if (!list.some(c => c.id === id)) { notes.push("a change on " + dayLabel(date) + " was already removed"); return; }
    cal.changes[date] = list.filter(c => c.id !== id);
    if (!cal.changes[date].length) delete cal.changes[date];
  });
  (u.cover || []).slice().reverse().forEach(c => {
    const entry = cal.lateCover[c.date];
    const cur = entry ? (c.field === "anchor" ? (entry.anchor || {})[c.who] : entry[c.field]) : null;
    if (cur !== c.now) { notes.push("the cover on " + dayLabel(c.date) + " was changed since, so it was left as it is"); return; }
    const e = (cal.lateCover[c.date] = Object.assign({}, entry));
    if (c.field === "anchor") {
      e.anchor = Object.assign({}, e.anchor || {});
      if (c.previous) e.anchor[c.who] = c.previous; else delete e.anchor[c.who];
      if (!Object.keys(e.anchor).length) delete e.anchor;
    } else if (c.previous) e[c.field] = c.previous; else delete e[c.field];
    if (!e.vip && !e.phase1 && !e.p1q && !e.anchor) delete cal.lateCover[c.date];
  });
  lines.push("Undid the command: " + (record.summary || []).join(" "));
  return { cal, lines, notes, at: new Date(nowMs).toISOString() };
}
