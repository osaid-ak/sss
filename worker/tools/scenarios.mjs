// Random scenarios on a plan (leave, holidays, covers, commands, saved nights, Support Line and roster changes), deterministic per seed.
// Every scenario is applied to the page's own data in memory; the same plan is then handed to the worker's engine.
export function rng(seed) { let a = seed >>> 0; return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

const keyOf = d => d.toISOString().slice(0, 10);

// `page` = the loaded page ({ data, resolveDay, ... }); `base` = first day (YYYY-MM-DD) the scenario covers, 85 days.
export function applyScenario(page, seed, opts, base) {
  const r = rng(seed), data = page.data;
  const pick = a => a[Math.floor(r() * a.length)];
  const names = data.people.map(p => p.name);
  const b = new Date(base + "T00:00:00Z");
  const day = i => keyOf(new Date(b.getTime() + i * 86400000));
  const weekday = key => { const w = new Date(key + "T00:00:00Z").getUTCDay(); return w !== 0 && w !== 6; };
  data.leaves = []; data.holidays = [];
  if (opts.leaves) for (let i = 0; i < opts.leaves; i++) { const s = Math.floor(r() * 85), len = Math.floor(r() * 3); data.leaves.push({ id: "fz" + seed + "_" + i, name: pick(names), start: day(s), end: day(s + len), status: "approved", note: "" }); }
  if (opts.holidays) {
    const offs = {};
    for (let i = 0; i < opts.holidays; i++) { const k = day(Math.floor(r() * 85)); offs[k] = offs[k] || {}; offs[k][pick(names)] = r() < 0.5 ? "off" : "pto"; }
    data.holidays.push({ id: "fz" + seed, name: "fuzz", status: "confirmed", start: day(0), end: day(85), offs, hours: {} });
  }
  if (opts.covers) {
    data.lateCover = {};
    for (let i = 0; i < opts.covers; i++) { const e = {}; if (r() < 0.6) e.vip = pick(names); if (r() < 0.6) e.phase1 = pick(names); if (r() < 0.5) e.p1q = pick(names); data.lateCover[day(Math.floor(r() * 85))] = e; }
  }
  if (opts.anchorLate) {
    data.lateCover = data.lateCover || {};
    const anchorPeople = ["Osaid", "Raza", "Jawad", "Ivan"];
    for (let i = 0; i < opts.anchorLate; i++) {
      const e = {}; if (r() < 0.7) e.vip = pick(anchorPeople); if (r() < 0.6) e.phase1 = pick(anchorPeople); if (r() < 0.3) e.p1q = pick(names);
      if (r() < 0.6) { e.anchor = {}; [e.vip, e.phase1].forEach(who => { if (who && r() < 0.7) e.anchor[who] = pick(names); }); if (!Object.keys(e.anchor).length) delete e.anchor; }
      data.lateCover[day(Math.floor(r() * 85))] = e;
    }
  }
  if (opts.changes) {
    data.changes = {};
    let n = 0;
    for (let i = 0; i < opts.changes; i++) {
      const key = day(Math.floor(r() * 85)); if (!weekday(key)) continue;
      const t = pick(["queue", "shift", "takeover", "swap"]); const id = "chg-fz-" + (n++);
      const rec = { id, cmd: "fz", type: t, by: "Fuzz", via: "test", at: "x" };
      if (t === "queue") { rec.name = pick(names); rec.queue = pick(["phase1", "vip", "both"]); }
      else if (t === "shift") { rec.name = pick(names); const k = pick(["late", "anchor", "hours"]); rec.shift = k === "late" ? { kind: "late" } : k === "anchor" ? { kind: "anchor", n: Math.floor(r() * 3) } : { kind: "hours", start: Math.floor(r() * 14), len: 18 }; }
      else if (t === "takeover") { rec.name = pick(names); rec.from = pick(names); if (rec.name === rec.from) continue; if (r() < 0.6) { const k = pick(["late", "anchor", "hours"]); rec.shift = k === "late" ? { kind: "late" } : k === "anchor" ? { kind: "anchor", n: Math.floor(r() * 3) } : { kind: "hours", start: Math.floor(r() * 14), len: 18 }; } }
      else { rec.a = pick(names); rec.b = pick(names); if (rec.a === rec.b) continue; }
      (data.changes[key] = data.changes[key] || []).push(rec);
    }
  }
  if (opts.anchors) data.vipPlan.blocks.forEach(blk => { blk.cover1 = r() < 0.7 ? pick(names) : ""; blk.cover2 = r() < 0.7 ? pick(names) : ""; });
  if (opts.line) data.sheetPlan.line.forEach(blk => { if (r() < 0.5) blk.backup = pick(names); if (r() < 0.3) blk.slots[Math.floor(r() * 3)] = pick(names); });
  if (opts.hours) Object.keys(data.sheetPlan.hours).forEach(n => { const h = data.sheetPlan.hours[n]; if (r() < 0.6) { h.start = Math.floor(r() * 10); h.len = 18; h.brk = h.start + 6; } });
  if (opts.roster) data.people.forEach(p => { if (r() < 0.3) { p.start = Math.floor(r() * 12); p.brk = p.start + 8; } });
  // hand-edited and saved nights, in the page's own storage format
  if (opts.edits || opts.saved) page.scenarioSaved(page, r, pick, names, day, weekday, opts.edits || 0, opts.saved || 0);
  return "scenario " + seed;
}
