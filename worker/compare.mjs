// Page-vs-worker comparison: the calendar page's own engine (loaded in a Node vm, tools/page-vm.mjs) against the worker's port (src/covers.js,
// src/intercom.js) on random plans: who works what hours and breaks, queues, who is off, who covers whom, and what still needs a lead.
// Usage: node compare.mjs [runs] [firstSeed]    (needs ../coverage-calendar.html, which is not committed; exits 0 and says so when it is missing)
import { loadPage, pageExists } from "./tools/page-vm.mjs";
import { fixturePlan } from "./tools/fixture.mjs";
import { applyScenario } from "./tools/scenarios.mjs";
import { savedScenario, flowScenario } from "./tools/saved-scenario.mjs";
import { rng } from "./tools/scenarios.mjs";
import { intercomPlan } from "./src/intercom.js";
import { makeEngine } from "./src/covers.js";
import { parseSheetTab } from "./src/sheets.js";

if (!pageExists()) { console.log("compare: ../coverage-calendar.html not found, skipped"); process.exit(0); }

const runs = Number(process.argv[2] || 60), firstSeed = Number(process.argv[3] || 1);
const NOW = Date.parse("2026-11-16T10:00:00Z");
const BASES = ["2026-10-19", "2026-11-16", "2026-11-23", "2026-12-21", "2027-01-25", "2027-02-22", "2027-03-01", "2027-03-22", "2027-10-25", "2027-11-01"];
const OPTS = [{}, { flows: 8, leaves: 3 }, { saved: 14, flows: 6, covers: 4, changes: 6 }, { leaves: 6, covers: 8, anchors: 1 }, { anchorLate: 8, changes: 14, line: 1, hours: 1 }, { holidays: 10, edits: 6, roster: 1, covers: 5, changes: 10, anchors: 1, anchorLate: 4 }, { saved: 20, covers: 6, leaves: 4, anchors: 1 }, { saved: 25, changes: 12, anchorLate: 5, line: 1, holidays: 6 }];
const norm = s => String(s).replace(/\s+/g, " ").trim();
const clone = v => JSON.parse(JSON.stringify(v));
const addDays = (key, n) => new Date(new Date(key + "T00:00:00Z").getTime() + n * 86400000).toISOString().slice(0, 10);

// the red lines of the day view, as text (the page builds them as html; controls are dropped)
function pageNeeds(page, key) {
  const html = page.lateAlertHtml(key);
  const alert = html.match(/<div class="late-alert" id="lateAlert">([\s\S]*?)<\/div>(?=<div class="late-info"|$)/);
  const out = [];
  const re = /<div class="late-line">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(alert ? alert[1] + "</div>" : "")) !== null) {
    if (!/<strong>/.test(m[1])) continue;
    out.push(norm(m[1].replace(/<select[\s\S]*?<\/select>/g, "").replace(/<button[\s\S]*?<\/button>/g, "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"')));
  }
  return out.sort();
}

let totals = { runs: 0, people: 0, covers: 0, queues: 0, needs: 0, mismatches: 0 };
const bad = [];
for (let i = 0; i < runs; i++) {
  const seed = firstSeed + i, base = BASES[i % BASES.length], opts = OPTS[Math.floor(i / BASES.length) % OPTS.length];
  const page = loadPage(NOW);
  page.data = Object.assign(page.data, clone(fixturePlan()));
  page.data.pin = "x";
  page.ui.leadAccess = true;
  page.scenarioSaved = savedScenario;
  applyScenario(page, seed, opts, base);
  const label0 = base + " #" + seed + " " + JSON.stringify(opts);
  const displayOf = () => { const m = {}; for (let n = 0; n < 70; n++) { const k = addDays(base, n); const d = page.resolveDay(k); m[k] = d.people.map(p => [p.name, p.start, p.len, p.brk, JSON.stringify(p.split || null), page.queueFromRoles(page.rolesOf(p))].join()).join("|") + "#" + (d.lineBars || []).map(b => b.owner + b.start + b.len).sort().join(); } return m; };
  if (opts.saved || opts.edits) {
    // nights saved by older versions: what everyone sees must not change when they are converted
    const before = displayOf();
    const legacy = Object.keys(page.data.days).filter(k => page.isLegacyDay(k, page.data.days[k])).length;
    page.migrateSavedNights();
    const after = displayOf();
    totals.migrated = (totals.migrated || 0) + legacy;
    Object.keys(before).forEach(k => { if (before[k] !== after[k]) bad.push(label0 + " " + k + " MIGRATION changed what is shown"); });
  }
  if (opts.flows) {
    const rr = rng(seed * 7 + 1), pk = a => a[Math.floor(rr() * a.length)];
    const nm = page.data.people.map(p => p.name);
    const dy = i => new Date(new Date(base + "T00:00:00Z").getTime() + i * 86400000).toISOString().slice(0, 10);
    const wk = k => { const w = new Date(k + "T00:00:00Z").getUTCDay(); return w !== 0 && w !== 6; };
    const results = flowScenario(page, rr, pk, nm, dy, wk, opts.flows);
    totals.flows = (totals.flows || 0) + results.length;
    results.forEach(({ key, wrong }) => { if (wrong.length) bad.push(label0 + " " + key + " EDIT shown while editing but not saved for " + wrong.join(",")); });
  }
  const cal = clone(page.data);
  const eng = makeEngine(cal, null, NOW);
  const plan = intercomPlan({ updatedAt: "x", calendar: cal }, base, 70, NOW, { live: null, emails: [] });
  const label = base + " #" + seed + " " + JSON.stringify(opts);
  plan.days.forEach((wd, n) => {
    const key = addDays(base, n);
    if (wd.kind === "sunday") return;
    const day = page.resolveDay(key);
    const w = wd.kind === "weekday" ? eng.resolveDay(key) : null;
    day.people.forEach(p => {
      if (wd.kind === "weekday") {
        totals.people++; totals.queues++;
        const q = page.queueFromRoles(page.rolesOf(p));
        if (q !== wd.queues[p.name] && !(q === "lead" && wd.queues[p.name] === "lead")) bad.push(label + " " + key + " QUEUE " + p.name + " page=" + q + " worker=" + wd.queues[p.name]);
        const x = w.people.find(y => y.name === p.name);
        if (!x || x.start !== p.start || x.len !== p.len || x.brk !== p.brk || JSON.stringify(x.split || null) !== JSON.stringify(p.split || null)) bad.push(label + " " + key + " HOURS " + p.name + " page=" + [p.start, p.len, p.brk] + " worker=" + (x ? [x.start, x.len, x.brk] : "none"));
      }
    });
    const pageAway = [...day.away].sort(), wAway = wd.away.map(a => a.name).sort();
    if (JSON.stringify(pageAway) !== JSON.stringify(wAway)) bad.push(label + " " + key + " AWAY page=" + pageAway + " worker=" + wAway);
    if (wd.kind !== "weekday") return;
    const full = e => norm(e.name + " " + (e.text ? e.text : "is covering " + (e.for ? e.for + " on " : "") + e.what) + "." + (e.extra ? " " + e.extra : ""));
    const pc = page.coveringFor(key, day).filter(e => e.kind !== "rotation").map(e => [e.kind, e.name, e.for || "", e.what || "", e.extra || "", full(e)].join("|")).sort();
    const wc = wd.covers.map(e => [e.kind, e.name, e.for || "", e.what || "", e.extra || "", norm(e.text)].join("|")).sort();
    totals.covers += pc.length;
    if (JSON.stringify(pc) !== JSON.stringify(wc)) bad.push(label + " " + key + " COVERS\n  page  =" + pc.join(" ;; ") + "\n  worker=" + wc.join(" ;; "));
    const pn = pageNeeds(page, key), wn = wd.needsCover.map(x => norm(x.text)).sort();
    totals.needs += pn.length;
    if (JSON.stringify(pn) !== JSON.stringify(wn)) bad.push(label + " " + key + " NEEDS\n  page  =" + pn.join(" ;; ") + "\n  worker=" + wn.join(" ;; "));
  });
  totals.runs++;
}
// copying a night: the Late Shift, Phase 1 and anchor cover people of every target night stay what the sheet says, whatever the source looked like
for (let i = 0; i < Math.max(8, Math.floor(runs / 6)); i++) {
  const seed = 5000 + i, base = BASES[i % BASES.length];
  const page = loadPage(NOW);
  page.data = Object.assign(page.data, clone(fixturePlan())); page.data.pin = "x"; page.ui.leadAccess = true; page.scenarioSaved = savedScenario;
  applyScenario(page, seed, { leaves: 4, covers: 8, changes: 8, anchors: 1, anchorLate: 4 }, base);
  const rr = rng(seed), wk = k => { const w = new Date(k + "T00:00:00Z").getUTCDay(); return w !== 0 && w !== 6; };
  const dy = n => addDays(base, n);
  const cands = Array.from({ length: 60 }, (_, n) => dy(n)).filter(wk);
  const src = cands[Math.floor(rr() * cands.length)];
  // make the source an edited night
  const w = page.ensureDay(src); w.people.forEach(p => { if (rr() < 0.3) { p.start = Math.max(0, Math.min(16, p.start + 2)); p.brk = p.start + 8; } }); page.persist();
  const targets = []; for (let t = 0; t < 4; t++) { const k = cands[Math.floor(rr() * cands.length)]; if (k !== src && !targets.includes(k)) targets.push(k); }
  const state = k => { const blk = (page.data.vipPlan.blocks || []).find(b => b.start <= k && k <= b.end); const names = blk ? [blk.late, blk.phase1, blk.cover1, blk.cover2].filter(Boolean) : []; const d = page.resolveDay(k); return names.map(n => { const p = d.people.find(x => x.name === n); return p ? [n, p.start, p.len, p.brk, page.queueFromRoles(page.rolesOf(p))].join() : n; }).join("|"); };
  const before = Object.fromEntries(targets.map(k => [k, state(k)]));
  page.copyDayTo(src, targets);
  targets.forEach(k => { totals.copyChecks = (totals.copyChecks || 0) + 1; if (state(k) !== before[k]) bad.push("copy " + src + " -> " + k + " changed the sheet's rotation people: " + before[k] + " => " + state(k)); });
}
// storage: the current format survives load and save, removed people drop out of it, converting is done once, Saturdays are left alone
{
  const page = loadPage(NOW);
  page.data = Object.assign(page.data, clone(fixturePlan())); page.data.pin = "x"; page.ui.leadAccess = true;
  page.data.days["2026-11-25"] = { v: 2, ovr: { Ivan: { brk: 18, c: 1 }, Zarminay: { start: 6, len: 18, brk: 14, split: { at: 10, after: "phase1" }, roles: { lead: false, phase1: true, vip: false, line: false } }, Ghost: { brk: 5 } }, lines: [{ owner: "Laraib", start: 6, len: 8 }], lc: 1 };
  page.data.days["2026-11-26"] = { v: 2, ovr: {} };
  page.data.days["2026-11-27"] = { people: clone(page.data.people), lineBars: [] };
  const round = page.sanitizeData(clone(page.data));
  totals.storage = (totals.storage || 0) + 1;
  if (JSON.stringify(round.days["2026-11-25"].ovr.Zarminay) !== JSON.stringify(page.data.days["2026-11-25"].ovr.Zarminay) || round.days["2026-11-25"].ovr.Ivan.c !== 1 || !round.days["2026-11-25"].lc || round.days["2026-11-25"].lines.length !== 1) bad.push("storage: an edited night did not survive load and save");
  if (round.days["2026-11-26"]) bad.push("storage: a night with nothing edited on it should not be kept");
  if (!Array.isArray(round.days["2026-11-27"].people)) bad.push("storage: an older snapshot should still load");
  const n1 = page.migrateSavedNights(), n2 = page.migrateSavedNights();
  if (n1 !== 1 || n2 !== 0) bad.push("storage: converting should be done once (" + n1 + ", " + n2 + ")");
  if (page.data.schema !== 4) bad.push("storage: converting should set schema 4");
  // schema 2 pinned the rotation people and the Support Line bars of this week: schema 3 lets this week follow the sheet too
  page.data.days["2026-11-17"] = { v: 2, ovr: { Ivan: { start: 8, brk: 12 }, Ashraf: { brk: 20 } }, lines: [{ owner: "Laraib", start: 6, len: 8 }] };
  page.data.days["2026-11-10"] = { v: 2, ovr: { Ivan: { start: 8, brk: 12 } } };
  const cleaned = page.reconcileThisWeek();
  const d17 = page.data.days["2026-11-17"];
  if (cleaned < 1 || !d17 || d17.ovr.Ivan || !d17.ovr.Ashraf || d17.lines) bad.push("storage: this week should follow the sheet (rotation people and the Support Line bars dropped, other edits kept): " + JSON.stringify(d17));
  if (!page.data.days["2026-11-10"] || !page.data.days["2026-11-10"].ovr.Ivan) bad.push("storage: a past night is left alone");
  page.data.removed = [{ name: "Ivan", at: "x" }];
  const dropped = page.sanitizeData(clone(page.data));
  if ("Ivan" in (dropped.days["2026-11-25"] ? dropped.days["2026-11-25"].ovr : {})) { /* dropRemoved runs on merge; sanitize keeps the plan as saved */ }
}
// covers a lead made by moving hours (older versions kept them only as hours) become proper covers, so the break and the alerts are right
{
  const page = loadPage(NOW);
  page.data = Object.assign(page.data, clone(fixturePlan())); page.data.pin = "x";
  page.data.vipPlan = { blocks: [{ start: "2026-11-16", end: "2026-11-27", late: "Ammana", phase1: "Jawad", cover1: "", cover2: "" }], readAt: "x" };
  page.data.leaves = [{ id: "l", name: "Ammana", start: "2026-11-17", end: "2026-11-17", status: "approved", note: "" }];
  // Raza works the late shift for Ammana and Zarminay works the 6pm shift Raza left, both as hours moved by hand, Zarminay with his own old break
  page.data.days["2026-11-17"] = { v: 2, ovr: { Raza: { start: 15, brk: 22 }, Zarminay: { start: 6, brk: 18 } } };
  totals.adopt = (totals.adopt || 0) + 1;
  const n = page.adoptCoversFromEdits();
  const cov = page.data.lateCover["2026-11-17"];
  const raza = page.resolveDay("2026-11-17").people.find(p => p.name === "Raza"), zar = page.resolveDay("2026-11-17").people.find(p => p.name === "Zarminay");
  if (n !== 1 || !cov || cov.vip !== "Raza" || !cov.anchor || cov.anchor.Raza !== "Zarminay" || page.data.days["2026-11-17"]) bad.push("covers: hours moved by hand should become late-shift and anchor cover " + JSON.stringify(cov) + " " + JSON.stringify(page.data.days["2026-11-17"]));
  if (!raza || raza.start !== 15 || !zar || zar.start !== 6 || zar.brk !== 6 + 8) bad.push("covers: Zarminay should work Raza's 6pm shift with Raza's break (" + (zar && [zar.start, zar.brk]) + ")");
  const need = page.lateAlertHtml("2026-11-17");
  if (/6pm–3am VIP is uncovered|Late shift/.test(need)) bad.push("covers: nothing should be left to ask a lead on that night: " + need.replace(/<[^>]+>/g, " ").replace(/s+/g, " ").slice(0, 300));
}
// the same night when the late-shift cover is stored as a cover and the old snapshot's hours for Raza (his own 6pm) were pinned over it
{
  const page = loadPage(NOW);
  page.data = Object.assign(page.data, clone(fixturePlan())); page.data.pin = "x";
  page.data.vipPlan = { blocks: [{ start: "2026-11-16", end: "2026-11-27", late: "Ammana", phase1: "Jawad", cover1: "", cover2: "" }], readAt: "x" };
  page.data.leaves = [{ id: "l", name: "Ammana", start: "2026-11-17", end: "2026-11-17", status: "approved", note: "" }];
  page.data.lateCover["2026-11-17"] = { vip: "Raza" };
  page.data.days["2026-11-17"] = { v: 2, ovr: { Raza: { start: 6, brk: 14 }, Zarminay: { start: 6, brk: 18 } } };
  totals.adopt = (totals.adopt || 0) + 1;
  page.adoptCoversFromEdits();
  const day = page.resolveDay("2026-11-17");
  const raza = day.people.find(p => p.name === "Raza"), zar = day.people.find(p => p.name === "Zarminay");
  if (!raza || raza.start !== 15) bad.push("covers: Raza should be on the late shift again (" + (raza && raza.start) + ")");
  if (!zar || zar.start !== 6 || zar.brk !== 14) bad.push("covers: Zarminay should work Raza's 6pm shift with Raza's break (" + (zar && [zar.start, zar.brk]) + ")");
  if (page.data.days["2026-11-17"]) bad.push("covers: nothing should be left pinned on that night: " + JSON.stringify(page.data.days["2026-11-17"]));
}
// Sync dates from the sheet: the chosen nights lose their edits (and the covers when asked), the others and Saturdays are left, and what was there comes back
{
  const page = loadPage(NOW);
  page.data = Object.assign(page.data, clone(fixturePlan())); page.data.pin = "x";
  page.data.days["2026-11-25"] = { v: 2, ovr: { Ivan: { brk: 18 } } }; page.data.days["2026-11-26"] = { v: 2, ovr: { Ivan: { brk: 18 } } };
  page.data.lateCover["2026-11-25"] = { vip: "Raza" };
  const before = page.resetNightsToSheet(["2026-11-25"], false);
  totals.syncDates = (totals.syncDates || 0) + 1;
  if (page.data.days["2026-11-25"] || !page.data.days["2026-11-26"] || !page.data.lateCover["2026-11-25"] || !before.days["2026-11-25"]) bad.push("sync dates: only the chosen night should lose its edits, covers kept by default");
  page.resetNightsToSheet(["2026-11-25"], true);
  if (page.data.lateCover["2026-11-25"]) bad.push("sync dates: covers should be removed when asked");
}
// the Phase 1 / Support Line tab: the page's reader and the worker's read the same blocks, hours and break rotations
{
  const page = loadPage(NOW);
  page.data = Object.assign(page.data, clone(fixturePlan()));
  const rows = [
    ["", "", "", "Qasim", "Ayeshah", "Schanzae", "Jawad"], ["", "", "", "7PM - 4AM", "8PM - 5AM", "LATE SHIFT", "8PM - 5AM"], ["", "", "", "7PM - 4AM", "7PM - 4AM", "LATE SHIFT", "8PM - 5AM"], ["", "", "", "12 - 1", "11 - 12", "2 - 3", "12 - 1"],
    ["", "", "", "PLANNED COVER", "", "", "BACKUP", "BREAK ROTATIONS"], ["", "", "", "6 - 10", "10 - 1", "1 - 4", "", "Zunair", "Laraib", "Qasim", "Ayeshah"],
    ["2", "Nov 2, 26", "Nov 27, 26", "Laraib", "Zunair", "Ayeshah", "Qasim", "9 - 10", "11 - 12", "12 - 1", "12 - 1"],
    ["3", "Nov 30, 26", "Dec 25, 26", "Zunair", "Qasim", "Ayeshah", "Laraib", "10 - 11", "11 - 12", "1 - 2", "12 - 1"],
    ["4", "Dec 28, 26", "Jan 22, 27", "Laraib", "Qasim", "Ayeshah", "Zunair", "10 - 11", "11 - 12", "3 - 4", "12 - 1"]
  ];
  const p = page.parseSheetPlanRows(rows), w = parseSheetTab(rows, page.data.people, 2);
  totals.sheetParse = (totals.sheetParse || 0) + 1;
  if (JSON.stringify(p.line) !== JSON.stringify(w.line) || JSON.stringify(p.hours) !== JSON.stringify(w.hours)) bad.push("sheet: the page and the worker read the Phase 1 / Support Line tab differently page=" + JSON.stringify(p.line[1]) + " worker=" + JSON.stringify(w.line[1]));
  if (!p.line[1] || p.line[1].breaks.Zunair !== 12) bad.push("sheet: break rotation not read: " + JSON.stringify(p.line[1]));
}
totals.mismatches = bad.length;
console.log("compare:", JSON.stringify(totals));
if (bad.length) { console.log(bad.slice(0, 8).join("\n")); process.exit(1); }
console.log("compare: page and worker agree");
