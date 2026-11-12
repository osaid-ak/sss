# Shift Plan sign-in gate (Cloudflare Worker)

Puts "Sign in with Google" in front of the calendar and the shared team plan, with two roles:

- **Member**: can view the calendar. No Access button, no lead tools.
- **Admin**: lead access (no PIN), plus a Users list under Access where they can add people as Members, remove Members and change Members' roles.
- **Super Admin** (one person): everything an Admin can do, and the only one who can add an Admin or change or remove another Admin. Always allowed in and always Super Admin.

How it works: the worker serves the calendar page itself and proxies the shared plan. Nothing is served until the person has signed in with Google and their email is on the allowed list. The calendar file is copied in at deploy time (`deploy.ps1`) and is never committed. Roles are checked by the server on every request.

## One-time setup

1. **Google sign-in**: in console.cloud.google.com create a project, then APIs & Services -> OAuth consent screen (choose Internal if you use Google Workspace, so only your company can sign in), then Credentials -> Create credentials -> OAuth client ID -> Web application. Under Authorized redirect URIs add `https://<worker-address>/auth/callback`. Copy the Client ID and Client secret.
2. **Cloudflare**: `npx wrangler@4 login` in this folder.
3. **Secrets**: run each command, then paste the value at the hidden prompt (the command takes only the name, never `name:value`):

   ```
   npx wrangler@4 secret put GOOGLE_CLIENT_ID
   npx wrangler@4 secret put GOOGLE_CLIENT_SECRET
   npx wrangler@4 secret put SESSION_SECRET      # a long random string
   npx wrangler@4 secret put PLAN_BASE           # https://mantledb.sh/v2/<key>  (no trailing /plan)
   npx wrangler@4 secret put ALLOWED_EMAILS      # comma separated: everyone who may sign in
   npx wrangler@4 secret put ADMIN_EMAILS        # comma separated: who starts as an Admin
   npx wrangler@4 secret put SUPER_ADMIN         # one email
   ```
4. **Deploy**: `.\deploy.ps1`. The first deploy creates the ROLES store that keeps role changes. If wrangler asks for a namespace id instead, run `npx wrangler@4 kv namespace create ROLES` and add the printed `id = "..."` under `[[kv_namespaces]]` in `wrangler.toml`.

The old Intercom secrets (`INTERCOM_CLIENT_ID`, `INTERCOM_CLIENT_SECRET`) are no longer used. Delete them with `npx wrangler@4 secret delete <name>`.

## Closing the public copy

The old page at https://osaid-ak.github.io/sss/ and the old plan address are public, and both are in the public git history. After the worker works:

- Rotate the plan address: pick a new random key, run `node copy-plan.mjs <old plan url> https://mantledb.sh/v2/<new key>/plan`, and set `PLAN_BASE` to `https://mantledb.sh/v2/<new key>`.
- Replace `index.html` on GitHub Pages with the stub (`stub-index.html`, with the worker address filled in) so the old link only points to the new one.
- Making the GitHub repo private is optional once the above is done.

## Changing who is allowed or who starts as an Admin

`npx wrangler@4 secret put ALLOWED_EMAILS` (or `ADMIN_EMAILS`) with the new list. It takes effect on the next request, and removed people are locked out even if already signed in. Role changes made in the app are stored separately and win over `ADMIN_EMAILS`. Sessions last 7 days.

## Activity log

Admins and the Super Admin see the latest 500 sign-ins, refused sign-ins, sign-outs and user changes under Access -> Activity log. Only email, event, time and country are recorded, not IP addresses or browsers. Sessions are signed cookies that last 7 days; to cut someone off at once, remove them in the Users panel.

## Limits

- Admin and Member are enforced by the server for the user list and role changes. Inside the calendar, lead tools follow the role, but a Member's browser can still send schedule edits to the shared plan, because Members must be able to sync it.
- The Google Sheet is read straight from each person's browser, so its own sharing settings apply.

## Checks

`node test.mjs` runs the sign-in and role logic offline (mocked Google and plan store).
