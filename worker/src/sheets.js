// Reads the Google Sheet tabs the calendar page reads (Weekend Cover and "2. VIP Coverage Plan") from the worker, so the read API does not
// depend on somebody having the calendar open. This is the page's own reading code (gvizCellText, parseAnyDate, weekendFindColumns,
// parseWeekendRows, parseVipPlanRows), kept in step with it and checked against it on the live sheet.
// The sheet is read the way the page reads it: Google's gviz JSON endpoint. It must be readable by link; if it is not, the read fails and
// the caller falls back to the copy stored in the plan.

const SHEET_ID = "1k-2i2LNA_tnsEQVghJvVH7F16-8C8HxvUFwIe3RZ7IM";
export const WEEKEND_GID = 1806071421;
export const VIP_GID = 1563923804;
export const PLAN_GID = 274979110; // the Phase 1 / Support Line tab
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHEET_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function gvizCellText(cell) {
  if (!cell) return "";
  const dayText = v => {
    const bits = typeof v === "string" && v.match(/^Date\((\d+),(\d+),(\d+)/);
    if (!bits) return "";
    const d = new Date(Number(bits[1]), Number(bits[2]), Number(bits[3]));
    return d.getDate() + " " + MONTHS[d.getMonth()].slice(0, 3) + " " + d.getFullYear();
  };
  if (/^Date\(\d{4},\d+,\d+\)$/.test(cell.v)) return dayText(cell.v);
  if (cell.f != null && String(cell.f).trim()) return String(cell.f).replace(/\n/g, " ").trim();
  const v = cell.v;
  return dayText(v) || String(v == null ? "" : v).replace(/\n/g, " ").trim();
}
export function parseGvizRows(table) {
  return ((table && table.rows) || []).map(row => (row.c || []).map(gvizCellText));
}

function sheetYmd(y, m, d) {
  y = Number(y); m = Number(m); d = Number(d);
  if (y < 100) y += 2000;
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
}
export function parseAnyDate(raw) {
  let t = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
  if (!t) return null;
  let m = t.match(/^Date\((\d{4}),\s*(\d{1,2}),\s*(\d{1,2})/);
  if (m) return sheetYmd(m[1], Number(m[2]) + 1, m[3]);
  t = t.replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i, "");
  m = t.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/);
  if (m) return sheetYmd(m[1], m[2], m[3]);
  m = t.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}|\d{2})$/);
  if (m && SHEET_MONTHS[m[1].slice(0, 3).toLowerCase()]) return sheetYmd(m[3], SHEET_MONTHS[m[1].slice(0, 3).toLowerCase()], m[2]);
  m = t.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s\-\/.]+([A-Za-z]{3,9})\.?,?[\s\-\/.]+(\d{4}|\d{2})$/);
  if (m && SHEET_MONTHS[m[2].slice(0, 3).toLowerCase()]) return sheetYmd(m[3], SHEET_MONTHS[m[2].slice(0, 3).toLowerCase()], m[1]);
  m = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4}|\d{2})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    return a > 12 ? sheetYmd(m[3], b, a) : sheetYmd(m[3], a, b);
  }
  return null;
}

// The sheet's spelling of a name -> the roster's: exact (any case), then a single roster name that starts the other way round, else as written.
export function matchName(raw, roster) {
  const needle = String(raw || "").trim();
  if (!needle) return "";
  const low = needle.toLowerCase();
  const exact = roster.find(p => p.name.toLowerCase() === low);
  if (exact) return exact.name;
  const loose = roster.filter(p => p.name.toLowerCase().startsWith(low) || low.startsWith(p.name.toLowerCase()));
  return loose.length === 1 ? loose[0].name : needle;
}

const cellAt = (row, index) => (index < 0 || index >= row.length ? "" : String(row[index] || "").replace(/\n/g, " ").trim());
const label = raw => String(raw || "").replace(/\s+/g, " ").trim().toUpperCase();

function weekendColumns(rows) {
  const headerIndex = rows.findIndex(row => row.some(cell => label(cell) === "ACTUAL COVER"));
  if (headerIndex < 0) throw new Error("Could not find the Actual Cover header.");
  const header = rows[headerIndex];
  const labelAt = name => header.findIndex(cell => label(cell) === name);
  const startsWith = prefix => header.findIndex(cell => label(cell).indexOf(prefix) === 0);
  const plannedAt = Math.max(labelAt("PLANNED COVER"), 1);
  const actualAt = labelAt("ACTUAL COVER");
  const swapAt = startsWith("SWAP");
  return { headerIndex, plannedAt, swapAt: swapAt >= 0 ? swapAt : plannedAt + 3, actualAt };
}
const vipNames = (first, second) => {
  const names = [];
  [first, second].forEach(name => { if (name && names.indexOf(name) === -1) names.push(name); });
  return names;
};
// -> [{ date: "2026-11-21", phase1: "Ayeshah", vip: ["Osaid", "Ivan"] }, ...]. Actual Cover wins; Swap, then Planned, only fill in when Actual is blank.
export function parseWeekendRows(rows) {
  const cols = weekendColumns(rows);
  const out = [];
  for (let i = cols.headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    const date = parseAnyDate(cellAt(row, 0));
    if (!date) continue;
    const plannedP1 = cellAt(row, cols.plannedAt);
    const plannedVip = [cellAt(row, cols.plannedAt + 1), cellAt(row, cols.plannedAt + 2)];
    const swapP1 = cellAt(row, cols.swapAt);
    const swapVip = [cellAt(row, cols.swapAt + 1), cellAt(row, cols.swapAt + 2)];
    let phase1 = cellAt(row, cols.actualAt);
    let vip = vipNames(cellAt(row, cols.actualAt + 1), cellAt(row, cols.actualAt + 2));
    if (!phase1) phase1 = swapP1 || plannedP1;
    if (!vip.length) vip = vipNames(swapVip[0] || plannedVip[0], swapVip[1] || plannedVip[1]);
    if (!phase1 && !vip.length) continue;
    out.push({ date, phase1, vip });
  }
  return out;
}

// -> [{ start, end, late, phase1 }, ...] from the VIP Coverage Plan tab (Actual Cover, then Swap, then Planned).
export function parseVipRows(rows) {
  const headerIndex = rows.findIndex(row => row.some(c => label(c) === "ACTUAL COVER"));
  if (headerIndex < 0) throw new Error("Could not find the Actual Cover header on the VIP Coverage Plan tab.");
  const header = rows[headerIndex];
  const subRow = rows[headerIndex + 1] || [];
  const at = name => header.findIndex(c => label(c) === name);
  const swapAt = header.findIndex(c => label(c).indexOf("SWAP") === 0);
  const pair = c => {
    if (c < 0) return null;
    const first = label(subRow[c]), second = label(subRow[c + 1]);
    if (second.indexOf("LATE") === 0 && first.indexOf("PHASE") === 0) return { late: c + 1, phase1: c };
    return { late: c, phase1: c + 1 };
  };
  const planned = pair(at("PLANNED COVER")), swap = pair(swapAt), actual = pair(at("ACTUAL COVER"));
  // Anchor Cover 1 and 2 (columns K and L) are labelled in the row under the group header.
  const cover1At = Math.max(subRow.findIndex(c => label(c) === "ANCHOR 1"), -1);
  const cover2At = Math.max(subRow.findIndex(c => label(c) === "ANCHOR 2"), -1);
  const blocks = [];
  for (let i = headerIndex + 2; i < rows.length; i++) {
    const row = rows[i];
    const dates = row.slice(0, 4).map(parseAnyDate).filter(Boolean);
    if (dates.length < 2) continue;
    const name = (cols, field) => (cols ? cellAt(row, cols[field]) : "");
    const late = name(actual, "late") || name(swap, "late") || name(planned, "late");
    const phase1 = name(actual, "phase1") || name(swap, "phase1") || name(planned, "phase1");
    if (!late && !phase1) continue;
    blocks.push({
      start: dates[0], end: dates[1], late, phase1,
      cover1: cover1At >= 0 ? cellAt(row, cover1At) : "",
      cover2: cover2At >= 0 ? cellAt(row, cover2At) : ""
    });
  }
  blocks.sort((a, b) => a.start.localeCompare(b.start));
  return blocks;
}

// ---- the Phase 1 / Support Line tab: current shift hours, the original shifts and the four-week Support Line rotation
const START_MIN = 15 * 60;
const SLOT_MIN = 30;
const SLOTS = (32 * 60 - START_MIN) / SLOT_MIN;
const VIP_LATE_START = 13;
const VIP_LATE_LEN = 18;
const boardMin = t => (t < START_MIN ? t + 24 * 60 : t);
function sheetClock(h, m, ap) {
  let hr = Number(h) % 12;
  if (/p/i.test(ap)) hr += 12;
  return hr * 60 + Number(m || 0);
}
function parseShift(text) {
  const m = String(text || "").match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
  if (!m) return null;
  const a = sheetClock(m[1], m[2], m[3]);
  const b = sheetClock(m[4], m[5], m[6]);
  return { startMin: boardMin(a), len: ((b - a + 24 * 60) % (24 * 60)) / SLOT_MIN };
}
function parseBreak(text, startMin, lenSlots) {
  const m = String(text || "").match(/^\s*(\d{1,2})(?::(\d{2}))?\s*[-–—]/);
  if (!m) return null;
  const endMin = startMin + lenSlots * SLOT_MIN;
  const base = (Number(m[1]) % 12) * 60 + Number(m[2] || 0);
  for (const c of [base, base + 12 * 60]) {
    const t = boardMin(c % (24 * 60));
    if (t >= startMin && t < endMin) return t;
  }
  return null;
}
// The block of rows at the top: names across, then each person's original shift, current shift and break underneath.
function peopleBlock(rows, roster) {
  const known = new Set(roster.map(p => p.name.toLowerCase()));
  const isName = c => known.has(String(c || "").trim().toLowerCase());
  const hasHours = r => (r || []).some(c => /(AM|PM)/i.test(c) || /late/i.test(c));
  const namesAt = rows.findIndex((r, i) => r.filter((c, j) => j > 0 && isName(c)).length >= 2 && hasHours(rows[i + 1]));
  const out = [];
  if (namesAt < 0) return out;
  rows[namesAt].forEach((cell, j) => {
    if (j === 0 || !isName(cell)) return;
    const original = String((rows[namesAt + 1] || [])[j] || "");
    const current = String((rows[namesAt + 2] || [])[j] || original);
    out.push({ name: matchName(cell, roster), original, current, breakText: (rows[namesAt + 3] || [])[j] });
  });
  return out;
}
// Slots are in the clock of today's season (`off` = 2 in standard time); the calendar stores the summer schedule.
function shiftSlots(text, off) {
  let startMin, len;
  if (/late/i.test(text || "")) {
    startMin = START_MIN + (VIP_LATE_START + off) * SLOT_MIN;
    len = VIP_LATE_LEN;
  } else {
    const sh = parseShift(text);
    if (!sh) return null;
    startMin = sh.startMin;
    len = sh.len;
  }
  const start = Math.round((startMin - START_MIN) / SLOT_MIN) - off;
  if (start < 0 || start + len > SLOTS) return null;
  return { start, len, startMin };
}
const breakSlot = (breakText, shift, off) => {
  const bt = parseBreak(breakText, shift.startMin, shift.len);
  return bt == null ? null : Math.round((bt - START_MIN) / SLOT_MIN) - off;
};
// -> { hours: { name: { start, len, brk } }, line: [{ start, end, slots: [3 names], backup }], originals: { name: { start, len, brk } } }
export function parseSheetTab(rows, roster, off) {
  const hours = {}, originals = {};
  peopleBlock(rows, roster).forEach(r => {
    const cur = shiftSlots(r.current, off);
    if (cur) hours[r.name] = { start: cur.start, len: cur.len, brk: breakSlot(r.breakText, cur, off) };
    const orig = shiftSlots(r.original, off);
    if (orig) {
      // the break row belongs to the current shift, so it only describes the original when the two are the same
      const same = r.current.replace(/\s+/g, "").toUpperCase() === r.original.replace(/\s+/g, "").toUpperCase();
      originals[r.name] = { start: orig.start, len: orig.len, brk: same ? breakSlot(r.breakText, orig, off) : null };
    }
  });
  let backupAt = -1;
  rows.forEach(r => r.forEach((c, j) => { if (backupAt < 0 && /^\s*BACKUP\s*$/i.test(c || "")) backupAt = j; }));
  const line = [];
  rows.forEach(r => {
    if (!/^\s*\d+\s*$/.test(r[0] || "")) return;
    const dates = [r[1], r[2]].map(parseAnyDate);
    if (!dates[0] || !dates[1] || dates[1] < dates[0]) return;
    const bk = backupAt >= 0 ? backupAt : 6;
    line.push({
      start: dates[0], end: dates[1],
      slots: [bk - 3, bk - 2, bk - 1].map(j => matchName(cellAt(r, j), roster)),
      backup: matchName(cellAt(r, bk), roster)
    });
  });
  line.sort((a, b) => a.start.localeCompare(b.start));
  // sanitizeSheetPlan: a shift needs a start and a length of at least 2
  Object.keys(hours).forEach(n => { if (!(hours[n].len >= 2)) delete hours[n]; });
  return { hours, line, originals };
}

// One tab as rows of text, or throws. Times out so a slow Google never holds the API.
export async function fetchSheetRows(gid, fetchImpl, timeoutMs) {
  const url = "https://docs.google.com/spreadsheets/d/" + SHEET_ID + "/gviz/tq?gid=" + gid + "&headers=0&tqx=" + encodeURIComponent("out:json");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 8000);
  try {
    const res = await (fetchImpl || fetch)(url, { signal: ctl.signal });
    if (!res.ok) throw new Error("sheet answered HTTP " + res.status);
    const text = await res.text();
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    if (!json || json.status === "error" || !json.table) throw new Error("sheet tab is not readable");
    return parseGvizRows(json.table);
  } finally {
    clearTimeout(timer);
  }
}

// The three tabs, each on its own: { weekends: [...] | null, blocks: [...] | null, rows: <Phase 1 / Support Line tab rows> | null }.
// A tab that cannot be read is null (the caller uses the stored copy). The third tab is returned as rows because reading it needs the roster.
export async function readSheetsLive(fetchImpl, timeoutMs) {
  const one = async (gid, parse) => {
    try { return parse(await fetchSheetRows(gid, fetchImpl, timeoutMs)); } catch (e) { return null; }
  };
  const [weekends, blocks, rows] = await Promise.all([one(WEEKEND_GID, parseWeekendRows), one(VIP_GID, parseVipRows), one(PLAN_GID, r => r)]);
  return { weekends, blocks, rows };
}
