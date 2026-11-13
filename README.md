# Support Shift Schedule (SSS)

Team test copy of the support shift calendar.

## Live page

https://shift-plan.autoleap-sss.workers.dev/ (sign in with your Google account; only people on the allowed list get in). The old address, https://osaid-ak.github.io/sss/, redirects there.

The header on the site is **Shift Plan**. Setup and roles are in [worker/README.md](worker/README.md).

## Weekend Cover

The **Shift Sheet** button in the header opens the Google Sheet inside the calendar, starting on the Weekend Cover tab. Use the tabs at the bottom to switch sheets. You can edit there if your Google account has edit access; otherwise it is view only. If the embedded sheet asks you to sign in or will not let you edit, use **Open in Google Sheets** in the panel bar. Browsers that block third-party cookies (Safari, Firefox, private windows) may show view only inside the calendar.

The calendar also reads Saturday Actual Cover from that sheet on load, when you come back to the tab, and about every 45 seconds. This works today because the Weekend Cover tab is shared as **Anyone with the link can view** (edit access stays limited to the team). If that sharing is ever turned off, the live read stops and Saturdays keep their last synced names. The fallback is:

- Deploy `weekend-cover.gs` from the sheet: Extensions → Apps Script → paste → Deploy → Web app → Execute as Me, Who has access: Anyone. Put the `/exec` URL in `WEEKEND_COVER_API` in the calendar file.

## What testers should know

Schedule edits sync to the shared team plan, so a change on one browser shows up for the rest of the team. Each browser also keeps a local copy.

Product rules and how to publish a change are in [AGENTS.md](AGENTS.md).

## Safety

The calendar and the shared plan are served only after Google sign-in, and only to people on the allowed list (see worker/README.md). The GitHub repo is still public, so it holds no secrets and no plan data: the calendar page itself is deployed straight to the worker and is not committed. Old commits still show an earlier version of the page (including the old lead PIN, which the gated site ignores) and the address of the old public plan, which is being emptied. Making the repo private is optional.

The Google Sheet stays as private as its own sharing settings. The calendar reads it from each person's browser, so if a tab is "anyone with the link", anyone with the link can read that tab.
