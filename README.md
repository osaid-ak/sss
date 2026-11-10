# Support Shift Schedule (SSS)

Team test copy of the support shift calendar.

## Live page

https://osaid-ak.github.io/sss/

The header on the site is **Shift Plan**.

A true custom hostname such as `sss.yourteam.com` is free on GitHub Pages, but you have to own the domain.

## Weekend Cover

The **Shift Sheet** button in the header opens the Google Sheet inside the calendar, starting on the Weekend Cover tab. Use the tabs at the bottom to switch sheets. You can edit there if your Google account has edit access; otherwise it is view only. If the embedded sheet asks you to sign in or will not let you edit, use **Open in Google Sheets** in the panel bar. Browsers that block third-party cookies (Safari, Firefox, private windows) may show view only inside the calendar.

The calendar also reads Saturday Actual Cover from that sheet on load, when you come back to the tab, and about every 45 seconds. This works today because the Weekend Cover tab is shared as **Anyone with the link can view** (edit access stays limited to the team). If that sharing is ever turned off, the live read stops and Saturdays keep their last synced names. The fallback is:

- Deploy `weekend-cover.gs` from the sheet: Extensions → Apps Script → paste → Deploy → Web app → Execute as Me, Who has access: Anyone. Put the `/exec` URL in `WEEKEND_COVER_API` in the calendar file.

## What testers should know

Schedule edits sync to the shared team plan, so a change on one browser shows up for the rest of the team. Each browser also keeps a local copy.

Product rules and how to publish a change are in [AGENTS.md](AGENTS.md).

## Safety of a public GitHub repo

Treat this as an internal test link, not a vault.

- Anyone on the internet can open the repo and the live page if they find the URL.
- Teammate names, the Google Sheet ID, and the lead PIN are in the page source.
- A public repo can be indexed by search engines.
- Google tokens were not uploaded. The sheet stays as private as its Google sharing settings. If you make Weekend Cover “anyone with the link” so the calendar can auto-sync, that tab is readable by anyone who has the link.

Safer for a longer test: make the GitHub repo **private** and host the page on Cloudflare Pages (free), then share only that URL with the team.
