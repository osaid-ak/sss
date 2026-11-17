// A realistic team plan for the page-vs-worker comparison and the tests: 14 people, two-week VIP Coverage Plan blocks and four-week Support Line
// rotations for more than a year, the Phase 1 / Support Line hours table, and no leave, holidays or covers (the scenarios add those).
const P = (name, roles, start, len, brk, extra) => Object.assign({ name, roles: Object.assign({ lead: false, phase1: false, vip: false, line: false }, roles), start, len, brk, split: null, queue: roles.phase1 && !roles.vip ? "phase1" : "vip", group: roles.lead ? "Leads" : roles.phase1 && !roles.vip ? "Phase 1" : "VIP" }, extra || {});

export function fixturePlan() {
  const people = [
    P("Ashraf", { vip: true }, 6, 18, 14), P("Osaid", { lead: true, vip: true }, 2, 18, 18), P("Raza", { vip: true }, 4, 18, 12), P("Raahym", { vip: true }, 6, 18, 10),
    P("Jawad", { vip: true }, 8, 18, 16), P("Ivan", { vip: true }, 6, 18, 14), P("Zarminay", { vip: true }, 6, 18, 18), P("Ammana", { vip: true }, 6, 18, 14),
    P("Schanzae", { phase1: true }, 13, 18, 20), P("Ayeshah", { phase1: true, line: true }, 8, 18, 16), P("Qasim", { phase1: true, line: true }, 6, 18, 14),
    P("Zunair", { phase1: true, line: true }, 4, 18, 10), P("Laraib", { phase1: true, line: true }, 4, 18, 12), P("Sibel", { lead: true, vip: true }, 6, 14, 11)
  ];
  const vipNames = ["Ashraf", "Ammana", "Raahym", "Ivan", "Zarminay", "Jawad", "Raza"];
  const key = d => d.toISOString().slice(0, 10);
  const blocks = [];
  let d = new Date(Date.UTC(2026, 8, 28));
  for (let i = 0; i < 40; i++) {
    const start = new Date(d.getTime() + 14 * 86400000 * i);
    const end = new Date(start.getTime() + 11 * 86400000);
    blocks.push({ start: key(start), end: key(end), late: vipNames[i % 7], phase1: vipNames[(i * 3 + 2) % 7], cover1: i % 3 === 0 ? vipNames[(i + 1) % 7] : "", cover2: i % 2 === 0 ? vipNames[(i + 4) % 7] : "" });
  }
  const lineNames = ["Laraib", "Zunair", "Qasim", "Ayeshah"];
  const line = [];
  for (let i = 0; i < 20; i++) {
    const start = new Date(Date.UTC(2026, 8, 28) + 28 * 86400000 * i);
    const end = new Date(start.getTime() + 25 * 86400000);
    line.push({ start: key(start), end: key(end), slots: [lineNames[i % 4], lineNames[(i + 1) % 4], lineNames[(i + 2) % 4]], backup: lineNames[(i + 3) % 4], breaks: { Zunair: 10 + (i % 3) * 2, Laraib: 14, Qasim: 16 + (i % 2) * 2, Ayeshah: 16 } });
  }
  return {
    version: 1, slotOrigin: 900, people, lineBars: [], leaves: [], holidays: [], removed: [], days: {}, lateCover: {}, changes: {}, dst: false,
    vipPlan: { blocks, readAt: "2026-10-01T00:00:00.000Z" },
    sheetPlan: { hours: { Qasim: { start: 6, len: 18, brk: 14 }, Ayeshah: { start: 8, len: 18, brk: 16 }, Schanzae: { start: 13, len: 18, brk: 20 }, Jawad: { start: 8, len: 18, brk: 16 } }, line, readAt: "2026-10-01T00:00:00.000Z" },
    sheetRoster: {}, updatedAt: "2026-10-01T00:00:00.000Z"
  };
}
