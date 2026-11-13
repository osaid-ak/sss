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

// 6. removing someone locks them out at once
const saved = env.ALLOWED_EMAILS;
env.ALLOWED_EMAILS = "ann@example.com";
check("removed email loses access with an existing session", (await get("/api/team/plan", bob.session)).status === 401);
env.ALLOWED_EMAILS = saved;

console.log(failed ? failed + " failed" : "all passed");
process.exit(failed ? 1 : 0);
