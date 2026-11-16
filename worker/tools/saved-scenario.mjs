// Saved (hand-edited, copied) nights for the random scenarios, in the page's storage format.
export function savedScenario(page, r, pick, names, day, weekday, edits, saved) {
  const data = page.data;
  for (let i = 0; i < edits; i++) {
    const key = day(Math.floor(r() * 85)); if (!weekday(key)) continue;
    const d = page.resolveDay(key); const people = JSON.parse(JSON.stringify(d.people));
    people.forEach(p => {
      if (r() < 0.25) p.roles = Object.assign({ lead: false, phase1: false, vip: false, line: false }, p.roles || {}, r() < 0.5 ? { phase1: true, vip: false } : { vip: true, phase1: false });
      if (r() < 0.2) { p.start = Math.max(0, Math.min(16, p.start + Math.floor(r() * 5) - 2)); p.brk = p.start + 8; }
    });
    data.days[key] = { people, lineBars: JSON.parse(JSON.stringify(d.lineBars)) };
  }
  // nights whose changes are already built in (a lead edited a night that a command had touched)
  Object.keys(data.changes || {}).slice(0, 4).forEach(key => {
    const d = page.resolveDay(key); const baked = data.changes[key].slice(0, 1).map(c => c.id);
    data.days[key] = { people: JSON.parse(JSON.stringify(d.people)), lineBars: JSON.parse(JSON.stringify(d.lineBars)), baked };
  });
  for (let i = 0; i < saved; i++) {
    const key = day(Math.floor(r() * 85)); if (!weekday(key)) continue;
    const d = page.resolveDay(key); const people = JSON.parse(JSON.stringify(d.people));
    const entry = { people, lineBars: JSON.parse(JSON.stringify(d.lineBars)) };
    const mode = r();
    if (mode < 0.4) entry.rot = []; else if (mode < 0.8) { entry.rot = []; for (let j = 0; j < 3; j++) if (r() < 0.7) entry.rot.push(pick(names)); }
    if (r() < 0.4) entry.touched = [pick(names), pick(names)].filter((n, j, a) => a.indexOf(n) === j);
    people.forEach(p => {
      if (r() < 0.12) p.roles = Object.assign({ lead: false, phase1: false, vip: false, line: false }, p.roles || {}, r() < 0.5 ? { phase1: true, vip: false } : { vip: true, phase1: false });
      if (r() < 0.1) { p.start = Math.max(0, Math.min(16, p.start + Math.floor(r() * 5) - 2)); p.brk = p.start + 8; }
    });
    if (mode >= 0.8) delete entry.rot;
    data.days[key] = entry;
  }
}
