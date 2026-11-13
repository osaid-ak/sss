# Shift Plan sign-in gate (Cloudflare Worker)

Puts "Sign in with Google" in front of the calendar and keeps the shared team plan inside the worker, with two roles:

- **Member**: can view the calendar. No Access button, no lead tools.
- **Admin**: lead access (no PIN), plus a Users list under Access where they can add people as Members, remove Members and change Members' roles.
- **Super Admin** (one person): everything an Admin can do, and the only one who can add an Admin or change or remove another Admin. Always allowed in and always Super Admin.

How it works: the worker serves the calendar page itself and stores the shared plan in a Durable Object (one strongly consistent copy, free plan). Nothing is served until the person has signed in with Google and their email is on the allowed list. The calendar file is copied in at deploy time (`deploy.ps1`) and is never committed. Roles are checked by the server on every request. There is no third-party plan store and no public plan address.

## One-time setup

1. **Google sign-in**: in console.cloud.google.com create a project, then APIs & Services -> OAuth consent screen (choose Internal if you use Google Workspace, so only your company can sign in), then Credentials -> Create credentials -> OAuth client ID -> Web application. Under Authorized redirect URIs add `https://<worker-address>/auth/callback`. Copy the Client ID and Client secret.
2. **Cloudflare**: `npx wrangler@4 login` in this folder.
3. **Secrets**: run each command, then paste the value at the hidden prompt (the command takes only the name, never `name:value`):

   ```
   npx wrangler@4 secret put GOOGLE_CLIENT_ID
   npx wrangler@4 secret put GOOGLE_CLIENT_SECRET
   npx wrangler@4 secret put SESSION_SECRET      # a long random string
   npx wrangler@4 secret put ALLOWED_EMAILS      # comma separated: everyone who may sign in
   npx wrangler@4 secret put ADMIN_EMAILS        # comma separated: who starts as an Admin
   npx wrangler@4 secret put SUPER_ADMIN         # one email
   ```
   `PLAN_BASE` (the old plan address) is no longer used. Remove it with `npx wrangler@4 secret delete PLAN_BASE`.
4. **Deploy**: `.\deploy.ps1`. The first deploy creates the ROLES store (roles, added and removed people, activity log) and the plan store. If wrangler asks for a KV namespace id instead, run `npx wrangler@4 kv namespace create ROLES` and add the printed `id = "..."` under `[[kv_namespaces]]` in `wrangler.toml`.

## Putting the team plan in

The plan store starts empty. A browser that has no plan of its own shows "No team plan yet" instead of the starter data, so nothing can overwrite it. To start it:

1. Sign in as an Admin.
2. Click **Import plan file** on that card and choose the plan file. Best source: on the old GitHub page, in the browser you normally use, Access -> Export JSON (that copy is the newest). Otherwise use `seed-plan.json` in this folder, a copy of the plan from 13 Nov 2026 (not committed).
3. Confirm. Everyone else's browser picks it up within about 20 seconds, and browsers that have a local copy merge it as usual.

If a browser that already has a plan connects to the empty store first, it pushes its own copy, which also starts it.

## Closing the public copy

The old page at https://osaid-ak.github.io/sss/ and the old plan address (mantledb) are public, and both are in the public git history. Once the worker has the plan:

- Replace `index.html` on GitHub Pages with the stub (`stub-index.html`, with the worker address filled in) so the old link only points to the new one.
- Ask everyone to reload, then overwrite the old mantledb plan with an empty placeholder so nothing is left there.
- The lead PIN stops mattering: the gated site ignores it.
- Making the GitHub repo private is optional once the above is done.

## Changing who is allowed or who starts as an Admin

`npx wrangler@4 secret put ALLOWED_EMAILS` (or `ADMIN_EMAILS`) with the new list, or use Users inside the calendar. It takes effect on the next request, and removed people are locked out even if already signed in. Role changes made in the app are stored separately and win over `ADMIN_EMAILS`. Sessions last 7 days.

## Activity log

Admins and the Super Admin see the latest 500 sign-ins, refused sign-ins, sign-outs and user changes under Access -> Activity log. Each entry has the email, event, time, country, IP address and browser, so sign-ins from a future mobile app can be told apart. Let the team know these are recorded. Sessions are signed cookies that last 7 days; to cut someone off at once, remove them in the Users panel.

## Limits

- Admin and Member are enforced by the server for the user list and role changes. Inside the calendar, lead tools follow the role, but a Member's browser can still send schedule edits to the shared plan, because Members must be able to sync it.
- The shared plan is one document, last write wins, as before: browsers merge on their side. The server only checks that a write is a plan and is under 1.9 MB.
- The Google Sheet is read straight from each person's browser, so its own sharing settings apply.

## Checks

`node test.mjs` runs the sign-in, role and plan-store logic offline (mocked Google, an in-memory plan store).
