// Offline checks for the sign-in gate and roles. Run: node test.mjs
import worker, { PlanStore } from "./src/index.js";
import { intercomPlan } from "./src/intercom.js";
import { resolveDates, DateError } from "./src/dates.js";
import { planCommand, undoCommand } from "./src/commands.js";

const kvStore = new Map();
const env = {
  GOOGLE_CLIENT_ID: "gid",
  GOOGLE_CLIENT_SECRET: "gsecret",
  SESSION_SECRET: "test-session-secret-123456",
  ALLOWED_EMAILS: "Ann@Example.com, bob@example.com, cat@example.com, dan@example.com",
  ADMIN_EMAILS: "ann@example.com, dan@example.com",
  SUPER_ADMIN: "boss@example.com",
  // an in-memory Durable Object, using the real PlanStore class
  PLAN: (() => {
    const mem = new Map();
    const store = new PlanStore({ storage: { get: async k => mem.get(k), put: async (k, v) => { mem.set(k, v); } } });
    return { idFromName: n => n, get: () => ({ fetch: (url, init) => store.fetch(new Request(url, init)) }) };
  })(),
  ROLES: { get: async k => kvStore.get(k) || null, put: async (k, v) => { kvStore.set(k, v); } },
  ASSETS: { fetch: async () => new Response("<html>CALENDAR</html>", { headers: { "Content-Type": "text/html" } }) }
};
const ORIGIN = "https://plan.test";
let failed = 0;
function check(name, cond) { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) failed++; }
const get = (path, cookie) => worker.fetch(new Request(ORIGIN + path, { headers: cookie ? { Cookie: cookie } : {} }), env);
const post = (path, cookie, body, origin) => worker.fetch(new Request(ORIGIN + path, {
  method: "POST",
  headers: Object.assign({ "Content-Type": "application/json" }, cookie ? { Cookie: cookie } : {}, origin ? { Origin: origin } : {}),
  body: JSON.stringify(body)
}), env);
function cookieOf(res, name) {
  const all = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const hit = all.find(c => c.startsWith(name + "="));
  return hit ? hit.split(";")[0] : null;
}

// mock Google + plan store
let sheetMock = () => new Response("forbidden", { status: 403 });
let googleEmail = "ann@example.com";
let googleVerified = true;
globalThis.fetch = async (url, init) => {
  url = String(url);
  if (url === "https://oauth2.googleapis.com/token") {
    const b = new URLSearchParams(String(init.body));
    return b.get("code") === "good" && b.get("client_secret") === "gsecret" && b.get("redirect_uri") === ORIGIN + "/auth/callback"
      ? Response.json({ access_token: "tok" }) : new Response("no", { status: 400 });
  }
  if (url.startsWith("https://docs.google.com/spreadsheets/")) return sheetMock(url);
  if (url === "https://openidconnect.googleapis.com/v1/userinfo") return Response.json({ email: googleEmail, email_verified: googleVerified });
  return new Response("unexpected " + url, { status: 500 });
};

async function signIn(email, verified = true) {
  googleEmail = email; googleVerified = verified;
  const l = await get("/auth/login");
  const state = new URL(l.headers.get("Location")).searchParams.get("state");
  const r = await get("/auth/callback?code=good&state=" + state, cookieOf(l, "sss_state"));
  return { res: r, session: cookieOf(r, "sss_session") };
}

// 1. signed out
let r = await get("/");
let t = await r.text();
check("signed-out page shows sign-in, not the calendar", r.status === 200 && t.includes("Sign in with Google") && !t.includes("CALENDAR"));
check("signed-out plan request is 401", (await get("/api/team/plan")).status === 401);
check("signed-out /api/me is 401", (await get("/api/me")).status === 401);
check("forged cookie is rejected", (await get("/api/team/plan", "sss_session=forged.value")).status === 401);

// 2. login redirect goes to Google with email-only scope
r = await get("/auth/login");
const loc = new URL(r.headers.get("Location"));
check("login redirects to Google, email scope, callback", loc.origin + loc.pathname === "https://accounts.google.com/o/oauth2/v2/auth" &&
  loc.searchParams.get("client_id") === "gid" && loc.searchParams.get("scope") === "openid email" &&
  loc.searchParams.get("redirect_uri") === ORIGIN + "/auth/callback");
const state = cookieOf(r, "sss_state");
check("callback without state cookie fails", (await get("/auth/callback?code=good&state=" + loc.searchParams.get("state"))).status === 400);
check("callback with wrong state fails", (await get("/auth/callback?code=good&state=wrong", state)).status === 400);
check("callback with rejected code fails", (await get("/auth/callback?code=bad&state=" + loc.searchParams.get("state"), state)).status === 400);

// 3. members and admins
const ann = await signIn("ann@example.com");
check("allowed email gets a session", ann.res.status === 302 && ann.session);
check("signed-in user gets the calendar", (await (await get("/", ann.session)).text()).includes("CALENDAR"));
const bob = await signIn("bob@example.com");
const boss = await signIn("boss@example.com");
check("Super Admin signs in without being in ALLOWED_EMAILS", boss.session);
check("starting roles: admin, member, super", (await (await get("/api/me", ann.session)).json()).role === "admin" &&
  (await (await get("/api/me", bob.session)).json()).role === "member" && (await (await get("/api/me", boss.session)).json()).role === "super");
const putPlan = (cookie, body) => worker.fetch(new Request(ORIGIN + "/api/team/plan", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }), env);
check("no plan yet is a 404 the page understands", (await get("/api/team/plan", bob.session)).status === 404);
const planDoc = { version: 1, updatedAt: "2026-11-13T10:00:00.000Z", parts: 1, calendar: { people: [{ name: "Zed" }], days: {} } };
check("a signed-in member can save the plan", (await putPlan(bob.session, planDoc)).status === 200);
check("the plan comes back exactly as saved", JSON.stringify(await (await get("/api/team/plan", ann.session)).json()) === JSON.stringify(planDoc));
check("a second save replaces the first", (await putPlan(ann.session, Object.assign({}, planDoc, { updatedAt: "2026-11-13T11:00:00.000Z" }))).status === 200 && (await (await get("/api/team/plan", bob.session)).json()).updatedAt === "2026-11-13T11:00:00.000Z");
check("text that is not JSON is refused", (await putPlan(bob.session, "not json")).status === 400);
check("JSON that is not a plan is refused", (await putPlan(bob.session, { hello: "world" })).status === 400);
check("the old part-by-part paths no longer exist", (await get("/api/team/plan/part/0", bob.session)).status === 404);
check("path tricks are refused", (await get("/api/team/../secret", bob.session)).status === 404);
check("signed-out people cannot save the plan", (await worker.fetch(new Request(ORIGIN + "/api/team/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(planDoc) }), env)).status === 401);

// 4. not allowed / unverified
check("email not on the list is denied", (await signIn("eve@example.com")).res.status === 403);
check("unverified Google email is denied", (await signIn("ann@example.com", false)).res.status === 403);

// 5. user list and role changes
check("member cannot list users", (await get("/api/users", bob.session)).status === 403);
check("member cannot change roles", (await post("/api/users", bob.session, { email: "cat@example.com", role: "admin" })).status === 403);
let j = await (await get("/api/users", ann.session)).json();
check("admin sees everyone, Super Admin first", j.users.length === 5 && j.users[0].email === "boss@example.com" && j.users[0].role === "super");
j = await (await post("/api/users", ann.session, { email: "cat@example.com", role: "admin" })).json();
check("admin can promote a member", j.ok && j.users.find(u => u.email === "cat@example.com").role === "admin");
check("promoted member is now an admin", (await (await get("/api/me", (await signIn("cat@example.com")).session)).json()).role === "admin");
check("admin cannot change another admin", (await post("/api/users", ann.session, { email: "dan@example.com", role: "member" })).status === 403);
check("admin cannot change themselves", (await post("/api/users", ann.session, { email: "ann@example.com", role: "member" })).status === 403);
check("nobody can change the Super Admin", (await post("/api/users", boss.session, { email: "boss@example.com", role: "member" })).status === 403);
j = await (await post("/api/users", boss.session, { email: "dan@example.com", role: "member" })).json();
check("Super Admin can demote an admin", j.ok && j.users.find(u => u.email === "dan@example.com").role === "member");
check("demoted admin is a member at once", (await get("/api/users", (await signIn("dan@example.com")).session)).status === 403);
check("bad role is refused", (await post("/api/users", boss.session, { email: "bob@example.com", role: "owner" })).status === 400);
check("unknown person is refused", (await post("/api/users", boss.session, { email: "zed@example.com", role: "admin" })).status === 404);
check("cross-site write is refused", (await post("/api/users", boss.session, { email: "bob@example.com", role: "admin" }, "https://evil.test")).status === 403);

// 5b. adding and removing people
const kvBefore = (await get("/api/users", boss.session).then(r => r.json())).users.length;
check("admin can add a member by email", (await (await post("/api/users", ann.session, { action: "add", email: "New@Example.com", role: "member" })).json()).ok);
const newbie = await signIn("new@example.com");
check("an added person can sign in and is a member", newbie.session && (await (await get("/api/me", newbie.session)).json()).role === "member");
check("added person shows in the user list", (await (await get("/api/users", boss.session)).json()).users.length === kvBefore + 1);
check("adding the same person again is refused", (await post("/api/users", ann.session, { action: "add", email: "new@example.com", role: "member" })).status === 409);
check("admin cannot add an admin", (await post("/api/users", ann.session, { action: "add", email: "x1@example.com", role: "admin" })).status === 403);
check("Super Admin can add an admin", (await (await post("/api/users", boss.session, { action: "add", email: "x2@example.com", role: "admin" })).json()).ok);
check("bad email is refused", (await post("/api/users", boss.session, { action: "add", email: "not-an-email", role: "member" })).status === 400);
check("member cannot add people", (await post("/api/users", bob.session, { action: "add", email: "x3@example.com", role: "member" })).status === 403);
check("admin cannot remove an admin", (await post("/api/users", ann.session, { action: "remove", email: "x2@example.com" })).status === 403);
check("nobody can remove themselves", (await post("/api/users", ann.session, { action: "remove", email: "ann@example.com" })).status === 403);
check("nobody can remove the Super Admin", (await post("/api/users", ann.session, { action: "remove", email: "boss@example.com" })).status === 403);
check("admin can remove a member", (await (await post("/api/users", ann.session, { action: "remove", email: "new@example.com" })).json()).ok);
check("removed added-person is locked out at once", (await get("/api/team/plan", newbie.session)).status === 401);
check("removed person cannot sign in again", (await signIn("new@example.com")).res.status === 403);
check("Super Admin can remove an admin", (await (await post("/api/users", boss.session, { action: "remove", email: "x2@example.com" })).json()).ok);
check("a removed secret-list person is locked out", (await get("/api/team/plan", (await signIn("bob@example.com")).session)).status === 200 && (await (await post("/api/users", boss.session, { action: "remove", email: "bob@example.com" })).json()).ok && (await signIn("bob@example.com")).res.status === 403);
check("a removed person can be added back", (await (await post("/api/users", boss.session, { action: "add", email: "bob@example.com", role: "member" })).json()).ok && (await signIn("bob@example.com")).session);

// 5c. activity log
const logRes = await (await get("/api/log", ann.session)).json();
const events = logRes.log.map(e => e.event);
check("log records sign-ins", events.includes("sign-in"));
check("log records refused sign-ins", logRes.log.some(e => e.event === "sign-in refused" && e.email === "eve@example.com"));
check("log records user changes with who did it", logRes.log.some(e => e.event === "user added" && e.email === "ann@example.com" && /new@example.com/.test(e.detail)));
check("log is newest first", logRes.log[0].t >= logRes.log[logRes.log.length - 1].t);
await worker.fetch(new Request(ORIGIN + "/auth/logout", { headers: { Cookie: boss.session, "CF-Connecting-IP": "203.0.113.9", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64) Chrome/130.0 " + "x".repeat(400), "CF-IPCountry": "PK" } }), env);
const withIp = (await (await get("/api/log", boss.session)).json()).log[0];
check("log stores IP, country and a shortened browser string", withIp.ip === "203.0.113.9" && withIp.country === "PK" && /Chrome/.test(withIp.ua) && withIp.ua.length <= 200);
check("member cannot read the log", (await get("/api/log", bob.session)).status === 403);
await get("/auth/logout", ann.session);
check("sign-out is logged", (await (await get("/api/log", boss.session)).json()).log.some(e => e.event === "sign-out" && e.email === "ann@example.com"));

check("an oversized plan write is refused", (await worker.fetch(new Request(ORIGIN + "/api/team/plan", { method: "POST", headers: { Cookie: bob.session, "Content-Type": "application/json" }, body: "x".repeat(2000001) }), env)).status === 413);

// 5d. plan edits are logged with the person's name
const person = (name, extra) => Object.assign({ name, roles: { vip: true }, start: 4, len: 18, brk: 12, split: null, queue: "vip", group: "VIP" }, extra || {});
const baseCal = {
  people: [person("Raza"), person("Ammana")], lineBars: [], leaves: [], holidays: [], lateCover: {}, days: {},
  vipPlan: { blocks: [], readAt: "" }, sheetPlan: { line: [], hours: {}, readAt: "" }
};
const save = (cookie, cal, at) => putPlan(cookie, { version: 1, updatedAt: at, parts: 1, calendar: cal });
const clone = o => JSON.parse(JSON.stringify(o));
const planLog = async () => (await (await get("/api/log", boss.session)).json()).log.filter(e => e.event === "plan edit");
let before = (await planLog()).length;
await save(ann.session, baseCal, "2026-11-14T09:00:00.000Z");
let edits = (await planLog()).slice(0, (await planLog()).length - before);

before = (await planLog()).length;
let next = clone(baseCal);
next.people[0].start = 6;                                                     // changed hours
next.people.push(person("Zed"));                                              // added to roster
next.leaves.push({ id: "lv1", name: "Ammana", start: "2026-11-18", end: "2026-11-19", status: "pending" });
next.lateCover["2026-11-30"] = { phase1: "Qasim" };                          // late cover
next.days["2026-11-16"] = { people: [person("Raza")], lineBars: [], weekendCover: null }; // a weekday edited by hand
next.holidays.push({ id: "h1", name: "Winter break", start: "2026-12-20", end: "2026-12-31", status: "draft", offs: {}, hours: {} });
next.vipPlan = { blocks: [{ start: "2026-11-30", end: "2026-12-11", late: "Raza", phase1: "Ammana" }], readAt: "x" }; // from the sheet: must not be logged
next.days["2026-11-14"] = { people: [person("Raza")], lineBars: [], weekendCover: { phase1: "Raza", vip: [] } };   // a Saturday built from the sheet: must not be logged
await save(bob.session, next, "2026-11-14T09:05:00.000Z");
let mine = (await planLog()).slice(before);
const text = (await planLog()).slice(0, (await planLog()).length - before).map(e => e.detail).join(" | ");
check("an hours change is logged", /Changed Raza's shift or break/.test(text));
check("a roster addition is logged", /Added Zed to the roster/.test(text));
check("a leave request is logged", /Requested leave for Ammana \(Wed 18 Nov to Thu 19 Nov\)/.test(text));
check("late cover is logged with the date", /Added Phase 1 late shift cover Qasim for Mon 30 Nov/.test(text));
check("a hand-edited weekday is logged", /Edited the schedule for Mon 16 Nov/.test(text));
check("a holiday plan is logged", /Created holiday plan "Winter break"/.test(text));
check("sheet data (VIP blocks) is not logged", !/vip|block/i.test(text.replace(/VIP late shift cover/g, "")));
check("a Saturday built from the sheet is not logged", !/Sat 14 Nov/.test(text));
const newest = (await planLog())[0];
check("every edit carries the person's name and email", newest.name === "Bob" && newest.email === "bob@example.com");

next = clone(next);
next.leaves[0].status = "approved";
next.lateCover = {};
delete next.days["2026-11-16"];
await save(ann.session, next, "2026-11-14T09:10:00.000Z");
const text2 = (await planLog()).slice(0, 3).map(e => e.detail).join(" | ");
if (process.env.SHOW) console.log("EDIT 1: " + text + String.fromCharCode(10) + "EDIT 2: " + text2);
check("an approval is logged", /Approved leave for Ammana/.test(text2));
check("removed cover and a reset day are logged", /Removed Phase 1 late shift cover Qasim for Mon 30 Nov/.test(text2) && /Reset the schedule for Mon 16 Nov to the default/.test(text2));
const countBefore = (await planLog()).length;
await save(ann.session, next, "2026-11-14T09:12:00.000Z");
check("an unchanged save adds no entries", (await planLog()).length === countBefore);
// hours the page took from the sheet are not logged as someone's edit, a hand change still is
const sheet = clone(next);
sheet.people[0].start += 2;
sheet.sheetRoster = { [sheet.people[0].name]: { start: sheet.people[0].start, len: sheet.people[0].len } };
await save(ann.session, sheet, "2026-11-14T09:12:30.000Z");
check("a roster change that matches the sheet is not logged as an edit", (await planLog()).length === countBefore);
const hand = clone(sheet);
hand.people[1].start += 2;
await save(ann.session, hand, "2026-11-14T09:12:40.000Z");
check("a hand change to someone's shift is still logged", /Changed .+'s shift or break/.test((await planLog())[0].detail));
next = hand;
const big = clone(next); for (let i = 0; i < 20; i++) big.people.push(person("P" + i));
await save(ann.session, big, "2026-11-14T09:13:00.000Z");
check("a huge change collapses to one line", /Large change \(20 items\)/.test((await planLog())[0].detail));
check("sign-ins carry the name too", (await (await get("/api/log", boss.session)).json()).log.some(e => e.event === "sign-in" && e.name === "Ann"));

// 6. removing someone locks them out at once
const saved = env.ALLOWED_EMAILS;
env.ALLOWED_EMAILS = "ann@example.com";
check("removed email loses access with an existing session", (await get("/api/team/plan", bob.session)).status === 401);
env.ALLOWED_EMAILS = saved;

// a new deploy (new BUILD_ID) signs everyone out; signing in again works
env.BUILD_ID = "20260101000000";
const carl = await signIn("ann@example.com");
check("a session from the same deploy works", (await get("/api/team/plan", carl.session)).status !== 401);
env.BUILD_ID = "20260102000000";
check("a session from an earlier deploy is rejected", (await get("/api/team/plan", carl.session)).status === 401);
const stale = await get("/", carl.session);
check("a stale session sees the sign-in page and its cookie is cleared", (await stale.text()).includes("Sign in with Google") && /sss_session=;.*Max-Age=0/.test(stale.headers.get("Set-Cookie") || ""));
const again = await signIn("ann@example.com");
const fullLog = async () => (await (await get("/api/log", again.session)).json()).log;
const endedLog = await fullLog();
check("the deploy and the person's ended session are logged", endedLog.some(e => e.event === "deploy" && e.name === "System" && /build 20260102000000/.test(e.detail)) && endedLog.some(e => e.event === "session ended" && e.email === "ann@example.com"));
await get("/", carl.session);
check("a second visit with the same old cookie does not add a second deploy line", (await fullLog()).filter(e => e.event === "deploy").length === 1);
check("signing in again after a deploy works", (await get("/api/team/plan", again.session)).status !== 401);
delete env.BUILD_ID;

// 6. read-only API for automations (API key, not a Google sign-in)
env.API_KEYS = "intercom:key-for-intercom-123, other:key-for-other-456";
const keyed = (path, key, method) => worker.fetch(new Request(ORIGIN + path, { method: method || "GET", headers: key ? { Authorization: "Bearer " + key } : {} }), env);
const who = await signIn("ann@example.com");
const rp = (name, extra) => person(name, extra);
const apiCal = {
  people: [
    rp("Raza"), rp("Ivan"), rp("Ammana"),
    rp("Osaid", { roles: { lead: true, vip: true }, group: "Leads" }),
    rp("Ayeshah", { roles: { phase1: true }, queue: "phase1", group: "Phase 1", email: "Ayeshah@Autoleap.com" }),
    rp("Cat")
  ],
  lineBars: [], leaves: [], holidays: [], sheetPlan: { line: [], hours: {}, readAt: "" },
  vipPlan: { blocks: [{ start: "2026-11-16", end: "2026-11-27", late: "Ammana", phase1: "Raza", cover1: "", cover2: "" }], readAt: "2026-11-14T08:00:00.000Z" },
  // Tue 17: a lead edited the day and moved Ivan to Phase 1 (Raza is the rotation's Phase 1 person, so he is normal)
  days: {
    "2026-11-17": { people: [rp("Raza", { roles: { phase1: true } }), rp("Ivan", { roles: { phase1: true } }), rp("Ammana"), rp("Ayeshah", { roles: { phase1: true } })], lineBars: [] },
    // Sat 21: weekend cover names Ivan for Phase 1
    "2026-11-21": { people: [], lineBars: [], weekendCover: { phase1: "Ivan", vip: ["Raza", "Osaid"] } }
  },
  // Wed 18: a Phase 1 queue cover (Ammana, VIP) and a VIP late shift cover that changes nothing (Ivan is VIP already)
  lateCover: { "2026-11-18": { p1q: "Ammana", vip: "Ivan" } }
};
await putPlan(who.session, { version: 1, updatedAt: "2026-11-14T10:00:00.000Z", parts: 1, calendar: apiCal });
check("API without a key is refused", (await keyed("/api/v1/intercom-plan")).status === 401);
check("API with a wrong key is refused", (await keyed("/api/v1/intercom-plan", "nope")).status === 401);
check("a signed-in session is not an API key", (await get("/api/v1/intercom-plan", who.session)).status === 401);
check("API is read only", (await keyed("/api/v1/intercom-plan", "key-for-intercom-123", "POST")).status === 405);
check("an unknown API path is 404", (await keyed("/api/v1/other", "key-for-intercom-123")).status === 404);
check("a second key works too", (await keyed("/api/v1/intercom-plan?from=2026-11-16", "key-for-other-456")).status === 200);
check("bad dates and day counts are 400", (await keyed("/api/v1/intercom-plan?from=2026-13-40", "key-for-intercom-123")).status === 400 && (await keyed("/api/v1/intercom-plan?days=0", "key-for-intercom-123")).status === 400 && (await keyed("/api/v1/intercom-plan?days=32", "key-for-intercom-123")).status === 400);
const apiRes = await keyed("/api/v1/intercom-plan?from=2026-11-16&days=8", "key-for-intercom-123");
const apiBody = await apiRes.json();
const dayOf = d => apiBody.days.find(x => x.date === d);
check("API answers with the contract fields", apiRes.status === 200 && apiBody.version === 1 && apiBody.days.length === 8 && apiBody.boundary === "15:00" && apiBody.planUpdatedAt === "2026-11-14T10:00:00.000Z" && apiBody.sheetReadAt === "2026-11-14T08:00:00.000Z" && apiRes.headers.get("Cache-Control") === "private, no-store");
check("roster lists each person's normal queue and who is a lead", apiBody.roster.find(p => p.name === "Osaid").lead === true && apiBody.roster.find(p => p.name === "Ayeshah").normalQueue === "phase1" && apiBody.roster.find(p => p.name === "Ivan").normalQueue === "vip");
check("Monday: nothing decided, the rotation person is named", dayOf("2026-11-16").decisions.length === 0 && dayOf("2026-11-16").rotationPhase1 === "Raza" && dayOf("2026-11-16").kind === "weekday" && dayOf("2026-11-16").boundary === "2026-11-16T15:00:00+05:00");
const tue = dayOf("2026-11-17");
check("edited day: only the person the lead moved is a decision", tue.edited === true && tue.decisions.length === 1 && tue.decisions[0].name === "Ivan" && tue.decisions[0].queue === "phase1" && tue.decisions[0].reason === "day edited by a lead");
const wed = dayOf("2026-11-18");
check("Phase 1 queue cover is a decision and a late cover that changes nothing is not", wed.decisions.length === 1 && wed.decisions[0].name === "Ammana" && wed.decisions[0].queue === "phase1" && wed.decisions[0].reason === "Phase 1 queue cover");
const sat = dayOf("2026-11-21");
const satNames = sat.decisions.map(d => d.name + ":" + d.queue).join(",");
check("Saturday: everyone the Weekend Cover names is a decision with that queue", sat.kind === "saturday" && satNames === "Ivan:phase1,Osaid:vip,Raza:vip" && sat.decisions.every(d => d.reason === "weekend cover"));
check("Saturday: the rotation person (Raza, named as VIP) goes to VIP, Friday's block names them", sat.rotationPhase1 === "Raza");
check("Saturday: the rotation person NOT named stays where they are (no decision)", (await (await keyed("/api/v1/intercom-plan?from=2026-11-28&days=1", "key-for-intercom-123")).json()).days[0].decisions.length === 0);
check("Sunday is closed: nothing decided", dayOf("2026-11-22").kind === "sunday" && dayOf("2026-11-22").decisions.length === 0);
check("the lead flag is carried on a decision", sat.decisions.find(d => d.name === "Osaid").lead === true && sat.decisions.find(d => d.name === "Ivan").lead === false);
check("emails: written on the roster entry, else the one allowed email that contains the name, else null", apiBody.roster.find(p => p.name === "Ayeshah").email === "ayeshah@autoleap.com" && apiBody.roster.find(p => p.name === "Cat").email === "cat@example.com" && apiBody.roster.find(p => p.name === "Raza").email === null);
check("a decision carries the person's email", tue.decisions[0].email === null && sat.decisions.every(d => "email" in d));
check("the answer says the sheet data came from the stored copy when the sheet cannot be read", apiBody.sources.weekendCover === "stored" && apiBody.sources.rotation === "stored");
check("queues: the whole intended state per person (rotation person on Phase 1, the lead's move, the rest normal)", JSON.stringify(dayOf("2026-11-16").queues) === JSON.stringify({ Raza: "phase1", Ivan: "vip", Ammana: "vip", Osaid: "vip", Ayeshah: "phase1", Cat: "vip" }) && dayOf("2026-11-17").queues.Ivan === "phase1" && dayOf("2026-11-17").queues.Raza === "phase1" && dayOf("2026-11-18").queues.Ammana === "phase1");
check("queues on a Saturday: named VIPs go to VIP, the rotation person stays on Phase 1 unless named, the named Phase 1 person goes to Phase 1", dayOf("2026-11-21").queues.Raza === "vip" && dayOf("2026-11-21").queues.Ivan === "phase1" && dayOf("2026-11-21").queues.Ayeshah === "phase1" && dayOf("2026-11-21").queues.Ammana === "vip");
const sat28 = (await (await keyed("/api/v1/intercom-plan?from=2026-11-28&days=1", "key-for-intercom-123")).json()).days[0];
check("queues on a Saturday that does not name the rotation person: they stay on Phase 1", sat28.queues.Raza === "phase1" && sat28.queues.Ivan === "vip");
check("queues is null on a Sunday (closed: hold)", dayOf("2026-11-22").queues === null);
check("the key never appears in an answer", !JSON.stringify(apiBody).includes("key-for"));
const apiLog = (await (await get("/api/log", boss.session)).json()).log.filter(e => e.event === "api refused");
check("refused API calls are logged once, without the key", apiLog.length === 1 && !JSON.stringify(apiLog).includes("nope"));
// live sheet read: the answer follows the sheet, not the stored copy
const g = (v, f) => (f ? { v, f } : { v });
const weekendTable = { status: "ok", table: { rows: [
  { c: ["Weekend", "PLANNED COVER", "", "", "SWAP COVER", "", "", "ACTUAL COVER", "", "", "STATUS"].map(v => g(v)) },
  { c: ["", "PHASE 1", "VIP", "VIP", "PHASE 1", "VIP", "VIP", "PHASE 1", "VIP", "VIP", ""].map(v => g(v)) },
  { c: [g("Date(2026,10,21)", "Nov 21, 2026"), g("Laraib"), g("Raza"), g("Ivan"), g(""), g(""), g(""), g("Ammana"), g("Ivan"), g("Osaid"), g("")] }
] } };
const vipTable = { status: "ok", table: { rows: [
  { c: ["#", "START", "END", "PLANNED COVER", "", "SWAP", "", "ACTUAL COVER", ""].map(v => g(v)) },
  { c: ["", "", "", "LATE SHIFT", "PHASE 1", "LATE SHIFT", "PHASE 1", "LATE SHIFT", "PHASE 1"].map(v => g(v)) },
  { c: [g("1"), g("Date(2026,10,16)", "Nov 16, 2026"), g("Date(2026,10,27)", "Nov 27, 2026"), g(""), g(""), g(""), g(""), g("Ammana"), g("Ivan")] }
] } };
let sheetCalls = 0;
sheetMock = url => {
  sheetCalls++;
  const body = url.includes("gid=1806071421") ? weekendTable : url.includes("gid=1563923804") ? vipTable : null;
  return body ? new Response("/*O_o*/\ngoogle.visualization.Query.setResponse(" + JSON.stringify(body) + ");") : new Response("no", { status: 404 });
};
const liveBody = await (await keyed("/api/v1/intercom-plan?from=2026-11-16&days=8", "key-for-intercom-123")).json();
const liveDay = d => liveBody.days.find(x => x.date === d);
check("the sheet is read live on every call and the answer says so", sheetCalls === 3 && liveBody.sources.weekendCover === "sheet" && liveBody.sources.rotation === "sheet");
check("live rotation: Monday's rotation person is the sheet's (Ivan), not the stored copy's (Raza)", liveDay("2026-11-16").rotationPhase1 === "Ivan");
check("live weekend names win over the stored ones", liveDay("2026-11-21").decisions.map(d => d.name + ":" + d.queue).join(",") === "Ammana:phase1,Ivan:vip,Osaid:vip" && liveDay("2026-11-21").rotationPhase1 === "Ivan");
check("an edited day is judged against the live rotation (Raza is no longer the Phase 1 person)", liveDay("2026-11-17").decisions.map(d => d.name).join(",") === "Raza");
sheetMock = url => (url.includes("gid=1806071421") ? new Response("/*O_o*/\ngoogle.visualization.Query.setResponse(" + JSON.stringify(weekendTable) + ");") : new Response("down", { status: 500 }));
const half = await (await keyed("/api/v1/intercom-plan?from=2026-11-16&days=8", "key-for-intercom-123")).json();
check("one tab unreadable: that tab falls back to the stored copy and the answer says which", half.sources.weekendCover === "sheet" && half.sources.rotation === "stored" && half.days.find(d => d.date === "2026-11-16").rotationPhase1 === "Raza");
sheetMock = () => { throw new Error("network down"); };
const down = await keyed("/api/v1/intercom-plan?from=2026-11-16&days=8", "key-for-intercom-123");
check("sheet completely unreachable: the answer still works from the stored plan", down.status === 200 && (await down.json()).sources.weekendCover === "stored");
sheetMock = () => new Response("forbidden", { status: 403 });

// 7. who is off and who is covering whom (the page's own logic, ported; compared with the page in the browser on many plans)
const CP = (name, extra) => Object.assign({ name, roles: { vip: true }, start: 6, len: 18, brk: 14, split: null, queue: "vip", group: "VIP" }, extra || {});
const coverCal = {
  people: [CP("Ammana"), CP("Raza", { start: 4, brk: 12 }), CP("Zarminay"), CP("Ivan"), CP("Jawad", { start: 8, brk: 16 }),
    CP("Ayeshah", { roles: { phase1: true }, queue: "phase1", group: "Phase 1" }),
    CP("Qasim", { roles: { phase1: true, line: true }, queue: "phase1", group: "Phase 1" }),
    CP("Laraib", { roles: { phase1: true, line: true }, queue: "phase1", group: "Phase 1" }),
    CP("Osaid", { start: 2, brk: 10 })],
  // Raza (the 6pm-3am anchor shift) is the block's Late Shift person, so his anchor is vacated and Zarminay (Anchor Cover 1) covers it
  vipPlan: { blocks: [{ start: "2026-11-16", end: "2026-11-27", late: "Raza", phase1: "Jawad", cover1: "Zarminay", cover2: "" }], readAt: "x" },
  leaves: [{ id: "l1", name: "Ammana", start: "2026-11-17", end: "2026-11-17", status: "approved" }, { id: "l2", name: "Laraib", start: "2026-11-18", end: "2026-11-18", status: "approved" }, { id: "l3", name: "Ivan", start: "2026-11-18", end: "2026-11-18", status: "pending" }],
  holidays: [{ id: "h1", status: "confirmed", offs: { "2026-11-19": { Ivan: "off", Qasim: "pto" } } }, { id: "h2", status: "draft", offs: { "2026-11-20": { Zarminay: "off" } } }],
  // 23 Nov: Osaid (the 5pm-2am anchor) covers the late shift and a lead picked Zarminay for the anchor he left; 25 Nov: nobody picked yet
  lateCover: { "2026-11-17": { vip: "Ivan", p1q: "Ayeshah" }, "2026-11-23": { vip: "Osaid", anchor: { Osaid: "Zarminay" } }, "2026-11-25": { vip: "Osaid" } },
  sheetPlan: { hours: {}, line: [{ start: "2026-11-16", end: "2026-11-27", slots: ["Laraib", "Qasim", "Ayeshah"], backup: "Ivan" }], readAt: "x" },
  days: { "2026-11-24": { people: [CP("Ammana"), CP("Zarminay")], lineBars: [] }, "2026-11-20": { people: [CP("Ammana"), CP("Zarminay")], lineBars: [] }, "2026-11-21": { people: [], lineBars: [], weekendCover: { phase1: "Ivan", vip: ["Raza", "Ammana"] } } },
  lineBars: []
};
const cvPlan = intercomPlan({ updatedAt: "x", calendar: coverCal }, "2026-11-16", 12, Date.parse("2026-11-16T10:00:00Z"), { live: null, emails: [] });
const cv = d => cvPlan.days.find(x => x.date === d);
const texts = d => cv(d).covers.map(c => c.text);
check("away: approved leave and confirmed holiday offs count, pending leave and draft plans do not", cv("2026-11-17").away.map(a => a.name + ":" + a.kind).join() === "Ammana:pto" && cv("2026-11-18").away.map(a => a.name).join() === "Laraib" && cv("2026-11-19").away.map(a => a.name + ":" + a.kind).join() === "Ivan:off,Qasim:pto" && cv("2026-11-20").away.length === 0);
check("anchor cover: the vacated 6pm-3am shift of the Late Shift person is covered by Anchor Cover 1, with the times", texts("2026-11-16").includes("Zarminay is covering Raza on the 6pm–3am VIP shift.") && cv("2026-11-16").covers.find(c => c.kind === "anchor").from === "6pm" && cv("2026-11-16").covers.find(c => c.kind === "anchor").to === "3am");
const lateCover = cv("2026-11-17").covers.find(c => c.kind === "late");
check("late shift cover: who, what and the exact times (PKT, and as UTC instants)", lateCover.name === "Ivan" && lateCover.text === "Ivan is covering the VIP late shift 10:30pm–7:30am." && lateCover.from === "10:30pm" && lateCover.to === "7:30am" && lateCover.fromAt === "2026-11-17T17:30:00.000Z" && lateCover.toAt === "2026-11-18T02:30:00.000Z");
check("Phase 1 queue cover names the rotation person it replaces", texts("2026-11-17").includes("Ayeshah is covering Jawad on Phase 1."));
check("Support Line: the sheet's backup takes the slot of an owner who is off, and says how the shift moved", texts("2026-11-18").includes("Ivan is covering Laraib on Support Line 6pm–10pm. Ivan's shift was adjusted to 6pm–3am to cover the Support Line."));
check("needs cover: a late shift without a Phase 1 person, an uncovered anchor, and a Support Line slot nobody can take", cv("2026-11-19").needsCover.some(n => n.kind === "late" && /needs a Phase 1 person/.test(n.text)) && cv("2026-11-19").needsCover.some(n => n.kind === "anchor" && /Anchor 2 on the VIP Coverage Plan sheet/.test(n.text)) && cv("2026-11-19").needsCover.some(n => n.kind === "line" && n.text === "Support Line 10pm–1am owner Qasim is off. Backup Ivan is off too."));
check("the rotation people are named (Late Shift person); saved nights follow the sheet too, so the anchor cover shows on them", cv("2026-11-16").lateShift === "Raza" && cv("2026-11-20").covers.some(c => c.kind === "anchor") && cv("2026-11-24").covers.some(c => c.kind === "anchor" && c.name === "Zarminay"));

// saved nights: from next week on the sheet's Late Shift and Phase 1 coverage apply to them, except to people edited directly; this week is left as saved
const savedPeople = (rotName, extra) => coverCal.people.map(p => { const q = JSON.parse(JSON.stringify(p)); if (q.name === rotName) { q.roles = { phase1: true }; q.queue = "phase1"; } return q; });
const followCal = day => Object.assign({}, coverCal, { days: Object.assign({}, coverCal.days, day) });
const queuesOn = (cal, date) => intercomPlan({ updatedAt: "x", calendar: cal }, date, 1, Date.parse("2026-11-16T10:00:00Z"), { live: null, emails: [] }).days[0].queues;
const staleNext = followCal({ "2026-11-25": { people: savedPeople("Ivan"), lineBars: [], rot: ["Ivan"] } });
const staleNextEdited = followCal({ "2026-11-25": { people: savedPeople("Ivan"), lineBars: [], rot: ["Ivan"], touched: ["Ivan"] } });
const staleThisWeek = followCal({ "2026-11-19": { people: savedPeople("Ivan"), lineBars: [], rot: ["Ivan"] } });
const legacyNext = followCal({ "2026-11-25": { people: savedPeople("Ivan"), lineBars: [] } });
check("saved night next week: the sheet's Phase 1 person is on Phase 1 and the old rotation person goes back to their roster queue", queuesOn(staleNext, "2026-11-25").Jawad === "phase1" && queuesOn(staleNext, "2026-11-25").Ivan === "vip");
check("saved night next week: a person edited directly (touched) stays as edited while the sheet's Phase 1 person still follows", queuesOn(staleNextEdited, "2026-11-25").Ivan === "phase1" && queuesOn(staleNextEdited, "2026-11-25").Jawad === "phase1");
check("saved night this week is left exactly as saved", queuesOn(staleThisWeek, "2026-11-19").Ivan === "phase1" && queuesOn(staleThisWeek, "2026-11-19").Jawad === "vip");
check("a night saved before the rotation was recorded: whoever sits on Phase 1 against their roster queue is taken to be the old rotation", queuesOn(legacyNext, "2026-11-25").Ivan === "vip" && queuesOn(legacyNext, "2026-11-25").Jawad === "phase1");
// the original shifts at the top of the VIP Coverage Plan tab go into the roster, as the page does (Ivan's 11pm break on the sheet, 12am in the stale roster)
const vipRowsLive = { vipRows: [[], ["", "", "", "Ammana", "Ivan"], ["", "", "", "7PM - 4AM", "7PM - 4AM"], ["", "", "", "7PM - 4AM", "7PM - 4AM"], ["", "", "", "11 - 12", "11 - 12"]] };
const staleIvan = JSON.parse(JSON.stringify(coverCal)); staleIvan.people.find(p => p.name === "Ivan").brk = 16;
const ivanOn = (live) => makeEngine(staleIvan, live, Date.parse("2026-11-16T10:00:00Z")).resolveDay("2026-11-24").people.find(p => p.name === "Ivan");
check("VIP Coverage Plan tab originals reach the roster: Ivan's break is the sheet's 11pm, not the stale 12am", ivanOn(vipRowsLive).brk === 16 && ivanOn(null).brk === 18);
// a night keeps only what was edited: the rest follows the sheet, and removing a late cover puts the person back (no stale late hours)
const editedCal = (cover) => Object.assign({}, JSON.parse(JSON.stringify(coverCal)), { lateCover: cover, days: { "2026-11-25": { v: 2, ovr: { Zarminay: { brk: 22 } } } } });
const zOn = cal => makeEngine(cal, null, Date.parse("2026-11-16T10:00:00Z")).resolveDay("2026-11-25").people.find(p => p.name === "Zarminay");
const zCovered = zOn(editedCal({ "2026-11-25": { vip: "Zarminay" } })), zFree = zOn(editedCal({}));
check("an edited night: the edited break stays, and with the late cover removed the person is back on their own hours", zCovered.start === 15 && zCovered.brk === 22 && zFree.start === 6 && zFree.brk === 22);
check("a night with nothing edited on it is the night as the sheet gives it", JSON.stringify(makeEngine(Object.assign({}, coverCal, { days: { "2026-11-25": { v: 2, ovr: {} } } }), null, Date.parse("2026-11-16T10:00:00Z")).resolveDay("2026-11-25").people) === JSON.stringify(makeEngine(coverCal, null, Date.parse("2026-11-16T10:00:00Z")).resolveDay("2026-11-25").people));
// nobody on the Support Line for a stretch is a need for a lead
const lineCal = { people: [CP("Solo", { roles: { vip: true, line: true } })], vipPlan: { blocks: [], readAt: "x" }, leaves: [], holidays: [], lateCover: {}, days: {}, changes: {}, lineBars: [{ owner: "Solo", start: 6, len: 8 }], sheetPlan: { hours: {}, line: [], readAt: "x" } };
const lineDay = intercomPlan({ updatedAt: "x", calendar: lineCal }, "2026-11-17", 1, Date.parse("2026-11-16T10:00:00Z"), { live: null, emails: [] }).days[0];
check("Support Line: a stretch with nobody on the line is a need, worded for leads (the person's own break, and the hours nobody is scheduled)", lineDay.needsCover.some(n => n.kind === "line" && /^Support Line has nobody .+–.+\. Adjust breaks or add cover\.$/.test(n.text)));
check("late-shift cover by someone who works an anchor shift: the anchor they leave is covered by the lead's pick, named with its times", texts("2026-11-23").includes("Zarminay is covering Osaid on the 5pm–2am VIP shift.") && !cv("2026-11-23").needsCover.some(n => /Osaid/.test(n.text)) && texts("2026-11-23").includes("Osaid is covering the VIP late shift 10:30pm–7:30am."));
check("...and until a lead picks someone it is an open need, worded like the calendar's alert", cv("2026-11-25").needsCover.some(n => n.kind === "anchor" && n.text === "Anchor shift 5pm–2am VIP is uncovered. Osaid is covering the late shift."));
check("a late-shift cover who does not work an anchor shift leaves nothing open (Ivan on 17 Nov)", !cv("2026-11-17").needsCover.some(n => /covering the late shift/.test(n.text)));
check("Saturday: only the weekend names can be away, no covers; Sunday: nothing", cv("2026-11-21").covers.length === 0 && cv("2026-11-21").needsCover.length === 0 && cv("2026-11-22").covers.length === 0 && cv("2026-11-22").away.length === 0);
check("every cover has text and times where the page has a time", cvPlan.days.every(d => d.covers.every(c => typeof c.text === "string" && c.text.endsWith(".") && (c.from ? !!c.fromAt && !!c.toAt : true))));
const satLeave = JSON.parse(JSON.stringify(coverCal));
satLeave.leaves.push({ id: "l9", name: "Raza", start: "2026-11-21", end: "2026-11-21", status: "approved" });
check("Saturday: a weekend cover person on leave shows as away", intercomPlan({ updatedAt: "x", calendar: satLeave }, "2026-11-21", 1, Date.parse("2026-11-16T10:00:00Z"), { live: null, emails: [] }).days[0].away.map(a => a.name).join() === "Raza");
// odd data in the cover logic must never take the queue decisions down with it
const oddCal = JSON.parse(JSON.stringify(coverCal));
oddCal.days["2026-11-19"] = { v: 2, ovr: {}, lines: 5 };
const odd = intercomPlan({ updatedAt: "x", calendar: oddCal }, "2026-11-18", 3, Date.parse("2026-11-16T10:00:00Z"), { live: null, emails: [] });
check("a day the cover logic cannot read says so (coversError) and its queue answer is still there; the other days are unaffected", odd.days[1].coversError && odd.days[1].covers.length === 0 && Array.isArray(odd.days[1].decisions) && odd.days[1].queues && !odd.days[0].coversError && !odd.days[2].coversError);
// clocks change: on the summer schedule (March) the same stored shifts sit one hour earlier
const summer = intercomPlan({ updatedAt: "x", calendar: coverCal }, "2026-11-16", 1, Date.parse("2026-11-16T10:00:00Z"), { live: null, emails: [] }).days[0];
const springCal = JSON.parse(JSON.stringify(coverCal));
springCal.vipPlan.blocks[0].start = "2027-03-15"; springCal.vipPlan.blocks[0].end = "2027-03-26";
const spring = intercomPlan({ updatedAt: "x", calendar: springCal }, "2027-03-16", 1, Date.parse("2027-03-16T10:00:00Z"), { live: null, emails: [] }).days[0];
check("daylight time moves the covers' clocks with the page (summer: 5pm-2am anchor, standard: 6pm-3am)", summer.covers.find(c => c.kind === "anchor").from === "6pm" && spring.covers.find(c => c.kind === "anchor").from === "5pm");
// the Phase 1 / Support Line tab read live: its current shift differs from the original, so the person shows as covering
sheetMock = url => {
  const row = cells => ({ c: cells.map(v => ({ v })) });
  const body = url.includes("gid=274979110")
    ? { status: "ok", table: { rows: [row(["", "", "", "Raza", "Ivan"]), row(["", "", "", "6PM - 3AM", "7PM - 4AM"]), row(["", "", "", "6PM - 3AM", "9PM - 6AM"]), row(["", "", "", "10 - 11", "1 - 2"])] } }
    : url.includes("gid=") ? { status: "error" } : null;
  return body ? new Response("/*O_o*/" + String.fromCharCode(10) + "google.visualization.Query.setResponse(" + JSON.stringify(body) + ");") : new Response("no", { status: 404 });
};
env.API_KEYS = "intercom:key-for-intercom-123";
const liveTab = await (await keyed("/api/v1/intercom-plan?from=2026-11-19&days=1", "key-for-intercom-123")).json();
check("the Phase 1 / Support Line tab is read live: a current shift that differs from the original shows as covering", liveTab.days[0].covers.some(c => c.kind === "hours" && c.name === "Ivan" && c.text === "Ivan is working 9pm–6am instead of their usual 7pm–4am." && c.from === "9pm"));
sheetMock = () => new Response("forbidden", { status: 403 });
// the anchor cover a lead picks for a late-shift cover person is logged with its people and date
const logsBefore = (await (await get("/api/log", who.session)).json()).log.length;
const anchorPlan = JSON.parse(JSON.stringify(apiCal));
anchorPlan.lateCover = { "2026-11-23": { vip: "Raza", anchor: { Raza: "Ammana" } } };
await putPlan(who.session, { version: 1, updatedAt: "2026-11-14T11:00:00.000Z", parts: 1, calendar: anchorPlan });
anchorPlan.lateCover["2026-11-23"].anchor.Raza = "Ivan";
await putPlan(who.session, { version: 1, updatedAt: "2026-11-14T11:01:00.000Z", parts: 1, calendar: anchorPlan });
delete anchorPlan.lateCover["2026-11-23"].anchor;
await putPlan(who.session, { version: 1, updatedAt: "2026-11-14T11:02:00.000Z", parts: 1, calendar: anchorPlan });
const anchorLog = (await (await get("/api/log", who.session)).json()).log.map(e => e.detail || "").join(" | ");
check("an anchor shift cover for a late-shift cover person is logged when added, changed and removed", /Added anchor shift cover Ammana for Raza on Mon 23 Nov/.test(anchorLog) && /Changed anchor shift cover for Raza on Mon 23 Nov from Ammana to Ivan/.test(anchorLog) && /Removed anchor shift cover Ivan for Raza on Mon 23 Nov/.test(anchorLog) && logsBefore > 0);

// 8. dates in words
const T = "2026-11-18"; // a Wednesday
const dr = text => { try { return resolveDates(text, T); } catch (e) { return e instanceof DateError ? { error: e.message } : { crash: e.stack }; } };
const keys = (a, b) => { const out = []; for (let k = a; k <= b; k = new Date(Date.parse(k) + 86400000).toISOString().slice(0, 10)) out.push(k); return out; };
check("dates: today, tomorrow, a plain day and the same day written four ways", dr("today").dates.join() === "2026-11-18" && dr("tomorrow").dates.join() === "2026-11-19" && ["20th Nov", "Nov 20", "20 November 2026", "2026-11-20", "20/11", "20.11.2026", "11/20"].every(t => dr(t).dates.join() === "2026-11-20"));
check("dates: 20th Nov to 25th Nov (and the other ways to write a range)", ["20th Nov to 25th Nov", "from 20th Nov to 25th Nov", "20 nov - 25 nov", "between 20 Nov and 25 Nov", "20th to 25th Nov", "20-25 Nov", "2026-11-20 to 2026-11-25"].every(t => dr(t).dates.join() === keys("2026-11-20", "2026-11-25").join()));
check("dates: coming Monday to Thursday, and a bare weekday range", dr("from coming Monday to Thursday").dates.join() === keys("2026-11-23", "2026-11-26").join() && dr("mon to thu").dates.join() === keys("2026-11-23", "2026-11-26").join() && dr("coming monday").dates.join() === "2026-11-23" && dr("this friday").dates.join() === "2026-11-20");
check("dates: this week (today to Friday), next week, this week and next, rest of the week", dr("this week").dates.join() === keys("2026-11-18", "2026-11-20").join() && dr("next week").dates.join() === keys("2026-11-23", "2026-11-27").join() && dr("this week and next").dates.length === 8 && dr("rest of the week").dates.join() === dr("this week").dates.join());
check("dates: lists, 'till Friday', 'the 20th', counts of days", dr("today and tomorrow").dates.join() === "2026-11-18,2026-11-19" && dr("mon, tue and thu").dates.join() === "2026-11-19,2026-11-23,2026-11-24" && dr("till friday").dates.join() === keys("2026-11-18", "2026-11-20").join() && dr("the 20th").dates.join() === "2026-11-20" && dr("next 3 days").dates.join() === keys("2026-11-18", "2026-11-20").join());
check("dates: a day and month with no year after the year end, an ambiguous number says how it was read", dr("Jan 5").dates.join() === "2027-01-05" && dr("12/11").warnings.length === 1 && dr("12/11").dates.join() === "2026-11-12" && dr("13/11").warnings.length === 0);
check("dates: what cannot be read is an error that says what, and an end before the start is refused", /could not read "bogus"/.test(dr("bogus").error) && /before the start/.test(dr("25th Nov to 20th Nov").error) && /no dates/.test(dr("").error) && dr({ from: "2026-11-20", to: "2026-11-22" }).dates.length === 3 && dr({ dates: ["2026-11-20", "2026-11-19"] }).dates.join() === "2026-11-19,2026-11-20");

// 9. commands (pure): off, back, takeover, move, swap, cover, undo
const CMD = (name, extra) => Object.assign({ name, roles: { vip: true }, start: 6, len: 18, brk: 14, split: null, queue: "vip", group: "VIP" }, extra || {});
const cmdCal = {
  people: [CMD("Raza", { start: 4, brk: 12 }), CMD("Ivan"), CMD("Ammana"), CMD("Zarminay"), CMD("Jawad", { start: 8, brk: 16 }), CMD("Osaid", { start: 2, brk: 10, roles: { lead: true, vip: true } }), CMD("Ayeshah", { roles: { phase1: true }, queue: "phase1", group: "Phase 1" })],
  vipPlan: { blocks: [{ start: "2026-11-16", end: "2026-11-27", late: "Ammana", phase1: "Jawad", cover1: "", cover2: "" }], readAt: "x" },
  leaves: [], holidays: [], lateCover: {}, days: {}, changes: {}, lineBars: [], sheetPlan: { hours: {}, line: [] }
};
const cmdDoc = { updatedAt: "2026-11-18T00:00:00.000Z", calendar: cmdCal };
const NOW = Date.parse("2026-11-18T05:00:00Z");
const cmd = (ops, doc) => planCommand(doc || cmdDoc, { commandId: "cmd-test-1", actor: { email: "ann@example.com" }, ops }, null, NOW);
const off = cmd([{ op: "off", people: ["jawad"], dates: "this week and next" }]);
check("command: someone off this week and next becomes approved leave, Sundays skipped, summary in words", off.ok && off.cal.leaves.length === 2 && off.cal.leaves.every(l => l.status === "approved" && l.name === "Jawad") && off.result.summary[0] === "Jawad is off Wed 18 Nov to Fri 20 Nov, Mon 23 Nov to Fri 27 Nov (approved leave).");
const offDay = intercomPlan({ updatedAt: "x", calendar: off.cal }, "2026-11-18", 1, NOW, { live: null, emails: [] }).days[0];
check("command: ...and the calendar API then says Jawad is off and the Phase 1 need is new", offDay.away.map(a => a.name).join() === "Jawad" && off.result.needsCover.some(n => n.new && /Phase 1 needs cover. Jawad is off/.test(n.text)));
const both = cmd([{ op: "off", people: ["jawad"], dates: "today" }, { op: "takeover", name: "raza", from: "jawad", dates: "today" }]);
const bothDay = intercomPlan({ updatedAt: "x", calendar: both.cal }, "2026-11-18", 1, NOW, { live: null, emails: [] }).days[0];
check("command: 'jawad is off today and raza covers him': Raza works Jawad's 8pm-5am Phase 1 shift, and the 6pm anchor Raza left is an open need that names why", both.ok && bothDay.covers.some(c => c.text === "Raza is covering Jawad on their 8pm–5am Phase 1 shift.") && bothDay.needsCover.some(n => n.text === "Anchor shift 6pm–3am VIP is uncovered. Raza is covering Jawad." ) && bothDay.queues.Raza === "phase1");
import { makeEngine } from "./src/covers.js";
const whole = (cal, name) => { const d = makeEngine(cal, null, NOW).resolveDay("2026-11-18"); return d.people.find(p => p.name === name); };
const rz = whole(both.cal, "Raza");
check("command: someone covering takes the covered person's whole shift, break included (Raza's 12 becomes Jawad's 16)", rz.start === whole(both.cal, "Jawad").start && rz.brk === whole(both.cal, "Jawad").brk && rz.brk !== whole(cmdCal, "Raza").brk);
const ch2 = cmd([{ op: "off", people: ["jawad"], dates: "today" }, { op: "takeover", name: "raza", from: "jawad", shift: "10.30", dates: "today" }, { op: "takeover", name: "zarminay", from: "raza", shift: "6pm", dates: "today" }]);
check("command: a named shift takes the break of whoever normally works it (Zarminay on the 6pm anchor gets Raza's own 6pm break)", whole(ch2.cal, "Zarminay").start === whole(cmdCal, "Raza").start && whole(ch2.cal, "Zarminay").brk === whole(cmdCal, "Raza").brk);
const lateBrk = (today, day) => { const r = planCommand({ updatedAt: "x", calendar: cmdCal }, { commandId: "c", today, actor: { email: "ann@example.com" }, ops: [{ op: "move", name: "Jawad", shift: "late", dates: "today" }, { op: "takeover", name: "Raza", from: "Ivan", dates: "today" }] }, null, Date.parse(today + "T05:00:00Z")); const d = makeEngine(r.cal, null, Date.parse(today + "T05:00:00Z")).resolveDay(day); const j = d.people.find(p => p.name === "Jawad"); return [j.start, j.brk]; };
const lw = lateBrk("2026-11-18", "2026-11-18"), ls = lateBrk("2027-07-14", "2027-07-14");
check("late shift break is always 2am PKT in standard time and 1am in summer (seven half-hours after the 10:30pm / 9:30pm start)", lw[1] - lw[0] === 7 && lw[0] === 15 && ls[1] - ls[0] === 7 && ls[0] === 13);
const mv = cmd([{ op: "move", name: "Jawad", queue: "phase1", shift: "10.30", dates: "from 20th Nov to 25th Nov" }]);
check("command: 'move Jawad to Phase 1 and the 10.30 shift from 20th Nov to 25th Nov': only the days named, Saturday and Sunday skipped with the reason", mv.ok && Object.keys(mv.cal.changes).join() === "2026-11-20,2026-11-23,2026-11-24,2026-11-25" && mv.result.skipped.length === 2 && /Saturdays follow the Weekend Cover/.test(mv.result.skipped[0]) && mv.result.summary[0] === "Jawad moved to Phase 1 and to the late shift 10:30pm–7:30am Fri 20 Nov, Mon 23 Nov to Wed 25 Nov.");
const mvPlan = intercomPlan({ updatedAt: "x", calendar: mv.cal }, "2026-11-19", 3, NOW, { live: null, emails: [] });
check("command: the move shows on its days only (19th untouched, 20th moved)", !mvPlan.days[0].covers.some(c => /10:30pm/.test(c.text) && c.name === "Jawad") && mvPlan.days[1].covers.some(c => c.name === "Jawad" && c.text === "Jawad is working 10:30pm–7:30am instead of their usual 8pm–5am."));
const sw = cmd([{ op: "swap", a: "jawad", b: "raza", dates: "coming Monday to Thursday" }]);
const swDay = intercomPlan({ updatedAt: "x", calendar: sw.cal }, "2026-11-23", 1, NOW, { live: null, emails: [] }).days[0];
check("command: a swap exchanges shifts and queues on the nights named", sw.ok && swDay.queues.Jawad === "vip" && swDay.queues.Raza === "phase1" && swDay.covers.some(c => c.name === "Jawad" && /swapped with Raza/.test(c.text)) && sw.result.summary[0] === "Jawad and Raza swap shifts Mon 23 Nov to Thu 26 Nov.");
const chain = cmd([{ op: "off", people: ["jawad"], dates: "today" }, { op: "takeover", name: "raza", from: "jawad", shift: "10.30", dates: "today" }, { op: "takeover", name: "zarminay", from: "raza", shift: "6pm", dates: "today" }]);
const chainDay = chain.ok && intercomPlan({ updatedAt: "x", calendar: chain.cal }, "2026-11-18", 1, NOW, { live: null, emails: [] }).days[0];
check("command: 'Jawad is off, Raza covers him at 10.30, and because Raza is an anchor Zarminay covers Raza at 6pm': each cover is stated as the calendar words it, with nothing left open for Raza's anchor", chain.ok && chainDay.covers.filter(c => c.kind === "takeover").map(c => c.text).sort().join(" | ") === "Raza is covering Jawad on their 10:30pm–7:30am Phase 1 shift. | Zarminay is covering Raza on their 6pm–3am VIP shift." && !chainDay.needsCover.some(n => /6pm–3am/.test(n.text)) && chainDay.covers.filter(c => /Zarminay is covering Raza/.test(c.text)).length === 1 && chainDay.queues.Zarminay === "vip" && chainDay.queues.Raza === "phase1");
check("command: without the 6pm Zarminay leaves nothing for Raza's anchor, so it is an open need until somebody takes it", (() => { const only = cmd([{ op: "off", people: ["jawad"], dates: "today" }, { op: "takeover", name: "raza", from: "jawad", shift: "10.30", dates: "today" }]); const d = intercomPlan({ updatedAt: "x", calendar: only.cal }, "2026-11-18", 1, NOW, { live: null, emails: [] }).days[0]; return d.needsCover.some(n => n.text === "Anchor shift 6pm–3am VIP is uncovered. Raza is covering Jawad."); })());
// the golden phrases handed to the Slack side: every one is accepted (or refused for the stated reason) by the real command logic
import { readFileSync } from "node:fs";
const golden = JSON.parse(readFileSync(new URL("../handoff/slack-calendar/golden.json", import.meta.url), "utf8"));
const goldenBad = golden.filter(g => {
  const r = cmd(g.ops);
  return g.ok ? !(r.ok && r.result.summary.length) : r.ok;
});
check("golden phrases for the Slack side (" + golden.length + "): each is accepted, or refused for its stated reason", goldenBad.length === 0 && golden.length >= 25);
if (goldenBad.length) console.log(goldenBad.map(g => "  golden: " + g.say + " => " + JSON.stringify(cmd(g.ops).errors || cmd(g.ops).result.summary)).join(String.fromCharCode(10)));
// the late shift is a word, not a clock: 10:30pm in standard time, 9:30pm on the summer clock, whichever way it is written
const lateWords = ["late", "late shift", "the late shift", "Late-shift", "10.30", "10:30 shift", "the 10:30 shift", "10:30pm", "22:30", "1030", "9.30", "the 9.30 shift", "930"];
const lateOn = (shift, today) => { const r = planCommand({ updatedAt: "x", calendar: cmdCal }, { commandId: "c", today, actor: { email: "ann@example.com" }, ops: [{ op: "move", name: "Jawad", shift, dates: "today" }] }, null, Date.parse(today + "T05:00:00Z")); return r.ok && r.result.summary[0]; };
check("command: any way of saying the late shift means 10:30pm in standard time and 9:30pm in summer time", lateWords.every(w => /the late shift 10:30pm–7:30am/.test(lateOn(w, "2026-11-18")) && /the late shift 9:30pm–6:30am/.test(lateOn(w, "2027-07-14"))));
const otherWords = [["the 6pm shift", "6pm–3am"], ["the 6 pm anchor shift", "6pm–3am"], ["from 7pm to 4am", "7pm–4am"], ["8pm", "8pm–5am"], ["6pm - 3am", "6pm–3am"]];
check("command: anchors and hours accept the usual wordings, and a queue accepts the usual names", otherWords.every(([w, label]) => (lateOn(w, "2026-11-18") || "").includes(label)) && ["Phase 1", "phase one", "p1", "Phase 1 team", "the Phase 1 queue", "VIP", "VIP team", "vip handling", "both"].every(q => cmd([{ op: "move", name: "Ivan", queue: q, dates: "today" }]).ok));
check("command: a night the Weekend Cover sheet rules (Saturday) cannot be moved or swapped, only marked off", !cmd([{ op: "swap", a: "jawad", b: "raza", dates: "2026-11-21" }]).ok && cmd([{ op: "off", people: ["ivan"], dates: "2026-11-21" }]).ok);
check("command: past days, closed Sundays, unknown names and clashes are refused with a reason", /already past/.test(cmd([{ op: "off", people: ["ivan"], dates: "yesterday" }]).errors[0]) && /Sunday is closed/.test(cmd([{ op: "off", people: ["ivan"], dates: "2026-11-22" }]).errors[0]) && /don't know anyone called "bob"/.test(cmd([{ op: "off", people: ["bob"], dates: "today" }]).errors[0]) && /already has a cover or move/.test(cmd([{ op: "takeover", name: "raza", from: "jawad", dates: "today" }, { op: "swap", a: "raza", b: "ivan", dates: "today" }]).errors.join()));
check("command: leads are never used as cover, a person who is off cannot cover", /lead/.test(cmd([{ op: "takeover", name: "osaid", from: "jawad", dates: "today" }]).errors[0]) && /off on Wed 18 Nov, so cannot cover/.test(cmd([{ op: "off", people: ["raza"], dates: "today" }, { op: "takeover", name: "raza", from: "jawad", dates: "today" }]).errors.join()));
const lc = cmd([{ op: "cover", kind: "late", name: "ivan", dates: "today" }, { op: "cover", kind: "p1q", name: "zarminay", dates: "today" }]);
check("command: the calendar's own cover slots (late shift, Phase 1 from VIP)", lc.ok && lc.cal.lateCover["2026-11-18"].vip === "Ivan" && lc.cal.lateCover["2026-11-18"].p1q === "Zarminay");
const ac = cmd([{ op: "cover", kind: "late", name: "osaid", dates: "today" }]);
check("command: an anchor cover needs an open anchor that the calendar (not the sheet) owns", !cmd([{ op: "cover", kind: "anchor", name: "ivan", for: "jawad", dates: "today" }]).ok && /filled in on the sheet/.test(cmd([{ op: "cover", kind: "anchor", name: "ivan", for: "jawad", dates: "today" }]).errors[0]));
const back = planCommand({ updatedAt: "x", calendar: off.cal }, { commandId: "cmd-test-2", actor: { email: "ann@example.com" }, ops: [{ op: "back", people: ["jawad"], dates: "2026-11-24 to 2026-11-25" }] }, null, NOW);
check("command: back early splits the leave: the days before and after stay, the days named are cancelled", back.ok && back.cal.leaves.filter(l => l.status === "approved").map(l => l.start + ">" + l.end).sort().join() === "2026-11-18>2026-11-20,2026-11-23>2026-11-23,2026-11-26>2026-11-27" && back.cal.leaves.some(l => l.status === "cancelled" && l.start === "2026-11-24" && l.end === "2026-11-25"));
const undone = undoCommand({ updatedAt: "x", calendar: back.cal }, { undo: back.undo, summary: back.result.summary }, NOW);
check("command: undo puts the leave back exactly", JSON.stringify(undone.cal.leaves.filter(l => l.name === "Jawad").map(l => [l.start, l.end, l.status]).sort()) === JSON.stringify(off.cal.leaves.map(l => [l.start, l.end, l.status]).sort()));
const undoMv = undoCommand({ updatedAt: "x", calendar: mv.cal }, { undo: mv.undo, summary: mv.result.summary }, NOW);
check("command: undo removes the changes it made and nothing else", Object.keys(undoMv.cal.changes).length === 0 && JSON.stringify(undoMv.cal.people) === JSON.stringify(cmdCal.people));

// 10. the write API: keys, who may ask, preview, apply, repeat, undo, log
env.WRITE_KEYS = "slack:write-key-for-slack-123";
env.TEST_TODAY = "1";
const wpost = (path, key, body) => worker.fetch(new Request(ORIGIN + path, { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, key ? { Authorization: "Bearer " + key } : {}), body: JSON.stringify(body) }), env);
const WK = "write-key-for-slack-123";
const admin = { email: "ann@example.com" };
const base = { actor: admin, today: "2026-11-18", ops: [{ op: "off", people: ["ammana"], dates: "20th Nov to 24th Nov" }] };
env.API_KEYS = "intercom:key-for-intercom-123";
check("write API: no key, a wrong key, and a READ key are all refused", (await wpost("/api/v1/calendar/command", null, base)).status === 401 && (await wpost("/api/v1/calendar/command", "nope", base)).status === 401 && (await wpost("/api/v1/calendar/command", "key-for-intercom-123", base)).status === 401);
check("write API: a write key cannot be used to read", (await keyed("/api/v1/intercom-plan", WK)).status === 401);
check("write API: only Admins may ask (a Member, an unknown person and a missing person are refused)", (await wpost("/api/v1/calendar/command", WK, Object.assign({}, base, { actor: { email: "bob@example.com" } }))).status === 403 && (await wpost("/api/v1/calendar/command", WK, Object.assign({}, base, { actor: { email: "stranger@example.com" } }))).status === 403 && (await wpost("/api/v1/calendar/command", WK, Object.assign({}, base, { actor: {} }))).status === 400);
const planBefore = await (await get("/api/team/plan", who.session)).text();
const prev = await wpost("/api/v1/calendar/command", WK, base);
const prevBody = await prev.json();
check("write API: with no dryRun it is a preview: it says exactly what would change and writes nothing", prev.status === 200 && prevBody.dryRun === true && prevBody.summary[0] === "Ammana is off Fri 20 Nov to Tue 24 Nov (approved leave)." && prevBody.previewHash && (await (await get("/api/team/plan", who.session)).text()) === planBefore);
check("write API: applying needs a command id", (await wpost("/api/v1/calendar/command", WK, Object.assign({}, base, { dryRun: false }))).status === 400);
check("write API: an apply whose preview no longer matches is refused and changes nothing", (await wpost("/api/v1/calendar/command", WK, Object.assign({}, base, { dryRun: false, commandId: "cmd-apply-0001", previewHash: "stale" }))).status === 409 && (await (await get("/api/team/plan", who.session)).text()) === planBefore);
const applied = await wpost("/api/v1/calendar/command", WK, Object.assign({}, base, { dryRun: false, commandId: "cmd-apply-0002", previewHash: prevBody.previewHash }));
const appliedBody = await applied.json();
const planAfter = JSON.parse(await (await get("/api/team/plan", who.session)).text());
check("write API: applying makes exactly the previewed change, in the shared plan, with a newer version", applied.status === 200 && appliedBody.ok && appliedBody.commandId === "cmd-apply-0002" && planAfter.calendar.leaves.some(l => l.name === "Ammana" && l.start === "2026-11-20" && l.end === "2026-11-24" && l.status === "approved") && planAfter.updatedAt > JSON.parse(planBefore).updatedAt);
const replayed = await wpost("/api/v1/calendar/command", WK, Object.assign({}, base, { dryRun: false, commandId: "cmd-apply-0002" }));
check("write API: the same command id again is a replay and does not add the leave twice", (await replayed.json()).replayed === true && JSON.parse(await (await get("/api/team/plan", who.session)).text()).calendar.leaves.filter(l => l.name === "Ammana" && l.start === "2026-11-20").length === 1);
const cmdLog = (await (await get("/api/log", who.session)).json()).log;
check("write API: the activity log says who asked, via Slack, with the summary and the change lines", cmdLog.some(e => e.event === "calendar command" && e.via === "Slack" && e.email === "ann@example.com" && e.name === "Ann" && /Ammana is off Fri 20 Nov to Tue 24 Nov/.test(e.detail)) && cmdLog.some(e => e.event === "plan edit" && e.via === "Slack" && /Added approved leave for Ammana/.test(e.detail)));
check("write API: the calendar API now reports the leave (Ammana off on the 20th)", (await (await keyed("/api/v1/intercom-plan?from=2026-11-20&days=1", "key-for-intercom-123")).json()).days[0].away.some(a => a.name === "Ammana"));
const bad = await wpost("/api/v1/calendar/command", WK, Object.assign({}, base, { ops: [{ op: "off", people: ["nobody"], dates: "today" }] }));
check("write API: a command that cannot be done is a 422 with the reasons and writes nothing", bad.status === 422 && /don't know anyone/.test((await bad.json()).errors[0]));
const undo = await wpost("/api/v1/calendar/undo", WK, { actor: admin, commandId: "cmd-apply-0002" });
check("write API: undo takes the command back, once", undo.status === 200 && !JSON.parse(await (await get("/api/team/plan", who.session)).text()).calendar.leaves.some(l => l.name === "Ammana" && l.start === "2026-11-20") && (await wpost("/api/v1/calendar/undo", WK, { actor: admin, commandId: "cmd-apply-0002" })).status === 409 && (await wpost("/api/v1/calendar/undo", WK, { actor: admin, commandId: "cmd-unknown-9" })).status === 404);
// a conditional write is refused when the plan has moved on (this is how two writers never overwrite each other)
const stub = env.PLAN.get(env.PLAN.idFromName("plan"));
const cur = JSON.parse(await (await stub.fetch("https://plan.internal/doc", { method: "GET" })).text());
check("write API: a write made from an old version is refused (409), one made from the current version is accepted", (await stub.fetch("https://plan.internal/doc", { method: "POST", body: JSON.stringify(cur), headers: { "X-Expect-Updated-At": "old" } })).status === 409 && (await stub.fetch("https://plan.internal/doc", { method: "POST", body: JSON.stringify(cur), headers: { "X-Expect-Updated-At": cur.updatedAt } })).status === 200);
delete env.WRITE_KEYS; delete env.TEST_TODAY;
delete env.API_KEYS;
check("with no keys configured every call is refused", (await keyed("/api/v1/intercom-plan", "key-for-intercom-123")).status === 401);

console.log(failed ? failed + " failed" : "all passed");
process.exit(failed ? 1 : 0);
