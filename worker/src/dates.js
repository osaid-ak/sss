// Turns what a person typed ("20th Nov to 25th Nov", "from coming Monday to Thursday", "this week and next", "tomorrow") into exact dates.
// It is deterministic and has no guesses hidden in it: everything it decides is returned (and shown to the lead in the preview before anything
// is written), and anything it cannot read is an error that says what it could not read.
//
// Dates are shift days (the date a night starts on). `todayKey` is the shift day running now (08:00 PKT is when the night rolls over, the same
// as the calendar's Today button).
//
// Rules, so they can be stated to the leads:
//   today / tonight, tomorrow, day after tomorrow, yesterday
//   monday ...      the nearest one on or after today          this monday   the one in the current Monday-Sunday week
//   coming monday   the nearest one AFTER today (also "upcoming", "this coming")      next monday   the one in next week
//   20th Nov, Nov 20, 20 November 2026, 2026-11-20, 20/11, 20.11.2026   a day without a year is the next one that is not long past
//   20/11 and 11/20: a number above 12 shows which is the day; when both are 12 or less it is read DAY first (and a warning says so)
//   A to B, A - B, A till B, A until B, A through B, from A to B, between A and B     both ends included
//   a weekday as the END of a range is the first one on or after the start ("coming Monday to Thursday")
//   A and B, mon, tue and thu                                                          separate days
//   this week (today to Friday), next week (Monday to Friday), this week and next, rest of the week, next 3 days, for 3 days (working days)
// Sundays are closed and Saturdays follow the sheet: they are returned like any other day and the caller decides what to do with them.

const DAY_MS = 86400000;
export class DateError extends Error {}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const WEEKDAYS = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const WD_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const utc = key => { const [y, m, d] = key.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const keyOf = d => d.toISOString().slice(0, 10);
export const addDays = (key, n) => keyOf(new Date(utc(key).getTime() + n * DAY_MS));
const dowOf = key => utc(key).getUTCDay();
const pad = n => String(n).padStart(2, "0");
function makeKey(y, m, d) {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? y + "-" + pad(m) + "-" + pad(d) : null;
}
export function dayLabel(key) {
  const d = utc(key);
  return WD_NAMES[d.getUTCDay()] + " " + d.getUTCDate() + " " + MON_NAMES[d.getUTCMonth()];
}

// the Monday of the week (Monday to Sunday) a day is in
const mondayOf = key => { const w = dowOf(key); return addDays(key, w === 0 ? -6 : 1 - w); };
const weekdayWord = w => (w in WEEKDAYS ? WEEKDAYS[w] : (w.length > 3 && w.slice(0, 3) in WEEKDAYS && /^(sun|mon|tues?|wednes|thurs?|fri|satur)day$/.test(w) ? WEEKDAYS[w.slice(0, 3)] : -1));

// "20th nov", "nov 20", "20 november 2026" -> { key } (or a month-day waiting for a year)
function monthDay(tok, todayKey, warnings) {
  let m = tok.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\.?,?(?:\s+(\d{4}|\d{2}))?$/);
  let day, mon, year;
  if (m) { day = Number(m[1]); mon = MONTHS[m[2].slice(0, 3)]; year = m[3]; if (!mon || !/^[a-z]+$/.test(m[2]) || !(m[2] === "sept" || m[2].length === 3 || monthWord(m[2]))) return null; }
  else {
    m = tok.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}|\d{2}))?$/);
    if (!m) return null;
    mon = MONTHS[m[1].slice(0, 3)]; day = Number(m[2]); year = m[3];
    if (!mon || !(m[1] === "sept" || m[1].length === 3 || monthWord(m[1]))) return null;
  }
  return withYear(day, mon, year, todayKey);
}
const monthWord = w => /^(january|february|march|april|may|june|july|august|september|october|november|december)$/.test(w);

// a date without a year is the same year unless that is long past (then next year)
function withYear(day, mon, year, todayKey) {
  if (year) {
    const y = year.length === 2 ? 2000 + Number(year) : Number(year);
    const key = makeKey(y, mon, day);
    return key ? { key } : null;
  }
  const ty = Number(todayKey.slice(0, 4));
  let key = makeKey(ty, mon, day);
  if (!key) return null;
  if (utc(todayKey).getTime() - utc(key).getTime() > 183 * DAY_MS) key = makeKey(ty + 1, mon, day);
  return key ? { key } : null;
}

// numeric: 2026-11-20, 2026/11/20, 20/11, 20-11-2026, 20.11., 11/20
function numericDate(tok, todayKey, warnings) {
  let m = tok.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) { const key = makeKey(Number(m[1]), Number(m[2]), Number(m[3])); return key ? { key } : null; }
  m = tok.match(/^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{4}|\d{2}))?\.?$/);
  if (!m) return null;
  let a = Number(m[1]), b = Number(m[2]), day, mon;
  if (a > 12) { day = a; mon = b; } else if (b > 12) { day = b; mon = a; }
  else { day = a; mon = b; if (a !== b) warnings.push('"' + tok + '" can be read two ways; read as day ' + a + ", month " + b + " (" + dayMonthLabel(a, b) + ")"); }
  return withYear(day, mon, m[3], todayKey);
}
const dayMonthLabel = (d, m) => d + " " + (MON_NAMES[m - 1] || "?");

// one date-like token -> { key } | { weekday, mod } | null
function token(tok, todayKey, warnings) {
  tok = tok.trim().replace(/^the\s+/, "").replace(/^on\s+/, "").replace(/\s+/g, " ");
  if (!tok) return null;
  if (tok === "today" || tok === "tonight" || tok === "now") return { key: todayKey };
  if (tok === "tomorrow" || tok === "tmrw" || tok === "tomorow" || tok === "tmr") return { key: addDays(todayKey, 1) };
  if (tok === "day after tomorrow" || tok === "the day after tomorrow") return { key: addDays(todayKey, 2) };
  if (tok === "yesterday") return { key: addDays(todayKey, -1) };
  let dom = tok.match(/^(\d{1,2})(?:st|nd|rd|th)$/);
  if (dom) {
    // the next day of the month with that number (this month if it is not past yet)
    const d = Number(dom[1]), y = Number(todayKey.slice(0, 4)), mo = Number(todayKey.slice(5, 7));
    let key = makeKey(y, mo, d);
    if (key && key < todayKey) key = mo === 12 ? makeKey(y + 1, 1, d) : makeKey(y, mo + 1, d);
    return key ? { key } : null;
  }
  let m = tok.match(/^(this coming|this|coming|upcoming|next)?\s*([a-z]+)$/);
  if (m && weekdayWord(m[2]) >= 0 && (m[2].length >= 3)) return { weekday: weekdayWord(m[2]), mod: m[1] || "" };
  return numericDate(tok, todayKey, warnings) || monthDay(tok, todayKey, warnings);
}

// a weekday word, resolved from a starting day
function weekdayFrom(t, from, todayKey, asEnd) {
  const dow = t.weekday;
  const ahead = (base, inclusive) => { let d = (dow - dowOf(base) + 7) % 7; if (!inclusive && d === 0) d = 7; return addDays(base, d); };
  if (asEnd) return ahead(from, true);
  switch (t.mod) {
    case "coming": case "upcoming": case "this coming": return ahead(todayKey, false);
    case "next": return addDays(mondayOf(todayKey), 7 + ((dow + 6) % 7));
    case "this": return addDays(mondayOf(todayKey), (dow + 6) % 7);
    default: return ahead(todayKey, true);
  }
}
function resolveToken(t, from, todayKey, asEnd) {
  if (t.key) return t.key;
  return weekdayFrom(t, from, todayKey, asEnd);
}

function span(a, b) {
  const out = [];
  for (let k = a; k <= b; k = addDays(k, 1)) out.push(k);
  return out;
}
const workdays = (from, count) => { const out = []; let k = from; while (out.length < count) { if (dowOf(k) !== 0) out.push(k); k = addDays(k, 1); if (out.length > 400) break; } return out; };
const weekMonFri = monday => span(monday, addDays(monday, 4));

// "from A to B" and the other range words; null when the text is not a range
function splitRange(text) {
  let m = text.match(/^between\s+(.+?)\s+and\s+(.+)$/);
  if (m) return [m[1], m[2]];
  m = text.match(/^(.+?)\s+(?:to|till|til|until|through|thru)\s+(.+)$/);
  if (m) return [m[1], m[2]];
  m = text.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) return [m[1], m[2]];
  m = text.match(/^(.+?)[–—](.+)$/);
  if (m) return [m[1], m[2]];
  m = text.match(/^(\d{1,2}(?:st|nd|rd|th)?)\s*-\s*(\d{1,2}(?:st|nd|rd|th)?\s+[a-z]{3,9}.*)$/);
  if (m) return [m[1] + " " + m[2].replace(/^\d{1,2}(?:st|nd|rd|th)?\s+/, "").split(" ")[0], m[2]];
  return null;
}

// -> { dates: [sorted unique keys], label, warnings: [text] }
export function resolveDates(spec, todayKey) {
  const warnings = [];
  const fail = msg => { throw new DateError(msg); };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(todayKey || "")) fail("today's date is missing");
  let dates = [];
  if (spec && typeof spec === "object") {
    if (Array.isArray(spec.dates)) dates = spec.dates.map(String);
    else if (spec.from) dates = span(String(spec.from), String(spec.to || spec.from));
    else if (spec.text) return resolveDates(String(spec.text), todayKey);
    else fail("no dates were given");
    if (!dates.length || dates.some(k => !makeKey(...k.split("-").map(Number)))) fail("those dates are not valid (use YYYY-MM-DD)");
    if (dates.length > 62) fail("that is more than 62 days; give a shorter range");
  } else {
    let text = String(spec || "").toLowerCase().replace(/[,;]+\s*$/, "").replace(/\s+/g, " ").trim();
    text = text.replace(/\b(please|pls|only|for|from|starting|beginning|the)\b(?=\s|$)/g, m => (m === "for" || m === "the" ? m : "")).replace(/^\s*(?:from)\s+/, "").replace(/\s+/g, " ").trim();
    text = text.replace(/^(?:for|on)\s+/, "").replace(/^from\s+/, "").replace(/\s+/g, " ").trim();
    if (!text) fail("no dates were given");
    let m;
    if ((m = text.match(/^(?:the\s+)?(?:whole of |all of |rest of |remaining of )?(this|next) week(?: and (?:the )?(next|following)(?: week)?)?$/)) || (m = text.match(/^(?:the\s+)?rest of (?:the|this) week$/))) {
      const rest = /^rest of/.test(text);
      const thisMon = mondayOf(todayKey);
      if (rest || m[1] === "this") {
        const lastDay = addDays(thisMon, 4);
        dates = todayKey > lastDay ? [todayKey] : span(todayKey < thisMon ? thisMon : todayKey, lastDay);
        if (!rest && m && m[2]) dates = dates.concat(weekMonFri(addDays(thisMon, 7)));
      } else dates = weekMonFri(addDays(thisMon, 7));
      if (/whole of|all of/.test(text) && m && m[1] === "this") dates = weekMonFri(thisMon);
    } else if ((m = text.match(/^(?:the )?next (\d{1,2}) (?:working |week)?days?$/)) || (m = text.match(/^for (\d{1,2}) (?:working )?days?$/)) || (m = text.match(/^(\d{1,2}) (?:working )?days?$/))) {
      const n = Number(m[1]);
      if (n < 1 || n > 30) fail("give between 1 and 30 days");
      dates = workdays(todayKey, n);
      warnings.push("counted " + n + " day" + (n === 1 ? "" : "s") + " from today, skipping Sundays");
    } else if ((m = text.match(/^next (\d{1,2}) weeks?$/))) {
      const n = Number(m[1]);
      if (n < 1 || n > 8) fail("give between 1 and 8 weeks");
      dates = [];
      for (let w = 0; w < n; w++) dates = dates.concat(weekMonFri(addDays(mondayOf(todayKey), 7 + 7 * w)));
    } else {
      let range = splitRange(text);
      const open = !range && text.match(/^(?:till|til|until|through|thru|up to)\s+(.+)$/);
      if (open) range = ["today", open[1]];
      if (range) {
        let bTok = range[1].trim();
        const dayStart = range[0].trim().match(/^(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?$/);
        let a = dayStart ? null : token(range[0], todayKey, warnings);
        if (!a && !dayStart) fail('I could not read "' + range[0].trim() + '" as a date');
        let start;
        if (dayStart) {
          // "20th to 25th Nov": the start takes the month (and year) of the end
          const endTok = token(bTok, todayKey, warnings);
          if (!endTok || !endTok.key) fail('I could not read "' + range[0].trim() + " to " + bTok + '" as a range of dates');
          start = makeKey(Number(endTok.key.slice(0, 4)), Number(endTok.key.slice(5, 7)), Number(dayStart[1]));
          if (!start) fail('"' + range[0].trim() + '" is not a day of that month');
          a = { key: start };
        } else start = resolveToken(a, todayKey, todayKey, false);
        const b = token(bTok, todayKey, warnings) || (a.key && /^\d{1,2}(?:st|nd|rd|th)?$/.test(bTok) ? { dayOnly: Number(bTok.replace(/\D/g, "")) } : null);
        if (!b) fail('I could not read "' + bTok + '" as a date');
        let end;
        if (b.dayOnly) { // "20th to 25th Nov": the end day in the start's month
          end = makeKey(Number(start.slice(0, 4)), Number(start.slice(5, 7)), b.dayOnly);
          if (!end) fail('"' + bTok + '" is not a day of that month');
        } else if (b.key && !/\d{4}/.test(bTok) && !/^(today|tonight|tomorrow|tmrw|yesterday)/.test(bTok)) {
          // an end without a year is the first such date on or after the start
          end = b.key;
          if (end < start && Number(start.slice(5, 7)) >= 11 && Number(end.slice(5, 7)) <= 2) end = makeKey(Number(start.slice(0, 4)) + 1, Number(end.slice(5, 7)), Number(end.slice(8, 10))) || end;
          else if (end < start && end.slice(0, 4) !== start.slice(0, 4)) end = makeKey(Number(start.slice(0, 4)), Number(b.key.slice(5, 7)), Number(b.key.slice(8, 10))) || end;
        } else end = resolveToken(b, start, todayKey, true);
        if (end < start) fail("the end (" + dayLabel(end) + ") is before the start (" + dayLabel(start) + ")");
        if (span(start, end).length > 62) fail("that is more than 62 days; give a shorter range");
        dates = span(start, end);
      } else {
        // a list of days: "mon, tue and thu", "today and tomorrow"
        const parts = text.split(/\s*(?:,|\band\b|&|\+)\s*/).filter(Boolean);
        dates = [];
        parts.forEach(part => {
          const t = token(part, todayKey, warnings);
          if (!t) fail('I could not read "' + part.trim() + '" as a date');
          dates.push(resolveToken(t, todayKey, todayKey, false));
        });
      }
    }
  }
  dates = [...new Set(dates)].sort();
  if (!dates.length) fail("no days were found");
  const label = dates.length === 1 ? dayLabel(dates[0]) : dayLabel(dates[0]) + " to " + dayLabel(dates[dates.length - 1]);
  return { dates, label, warnings };
}
