// Offline checks for the sign-in gate and roles. Run: node test.mjs
import worker from "./src/index.js";

const kvStore = new Map();
const env = {
  GOOGLE_CLIENT_ID: "gid",
  GOOGLE_CLIENT_SECRET: "gsecret",
  SESSION_SECRET: "test-session-secret-123456",
  ALLOWED_EMAILS: "Ann@Example.com, bob@example.com, cat@example.com, dan@example.com",
  ADMIN_EMAILS: "ann@example.com, dan@example.com",
  SUPER_ADMIN: "boss@example.com",
  PLAN_BASE: "https://store.test/v2/abc",
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
  if (url.startsWith("https://store.test/")) return Response.json({ upstream: url, method: init.method, body: init.body || null });
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
check("plan GET is proxied", (await (await get("/api/team/plan/part/2", bob.session)).json()).upstream === "https://store.test/v2/abc/plan/part/2");
check("path tricks are refused", (await get("/api/team/../secret", bob.session)).status === 404);

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

// 6. removing someone locks them out at once
const saved = env.ALLOWED_EMAILS;
env.ALLOWED_EMAILS = "ann@example.com";
check("removed email loses access with an existing session", (await get("/api/team/plan", bob.session)).status === 401);
env.ALLOWED_EMAILS = saved;

console.log(failed ? failed + " failed" : "all passed");
process.exit(failed ? 1 : 0);
