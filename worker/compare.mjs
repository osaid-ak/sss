// Page-vs-worker comparison: the calendar page's own engine (loaded in a Node vm, tools/page-vm.mjs) against the worker's port (src/covers.js,
// src/intercom.js) on random plans: who works what hours and breaks, queues, who is off, who covers whom, and what still needs a lead.
// Usage: node compare.mjs [runs] [firstSeed]    (needs ../coverage-calendar.html, which is not committed; exits 0 and says so when it is missing)
import { loadPage, pageExists } from "./tools/page-vm.mjs";
import { fixturePlan } from "./tools/fixture.mjs";
import { applyScenario } from "./tools/scenarios.mjs";
import { savedScenario } from "./tools/saved-scenario.mjs";
import { intercomPlan } from "./src/intercom.js";
import { makeEngine } from "./src/covers.js";

if (!pageExists()) { console.log("compare: ../coverage-calendar.html not found, skipped"); process.exit(0); }

const runs = Number(process.argv[2] || 60), firstSeed = Number(process.argv[3] || 1);
const NOW = Date.parse("2026-11-16T10:00:00Z");
const BASES = ["2026-10-19", "2026-11-16", "2026-11-23", "2026-12-21", "2027-01-25", "2027-02-22", "2027-03-01", "2027-03-22", "2027-10-25", "2027-11-01"];
const OPTS = [{}, { leaves: 6, covers: 8, anchors: 1 }, { anchorLate: 8, changes: 14, line: 1, hours: 1 }, { holidays: 10, edits: 6, roster: 1, covers: 5, changes: 10, anchors: 1, anchorLate: 4 }, { saved: 20, covers: 6, leaves: 4, anchors: 1 }, { saved: 25, changes: 12, anchorLate: 5, line: 1, holidays: 6 }];
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
totals.mismatches = bad.length;
console.log("compare:", JSON.stringify(totals));
if (bad.length) { console.log(bad.slice(0, 8).join("\n")); process.exit(1); }
console.log("compare: page and worker agree");
