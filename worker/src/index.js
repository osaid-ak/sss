// Shift Plan gate: Google sign-in in front of the calendar and the shared plan, with Member / Admin roles.
//
// Routes
//   /auth/login     start "Sign in with Google" (OAuth, email only)
//   /auth/callback  Google sends the person back here; we check their email against ALLOWED_EMAILS
//   /auth/logout    clear the session
//   /api/me         who am I and my role
//   /api/users      Admins: list people (GET) / add, remove, change a role (POST)
//   /api/log        Admins: recent sign-ins, sign-outs and user changes
//   /api/team/plan the shared team plan, kept in a Durable Object (signed-in people only)
//   everything else the calendar page (static asset, signed-in people only)
//
// Secrets (set with `wrangler secret put`, never committed):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_SECRET
//   ALLOWED_EMAILS  comma-separated: everyone who may sign in
//   ADMIN_EMAILS    comma-separated: who starts as an Admin (everyone else starts as a Member)
//   SUPER_ADMIN     one email: always allowed, always the Super Admin, can change Admins' roles
// Role changes, added people and removed people made in the app are kept in the ROLES key-value store. Roles win over ADMIN_EMAILS.
// ALLOWED_EMAILS is re-read on every request, so removing an email locks that person out immediately.

const SESSION_COOKIE = "sss_session";
const STATE_COOKIE = "sss_state";
const SESSION_DAYS = 7;
const enc = new TextEncoder();

function b64url(bytes) {
  let s = "";
  new Uint8Array(bytes).forEach(b => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function sign(value, secret) {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(value));
  return value + "." + b64url(sig);
}
async function unsign(token, secret) {
  const i = token.lastIndexOf(".");
  if (i < 1) return null;
  const value = token.slice(0, i);
  let sig;
  try { sig = b64urlDecode(token.slice(i + 1)); } catch (e) { return null; }
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, enc.encode(value));
  return ok ? value : null;
}
function cookies(request) {
  const out = {};
  (request.headers.get("Cookie") || "").split(";").forEach(part => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}
function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function emailList(value) {
  return String(value || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
}
function superEmail(env) { return String(env.SUPER_ADMIN || "").trim().toLowerCase(); }
// People added or removed from the app are kept in the ROLES store, on top of the ALLOWED_EMAILS secret.
async function storedUsers(env) {
  if (!env.ROLES) return { added: [], removed: [] };
  try {
    const u = JSON.parse((await env.ROLES.get("users")) || "{}") || {};
    return { added: Array.isArray(u.added) ? u.added : [], removed: Array.isArray(u.removed) ? u.removed : [] };
  } catch (e) { return { added: [], removed: [] }; }
}
async function accessSet(env, users) {
  const u = users || await storedUsers(env);
  const set = new Set([...emailList(env.ALLOWED_EMAILS), ...u.added.map(x => String(x).toLowerCase())]);
  u.removed.forEach(x => set.delete(String(x).toLowerCase()));
  if (superEmail(env)) set.add(superEmail(env));
  return set;
}
async function isAllowed(env, email) {
  if (!email) return false;
  return (await accessSet(env)).has(String(email).trim().toLowerCase());
}
async function storedRoles(env) {
  if (!env.ROLES) return {};
  try { return JSON.parse((await env.ROLES.get("roles")) || "{}") || {}; } catch (e) { return {}; }
}
// "super", "admin" or "member"
async function roleOf(env, email, stored) {
  const e = String(email).trim().toLowerCase();
  if (e === superEmail(env)) return "super";
  const roles = stored || await storedRoles(env);
  if (roles[e] === "admin") return "admin";
  if (roles[e] === "member") return "member";
  return emailList(env.ADMIN_EMAILS).includes(e) ? "admin" : "member";
}

// Activity log: sign-ins, refused sign-ins, sign-outs and user changes. Newest 500 are kept in the ROLES store.
// Each entry holds the email, the event, the time, the country, the IP address and the browser (User-Agent, shortened).
const LOG_KEEP = 500;
async function logEvent(env, request, event, email, detail) {
  if (!env.ROLES) return;
  try {
    let list = [];
    try { list = JSON.parse((await env.ROLES.get("log")) || "[]") || []; } catch (e) { list = []; }
    const entry = { t: new Date().toISOString(), event, email: String(email || "").toLowerCase() };
    if (detail) entry.detail = detail;
    const country = request && request.headers.get("CF-IPCountry");
    if (country) entry.country = country;
    const ip = request && request.headers.get("CF-Connecting-IP");
    if (ip) entry.ip = ip;
    const ua = request && request.headers.get("User-Agent");
    if (ua) entry.ua = ua.slice(0, 200);
    list.push(entry);
    if (list.length > LOG_KEEP) list = list.slice(list.length - LOG_KEEP);
    await env.ROLES.put("log", JSON.stringify(list));
  } catch (e) { /* logging must never break sign-in */ }
}

async function sessionEmail(request, env) {
  const raw = cookies(request)[SESSION_COOKIE];
  if (!raw || !env.SESSION_SECRET) return null;
  const value = await unsign(raw, env.SESSION_SECRET);
  if (!value) return null;
  let data;
  try { data = JSON.parse(new TextDecoder().decode(b64urlDecode(value))); } catch (e) { return null; }
  if (!data || !data.e || !data.x || data.x < Date.now()) return null;
  return (await isAllowed(env, data.e)) ? data.e : null;
}

const HEADERS = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" };
function page(title, body, status) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080b10;color:#eef3f8;font:16px system-ui,sans-serif}` +
    `main{max-width:380px;padding:32px;text-align:center}h1{font-size:22px;margin:0 0 8px}p{color:#8b96a8;margin:0 0 20px;line-height:1.5}` +
    `a.btn{display:inline-block;background:#34d399;color:#06241d;font-weight:700;text-decoration:none;padding:10px 18px;border-radius:999px}</style></head>` +
    `<body><main>${body}</main></body></html>`;
  return new Response(html, { status: status || 200, headers: Object.assign({ "Content-Type": "text/html; charset=utf-8" }, HEADERS) });
}
function landing() {
  return page("Shift Plan", `<h1>Shift Plan</h1><p>Sign in with your Google account to open the calendar.</p><a class="btn" href="/auth/login">Sign in with Google</a>`, 200);
}
function denied() {
  return page("Not allowed", `<h1>Not allowed</h1><p>This Google account does not have access to the calendar. Ask a lead to add your email.</p><a class="btn" href="/auth/login">Try another account</a>`, 403);
}
function failed(message) {
  return page("Sign-in failed", `<h1>Sign-in failed</h1><p>${message}</p><a class="btn" href="/auth/login">Try again</a>`, 400);
}
function json(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: Object.assign({ "Content-Type": "application/json" }, HEADERS) });
}

async function login(request, env) {
  const url = new URL(request.url);
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const state = await sign(nonce, env.SESSION_SECRET);
  const target = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: url.origin + "/auth/callback",
    response_type: "code",
    scope: "openid email",
    state,
    prompt: "select_account"
  });
  return new Response(null, { status: 302, headers: Object.assign({ Location: target, "Set-Cookie": cookie(STATE_COOKIE, state, 600) }, HEADERS) });
}

async function callback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const saved = cookies(request)[STATE_COOKIE];
  if (!code || !state || !saved || state !== saved || !(await unsign(state, env.SESSION_SECRET))) {
    return failed("The sign-in link expired or was not started here.");
  }
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: url.origin + "/auth/callback",
      grant_type: "authorization_code"
    })
  });
  if (!tokenRes.ok) return failed("Google did not accept the sign-in.");
  const tokenBody = await tokenRes.json();
  if (!tokenBody || !tokenBody.access_token) return failed("Google did not return a sign-in.");
  const meRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: "Bearer " + tokenBody.access_token } });
  if (!meRes.ok) return failed("Could not read your Google email.");
  const me = await meRes.json();
  // The Google token is not kept: it was only needed to learn who signed in.
  if (!me || me.email_verified !== true || !(await isAllowed(env, me.email))) {
    await logEvent(env, request, "sign-in refused", me && me.email, me && me.email_verified !== true ? "email not verified" : "not on the list");
    return new Response(denied().body, { status: 403, headers: Object.assign({ "Content-Type": "text/html; charset=utf-8", "Set-Cookie": cookie(STATE_COOKIE, "", 0) }, HEADERS) });
  }
  const payload = b64url(enc.encode(JSON.stringify({ e: String(me.email).toLowerCase(), x: Date.now() + SESSION_DAYS * 86400000 })));
  await logEvent(env, request, "sign-in", me.email);
  const headers = new Headers(HEADERS);
  headers.set("Location", "/");
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, await sign(payload, env.SESSION_SECRET), SESSION_DAYS * 86400));
  headers.append("Set-Cookie", cookie(STATE_COOKIE, "", 0));
  return new Response(null, { status: 302, headers });
}

const RANK = { super: 0, admin: 1, member: 2 };
async function listUsers(env) {
  const stored = await storedRoles(env);
  const emails = [...await accessSet(env)];
  const users = [];
  for (const email of emails) users.push({ email, role: await roleOf(env, email, stored) });
  users.sort((a, b) => (RANK[a.role] - RANK[b.role]) || a.email.localeCompare(b.email));
  return users;
}

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
async function userAction(request, env, actorEmail) {
  const actor = await roleOf(env, actorEmail);
  if (actor !== "admin" && actor !== "super") return json({ error: "admins only" }, 403);
  if (!env.ROLES) return json({ error: "role storage is not set up" }, 501);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad request" }, 400); }
  const action = (body && body.action) || "role";
  const target = String((body && body.email) || "").trim().toLowerCase();
  const role = body && body.role;
  const stored = await storedRoles(env);
  const users = await storedUsers(env);

  if (action === "add") {
    if (!EMAIL_RE.test(target)) return json({ error: "Enter a valid email address." }, 400);
    if (role !== "admin" && role !== "member") return json({ error: "role must be admin or member" }, 400);
    if (role === "admin" && actor !== "super") return json({ error: "Only the Super Admin can add an Admin." }, 403);
    if ((await accessSet(env, users)).has(target)) return json({ error: "That person already has access." }, 409);
    users.removed = users.removed.filter(x => String(x).toLowerCase() !== target);
    if (!emailList(env.ALLOWED_EMAILS).includes(target) && !users.added.includes(target)) users.added.push(target);
    stored[target] = role;
    await env.ROLES.put("users", JSON.stringify(users));
    await env.ROLES.put("roles", JSON.stringify(stored));
    await logEvent(env, request, "user added", actorEmail, target + " as " + role);
    return json({ ok: true, users: await listUsers(env) });
  }

  if (!(await accessSet(env, users)).has(target)) return json({ error: "unknown person" }, 404);
  const current = await roleOf(env, target, stored);
  if (current === "super") return json({ error: "The Super Admin cannot be changed or removed." }, 403);
  if (current === "admin" && actor !== "super") return json({ error: "Only the Super Admin can change or remove an Admin." }, 403);

  if (action === "remove") {
    if (target === String(actorEmail).toLowerCase()) return json({ error: "You cannot remove yourself." }, 403);
    users.added = users.added.filter(x => String(x).toLowerCase() !== target);
    if (emailList(env.ALLOWED_EMAILS).includes(target) && !users.removed.includes(target)) users.removed.push(target);
    delete stored[target];
    await env.ROLES.put("users", JSON.stringify(users));
    await env.ROLES.put("roles", JSON.stringify(stored));
    await logEvent(env, request, "user removed", actorEmail, target);
    return json({ ok: true, users: await listUsers(env) });
  }

  if (role !== "admin" && role !== "member") return json({ error: "role must be admin or member" }, 400);
  stored[target] = role;
  await env.ROLES.put("roles", JSON.stringify(stored));
  await logEvent(env, request, "role changed", actorEmail, target + " to " + role);
  return json({ ok: true, users: await listUsers(env) });
}

// The shared plan lives in one Durable Object, so there is a single strongly consistent copy: no third-party store to go down and
// no public address to protect. It holds the plan document exactly as the page sends it (plan plus its last-edit time).
const PLAN_MAX = 1900000;
export class PlanStore {
  constructor(state) { this.state = state; }
  async fetch(request) {
    const headers = { "Content-Type": "application/json" };
    if (request.method === "GET") {
      const doc = await this.state.storage.get("doc");
      return doc ? new Response(doc, { headers }) : new Response('{"error":"no plan yet"}', { status: 404, headers });
    }
    if (request.method === "POST") {
      await this.state.storage.put("doc", await request.text());
      return new Response('{"ok":true}', { headers });
    }
    return new Response("Method not allowed", { status: 405 });
  }
}
async function planStore(request, env, rest) {
  if (!env.PLAN) return new Response("Plan store is not configured.", { status: 500, headers: HEADERS });
  if (rest !== "plan") return new Response("Not found", { status: 404, headers: HEADERS });
  if (request.method !== "GET" && request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: HEADERS });
  const init = { method: request.method };
  if (request.method === "POST") {
    const text = await request.text();
    if (text.length > PLAN_MAX) return new Response("Too large", { status: 413, headers: HEADERS });
    let doc;
    try { doc = JSON.parse(text); } catch (e) { return json({ error: "not JSON" }, 400); }
    if (!doc || typeof doc !== "object" || typeof doc.updatedAt !== "string" || !doc.updatedAt || !doc.calendar || typeof doc.calendar !== "object") {
      return json({ error: "that is not a plan" }, 400);
    }
    init.body = text;
  }
  const res = await env.PLAN.get(env.PLAN.idFromName("plan")).fetch("https://plan.internal/doc", init);
  const headers = new Headers(HEADERS);
  headers.set("Content-Type", "application/json");
  return new Response(res.body, { status: res.status, headers });
}

export default {
  async fetch(request, env) {
    if (!env.SESSION_SECRET || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      return page("Not set up", `<h1>Not set up yet</h1><p>The sign-in settings are missing.</p>`, 503);
    }
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/auth/login") return login(request, env);
    if (path === "/auth/callback") return callback(request, env);
    if (path === "/auth/logout") {
      const who = await sessionEmail(request, env);
      if (who) await logEvent(env, request, "sign-out", who);
      const headers = new Headers(HEADERS);
      headers.set("Location", "/");
      headers.append("Set-Cookie", cookie(SESSION_COOKIE, "", 0));
      headers.append("Set-Cookie", cookie(STATE_COOKIE, "", 0));
      return new Response(null, { status: 302, headers });
    }
    const email = await sessionEmail(request, env);
    if (path.startsWith("/api/")) {
      if (!email) return json({ error: "sign in required" }, 401);
      // Writes must come from our own page.
      const origin = request.headers.get("Origin");
      if (request.method !== "GET" && origin && origin !== url.origin) return json({ error: "bad origin" }, 403);
      if (path === "/api/me") return json({ email, role: await roleOf(env, email) });
      if (path === "/api/users") {
        const role = await roleOf(env, email);
        if (role !== "admin" && role !== "super") return json({ error: "admins only" }, 403);
        if (request.method === "GET") return json({ users: await listUsers(env), editable: !!env.ROLES });
        if (request.method === "POST") return userAction(request, env, email);
        return json({ error: "method not allowed" }, 405);
      }
      if (path === "/api/log") {
        const role = await roleOf(env, email);
        if (role !== "admin" && role !== "super") return json({ error: "admins only" }, 403);
        let list = [];
        if (env.ROLES) { try { list = JSON.parse((await env.ROLES.get("log")) || "[]") || []; } catch (e) { list = []; } }
        return json({ log: list.slice().reverse(), kept: LOG_KEEP });
      }
      if (path.startsWith("/api/team/")) return planStore(request, env, path.slice("/api/team/".length));
      return new Response("Not found", { status: 404, headers: HEADERS });
    }
    if (!email) return landing();
    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    Object.keys(HEADERS).forEach(k => headers.set(k, HEADERS[k]));
    return new Response(res.body, { status: res.status, headers });
  }
};
