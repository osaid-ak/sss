// Loads the calendar page's own script in a Node vm with a stubbed browser, so its engine (resolveDay, coveringFor, the lead alerts) can be
// called and compared with the worker's port (see compare.mjs). The page file is ../../coverage-calendar.html (not committed).
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";

export const PAGE_FILE = new URL("../../coverage-calendar.html", import.meta.url);
export const pageExists = () => existsSync(PAGE_FILE);

// anything touched on the stub answers with another stub, so the page's start-up code runs without a DOM
function stub() {
  const target = function () {};
  const handler = {
    get(_, prop) {
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === "length") return 0;
      if (prop === "then") return undefined;
      if (prop === "classList") return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (prop === "style" || prop === "dataset") return {};
      if (prop === "matches") return false;
      return proxy;
    },
    set() { return true; },
    apply() { return proxy; },
    construct() { return proxy; },
    has() { return true; }
  };
  const proxy = new Proxy(target, handler);
  return proxy;
}

export function loadPage(nowMs) {
  const html = readFileSync(PAGE_FILE, "utf8");
  const start = html.indexOf("<script>", html.indexOf('id="coverage-snapshot"')) + "<script>".length;
  const end = html.lastIndexOf("</script>");
  let js = html.slice(start, end);
  const at = js.lastIndexOf("})();");
  const hook = "  globalThis.__page = { get data() { return data; }, set data(v) { data = v; }, ui, resolveDay, coveringFor, lateAlertHtml, coverageFor, nightEdits, buildNight, legacyEdits, migrateSavedNights, commitWorking, ensureDay, copyDayTo, savedNightRows, personDiff, isLegacyDay, anchorGaps, gapCover, queueFromRoles, rolesOf, sanitizeData, nightAnchor, dateKey, parseKey, plainBars, persist, parseSheetPlanRows, reconcileThisWeek, resetNightsToSheet, adoptCoversFromEdits };\n";
  js = js.slice(0, at) + hook + js.slice(at);
  const store = new Map();
  const localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(nowMs); else super(...a); }
    static now() { return nowMs; }
  }
  const document = stub();
  const window = stub();
  const ctx = {
    console, Math, JSON, Object, Array, Number, String, Boolean, Set, Map, WeakMap, Promise, Symbol, RegExp, Error, TypeError, parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent, Intl, Date: FakeDate, URL, Blob: class {}, Uint8Array, TextEncoder, TextDecoder,
    localStorage, sessionStorage: localStorage, document, window,
    navigator: { userAgent: "node", language: "en" }, location: { href: "http://localhost/", search: "", hash: "", pathname: "/", origin: "http://localhost", replace() {}, reload() {} },
    fetch: () => Promise.reject(new Error("no network in the test")),
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }), getComputedStyle: () => ({}),
    addEventListener() {}, removeEventListener() {}, IntersectionObserver: class { observe() {} disconnect() {} }, ResizeObserver: class { observe() {} disconnect() {} },
    history: { replaceState() {}, pushState() {} }, print() {}, alert() {}, confirm: () => true, prompt: () => null
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(js, ctx, { filename: "coverage-calendar.html" });
  return ctx.__page;
}
