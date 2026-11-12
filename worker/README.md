# Shift Plan sign-in gate (Cloudflare Worker)

Puts "Sign in with Intercom" in front of the calendar and the shared team plan. Only Intercom teammates whose email is on the allowed list get in. There is no user database: the list is one secret.

How it works: the worker serves the calendar page itself and proxies the shared plan. Nothing is served until the person has signed in with Intercom and their email is on the list. The calendar file is copied in at deploy time and is never committed.

## One-time setup

1. **Intercom app** (Developer Hub -> your app -> Authentication): turn on OAuth and add this redirect URL once you know the worker address: `https://<worker-address>/auth/callback`. Note the client ID and client secret.
2. **Cloudflare**: create a free account, then in this folder run `npx wrangler@4 login`.
3. **Secrets** (each command asks you to paste the value):

   ```
   npx wrangler@4 secret put INTERCOM_CLIENT_ID
   npx wrangler@4 secret put INTERCOM_CLIENT_SECRET
   npx wrangler@4 secret put SESSION_SECRET      # any long random string, e.g. from a password generator
   npx wrangler@4 secret put ALLOWED_EMAILS      # comma separated: ann@company.com,bob@company.com
   npx wrangler@4 secret put PLAN_BASE           # https://mantledb.sh/v2/<key>  (no trailing /plan)
   ```
4. **Deploy**: `.\deploy.ps1`. It prints the worker address (`https://shift-plan.<account>.workers.dev`). Put that address in the Intercom redirect URL from step 1.

## Closing the public copy

The old page at https://osaid-ak.github.io/sss/ and the old plan address are public, and both are in the public git history. After the worker works:

- Rotate the plan address: pick a new random key, run `node copy-plan.mjs <old plan url> https://mantledb.sh/v2/<new key>/plan`, and set `PLAN_BASE` to `https://mantledb.sh/v2/<new key>`.
- Replace `index.html` on GitHub Pages with the stub (`stub-index.html`, with the worker address filled in) so the old link only points to the new one.
- Change the lead PIN in the calendar file, because the old page and its history showed it.
- Making the GitHub repo private is optional once the above is done.

## Changing who is allowed

`npx wrangler@4 secret put ALLOWED_EMAILS` with the new list. It takes effect on the next request, and removed people are locked out even if they are already signed in. Sessions last 7 days.

## Checks

`node test.mjs` runs the sign-in logic offline (mocked Intercom and plan store).
