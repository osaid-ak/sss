// Offline checks for the sign-in gate and roles. Run: node test.mjs
import worker, { PlanStore } from "./src/index.js";

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
let googleEmail = "ann@example.com";
let googleVerified = true;
globalThis.fetch = async (url, init) => {
  url = String(url);
  if (url === "https://oauth2.googleapis.com/token") {
    const b = new URLSearchParams(String(init.body));
    return b.get("code") === "good" && b.get("client_secret") === "gsecret" && b.get("redirect_uri") === ORIGIN + "/auth/callback"
      ? Response.json({ access_token: "tok" }) : new Response("no", { status: 400 });
  }
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
    rp("Ayeshah", { roles: { phase1: true }, queue: "phase1", group: "Phase 1" })
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
check("Saturday: no rotation, weekend cover Phase 1 person is a decision, VIP names are normal", sat.kind === "saturday" && sat.rotationPhase1 === null && sat.decisions.length === 1 && sat.decisions[0].name === "Ivan" && sat.decisions[0].queue === "phase1" && sat.decisions[0].reason === "weekend cover");
check("Sunday is closed: nothing decided", dayOf("2026-11-22").kind === "sunday" && dayOf("2026-11-22").decisions.length === 0);
check("the lead flag is carried on a decision", (await (await keyed("/api/v1/intercom-plan?from=2026-11-21", "key-for-intercom-123")).json()).days[0].decisions.every(d => d.lead === false));
check("the key never appears in an answer", !JSON.stringify(apiBody).includes("key-for"));
const apiLog = (await (await get("/api/log", boss.session)).json()).log.filter(e => e.event === "api refused");
check("refused API calls are logged once, without the key", apiLog.length === 1 && !JSON.stringify(apiLog).includes("nope"));
delete env.API_KEYS;
check("with no keys configured every call is refused", (await keyed("/api/v1/intercom-plan", "key-for-intercom-123")).status === 401);

console.log(failed ? failed + " failed" : "all passed");
process.exit(failed ? 1 : 0);
