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

  // nights in the current format, written directly
  const fields = () => ({});
  for (let i = 0; i < saved; i++) {
    const key = day(Math.floor(r() * 85)); if (!weekday(key)) continue;
    const ovr = {};
    for (let j = 0; j < 3; j++) {
      if (r() < 0.6) continue;
      const name = pick(names), o = {};
      if (r() < 0.5) { o.start = Math.floor(r() * 12); o.len = 18; o.brk = o.start + 6 + Math.floor(r() * 4); }
      if (r() < 0.3) o.brk = 10 + Math.floor(r() * 10);
      if (r() < 0.3) o.roles = { lead: false, phase1: r() < 0.5, vip: r() < 0.5, line: false };
      if (r() < 0.1) o.split = { at: 14, after: pick(["phase1", "vip"]) };
      if (r() < 0.2) o.c = 1;
      if (Object.keys(o).length) ovr[name] = o;
    }
    const rec = { v: 2, ovr };
    if (r() < 0.2) rec.lines = [{ owner: pick(names), start: 6, len: 8 }];
    if (Object.keys(ovr).length || rec.lines) data.days[key] = rec;
  }
  void fields;
}

// edits made the way the page makes them (ensureDay, change the people, persist) and copies of a night, on the page's own functions
export function flowScenario(page, r, pick, names, day, weekday, count) {
  const keys = [];
  for (let i = 0; i < count; i++) { const k = day(Math.floor(r() * 85)); if (weekday(k)) keys.push(k); }
  const results = [];
  keys.forEach(key => {
    const w = page.ensureDay(key);
    const touched = [];
    w.people.forEach(p => {
      if (r() < 0.12) { p.start = Math.max(0, Math.min(16, p.start + Math.floor(r() * 5) - 2)); p.brk = Math.min(p.start + 8, p.start + p.len - 2); touched.push(p.name); }
      else if (r() < 0.08) { p.brk = Math.max(p.start, Math.min(p.start + p.len - 2, p.brk + 2)); touched.push(p.name); }
      else if (r() < 0.06) { p.roles = Object.assign({ lead: false, phase1: false, vip: false, line: false }, p.roles || {}, r() < 0.5 ? { phase1: true, vip: false } : { vip: true, phase1: false }); touched.push(p.name); }
    });
    if (r() < 0.1) w.lineBars.push({ owner: pick(names), start: 8, len: 6 });
    const shown = JSON.parse(JSON.stringify(w.people));
    page.persist();
    // what the lead saw while editing is what the night shows right after
    const d = page.resolveDay(key);
    const wrong = shown.filter(sp => { const p = d.people.find(x => x.name === sp.name); return !p || p.start !== sp.start || p.len !== sp.len || p.brk !== sp.brk || JSON.stringify(p.split || null) !== JSON.stringify(sp.split || null) || page.queueFromRoles(page.rolesOf(p)) !== page.queueFromRoles(page.rolesOf(sp)); }).map(x => x.name);
    results.push({ key, wrong });
  });
  // copy some of those nights onto others
  for (let i = 0; i < Math.min(3, keys.length); i++) {
    const to = [day(Math.floor(r() * 85)), day(Math.floor(r() * 85))].filter(weekday);
    if (to.length && to[0] !== keys[i]) page.copyDayTo(keys[i], to.filter(k => k !== keys[i]));
  }
  return results;
}
