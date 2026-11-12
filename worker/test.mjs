// Offline checks for the sign-in gate. Run: node test.mjs
import worker from "./src/index.js";

const env = {
  INTERCOM_CLIENT_ID: "cid",
  INTERCOM_CLIENT_SECRET: "csecret",
  SESSION_SECRET: "test-session-secret-123456",
  ALLOWED_EMAILS: "Ann@Example.com, bob@example.com",
  PLAN_BASE: "https://store.test/v2/abc",
  ASSETS: { fetch: async () => new Response("<html>CALENDAR</html>", { headers: { "Content-Type": "text/html" } }) }
};
const ORIGIN = "https://plan.test";
let failed = 0;
function check(name, cond) { console.log((cond ? "ok   " : "FAIL ") + name); if (!cond) failed++; }
const get = (path, cookie) => worker.fetch(new Request(ORIGIN + path, { headers: cookie ? { Cookie: cookie } : {} }), env);
function cookieOf(res, name) {
  const all = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const hit = all.find(c => c.startsWith(name + "="));
  return hit ? hit.split(";")[0] : null;
}

// mock Intercom + plan store
let meEmail = "ann@example.com";
const calls = [];
globalThis.fetch = async (url, init) => {
  url = String(url);
  calls.push({ url, init });
  if (url === "https://api.intercom.io/auth/eagle/token") {
    const b = JSON.parse(init.body);
    return b.code === "good" ? Response.json({ token: "tok" }) : new Response("no", { status: 400 });
  }
  if (url === "https://api.intercom.io/me") return Response.json({ email: meEmail, name: "X" });
  if (url.startsWith("https://store.test/")) return Response.json({ upstream: url, method: init.method, body: init.body || null });
  return new Response("unexpected " + url, { status: 500 });
};

// 1. signed out
let r = await get("/");
let t = await r.text();
check("signed-out page shows sign-in, not the calendar", r.status === 200 && t.includes("Sign in with Intercom") && !t.includes("CALENDAR"));
r = await get("/api/team/plan");
check("signed-out plan request is 401", r.status === 401);
r = await get("/api/team/plan", "sss_session=forged.value");
check("forged cookie is rejected", r.status === 401);

// 2. login redirect
r = await get("/auth/login");
const loc = new URL(r.headers.get("Location"));
const state = cookieOf(r, "sss_state");
check("login redirects to Intercom with client id and callback", loc.origin + loc.pathname === "https://app.intercom.com/oauth" && loc.searchParams.get("client_id") === "cid" && loc.searchParams.get("redirect_uri") === ORIGIN + "/auth/callback" && state);

// 3. callback checks
r = await get("/auth/callback?code=good&state=" + loc.searchParams.get("state"));
check("callback without the state cookie fails", r.status === 400);
r = await get("/auth/callback?code=good&state=wrong", state);
check("callback with a mismatched state fails", r.status === 400);
r = await get("/auth/callback?code=bad&state=" + loc.searchParams.get("state"), state);
check("callback with a rejected code fails", r.status === 400);

// 4. allowed user
r = await get("/auth/callback?code=good&state=" + loc.searchParams.get("state"), state);
const session = cookieOf(r, "sss_session");
check("allowed email gets a session and goes to /", r.status === 302 && r.headers.get("Location") === "/" && session);
r = await get("/", session);
t = await r.text();
check("signed-in user gets the calendar", t.includes("CALENDAR"));
r = await get("/api/team/plan/part/2", session);
let j = await r.json();
check("plan GET is proxied to the store", j.upstream === "https://store.test/v2/abc/plan/part/2" && j.method === "GET");
r = await worker.fetch(new Request(ORIGIN + "/api/team/plan", { method: "POST", headers: { Cookie: session, "Content-Type": "application/json" }, body: '{"a":1}' }), env);
j = await r.json();
check("plan POST is proxied with its body", j.method === "POST" && j.body === '{"a":1}');
r = await get("/api/team/../secret", session);
check("path tricks are refused", r.status === 404);
check("the Intercom token is not stored in the cookie", !decodeURIComponent(session).includes("tok"));

// 5. not on the list
meEmail = "eve@example.com";
r = await get("/auth/callback?code=good&state=" + loc.searchParams.get("state"), state);
check("email not on the list is denied", r.status === 403 && !cookieOf(r, "sss_session"));

// 6. removing someone locks them out at once
const saved = env.ALLOWED_EMAILS;
env.ALLOWED_EMAILS = "bob@example.com";
r = await get("/api/team/plan", session);
check("removed email loses access with an existing session", r.status === 401);
env.ALLOWED_EMAILS = saved;

// 7. expired session
const body = Buffer.from(JSON.stringify({ e: "ann@example.com", x: Date.now() - 1000 })).toString("base64url");
check("an expired signature-less token is rejected", (await get("/api/team/plan", "sss_session=" + body + ".x")).status === 401);

console.log(failed ? failed + " failed" : "all passed");
process.exit(failed ? 1 : 0);
