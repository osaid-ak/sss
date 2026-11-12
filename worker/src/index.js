// Shift Plan gate: Intercom sign-in in front of the calendar and the shared plan.
//
// Routes
//   /auth/login     start "Sign in with Intercom" (OAuth)
//   /auth/callback  Intercom sends the person back here; we check their email against ALLOWED_EMAILS
//   /auth/logout    clear the session
//   /api/team/*     the shared team plan (proxied to PLAN_BASE, signed-in people only)
//   everything else the calendar page (static asset, signed-in people only)
//
// Secrets (set with `wrangler secret put`, never committed):
//   INTERCOM_CLIENT_ID, INTERCOM_CLIENT_SECRET, SESSION_SECRET, ALLOWED_EMAILS, PLAN_BASE
// ALLOWED_EMAILS is a comma-separated list. It is re-read on every request, so removing an email
// locks that person out immediately, even if they already have a session.

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
function allowed(env, email) {
  if (!email) return false;
  const list = String(env.ALLOWED_EMAILS || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  return list.includes(String(email).trim().toLowerCase());
}
async function sessionEmail(request, env) {
  const raw = cookies(request)[SESSION_COOKIE];
  if (!raw || !env.SESSION_SECRET) return null;
  const value = await unsign(raw, env.SESSION_SECRET);
  if (!value) return null;
  let data;
  try { data = JSON.parse(new TextDecoder().decode(b64urlDecode(value))); } catch (e) { return null; }
  if (!data || !data.e || !data.x || data.x < Date.now()) return null;
  return allowed(env, data.e) ? data.e : null;
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
  return page("Shift Plan", `<h1>Shift Plan</h1><p>Sign in with your Intercom account to open the calendar.</p><a class="btn" href="/auth/login">Sign in with Intercom</a>`, 200);
}
function denied() {
  return page("Not allowed", `<h1>Not allowed</h1><p>This Intercom account does not have access to the calendar. Ask a lead to add your email.</p><a class="btn" href="/auth/logout">Try another account</a>`, 403);
}

async function login(request, env) {
  const url = new URL(request.url);
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const state = await sign(nonce, env.SESSION_SECRET);
  const target = "https://app.intercom.com/oauth?" + new URLSearchParams({
    client_id: env.INTERCOM_CLIENT_ID,
    state,
    redirect_uri: url.origin + "/auth/callback"
  });
  return new Response(null, { status: 302, headers: Object.assign({ Location: target, "Set-Cookie": cookie(STATE_COOKIE, state, 600) }, HEADERS) });
}

async function callback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const saved = cookies(request)[STATE_COOKIE];
  if (!code || !state || !saved || state !== saved || !(await unsign(state, env.SESSION_SECRET))) {
    return page("Sign-in failed", `<h1>Sign-in failed</h1><p>The sign-in link expired or was not started here.</p><a class="btn" href="/auth/login">Try again</a>`, 400);
  }
  const tokenRes = await fetch("https://api.intercom.io/auth/eagle/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ code, client_id: env.INTERCOM_CLIENT_ID, client_secret: env.INTERCOM_CLIENT_SECRET })
  });
  if (!tokenRes.ok) return page("Sign-in failed", `<h1>Sign-in failed</h1><p>Intercom did not accept the sign-in.</p><a class="btn" href="/auth/login">Try again</a>`, 400);
  const tokenBody = await tokenRes.json();
  const token = tokenBody && tokenBody.token;
  if (!token) return page("Sign-in failed", `<h1>Sign-in failed</h1><p>Intercom did not return a sign-in.</p><a class="btn" href="/auth/login">Try again</a>`, 400);
  const meRes = await fetch("https://api.intercom.io/me", { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  if (!meRes.ok) return page("Sign-in failed", `<h1>Sign-in failed</h1><p>Could not read your Intercom profile.</p><a class="btn" href="/auth/login">Try again</a>`, 400);
  const me = await meRes.json();
  // The Intercom token is not kept: it was only needed to learn who signed in.
  if (!allowed(env, me && me.email)) {
    return new Response(denied().body, { status: 403, headers: Object.assign({ "Content-Type": "text/html; charset=utf-8", "Set-Cookie": cookie(STATE_COOKIE, "", 0) }, HEADERS) });
  }
  const payload = b64url(enc.encode(JSON.stringify({ e: String(me.email).toLowerCase(), x: Date.now() + SESSION_DAYS * 86400000 })));
  const headers = new Headers(HEADERS);
  headers.set("Location", "/");
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, await sign(payload, env.SESSION_SECRET), SESSION_DAYS * 86400));
  headers.append("Set-Cookie", cookie(STATE_COOKIE, "", 0));
  return new Response(null, { status: 302, headers });
}

async function proxyPlan(request, env, rest) {
  if (!env.PLAN_BASE) return new Response("Plan store is not configured.", { status: 500, headers: HEADERS });
  if (request.method !== "GET" && request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: HEADERS });
  if (!/^[a-z0-9/_-]*$/i.test(rest) || rest.includes("..")) return new Response("Not found", { status: 404, headers: HEADERS });
  const url = String(env.PLAN_BASE).replace(/\/+$/, "") + (rest ? "/" + rest : "");
  const init = { method: request.method, headers: { Accept: "application/json" } };
  if (request.method === "POST") {
    init.headers["Content-Type"] = "application/json";
    init.body = await request.text();
  }
  const upstream = await fetch(url, init);
  const headers = new Headers(HEADERS);
  headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
  return new Response(upstream.body, { status: upstream.status, headers });
}

export default {
  async fetch(request, env) {
    if (!env.SESSION_SECRET || !env.INTERCOM_CLIENT_ID || !env.INTERCOM_CLIENT_SECRET) {
      return page("Not set up", `<h1>Not set up yet</h1><p>The sign-in settings are missing.</p>`, 503);
    }
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/auth/login") return login(request, env);
    if (path === "/auth/callback") return callback(request, env);
    if (path === "/auth/logout") {
      const headers = new Headers(HEADERS);
      headers.set("Location", "/");
      headers.append("Set-Cookie", cookie(SESSION_COOKIE, "", 0));
      headers.append("Set-Cookie", cookie(STATE_COOKIE, "", 0));
      return new Response(null, { status: 302, headers });
    }
    const email = await sessionEmail(request, env);
    if (path.startsWith("/api/")) {
      if (!email) return new Response(JSON.stringify({ error: "sign in required" }), { status: 401, headers: Object.assign({ "Content-Type": "application/json" }, HEADERS) });
      if (path.startsWith("/api/team/")) return proxyPlan(request, env, path.slice("/api/team/".length));
      return new Response("Not found", { status: 404, headers: HEADERS });
    }
    if (!email) return landing();
    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    Object.keys(HEADERS).forEach(k => headers.set(k, HEADERS[k]));
    return new Response(res.body, { status: res.status, headers });
  }
};
