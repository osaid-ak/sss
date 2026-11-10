# Support Shift Schedule (SSS)

Team test copy of the support shift calendar.

## Live page

https://osaid-ak.github.io/sss/

The header on the site is **Shift Plan**.

A true custom hostname such as `sss.yourteam.com` is free on GitHub Pages, but you have to own the domain.

## Weekend Cover

**Weekend Coverage** opens the Google Sheet for anyone who already has access.

The calendar also reads Saturday Actual Cover from that sheet on load, when you come back to the tab, and about every 45 seconds. For that live read to work from the public page, use one of these:

1. Share the Weekend Cover tab as **Anyone with the link can view** (edit access can stay limited to the team), or
2. Deploy `weekend-cover.gs` from the sheet: Extensions → Apps Script → paste → Deploy → Web app → Execute as Me, Who has access: Anyone. Put the `/exec` URL in `WEEKEND_COVER_API` in the calendar file.

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
