GOVSPEND DASHBOARDS HUB — quick reference
=========================================

Live site: https://govspend-ops-dashboards.netlify.app
GitHub:    https://github.com/mbeard-collab/lantern  (private; Netlify auto-deploys from main)
           https://github.com/smartprocure/lantern   (org backup — kept in sync via dual-push)

For Claude Code: read CLAUDE.md first — it covers all conventions, the design system, the data
pipeline, env vars, CrateDB, git remote setup, and how to add a new dashboard.


STRUCTURE
---------
index.html                  → landing page (the hub, links to all dashboards)
<slug>/index.html           → each dashboard in its own folder (e.g. sales/, usage-data/)
<slug>/sales_data.js        → pipeline data files live next to the dashboard HTML
_pipeline/                  → data refresh pipeline (Node.js, reads CrateDB, commits to GitHub)
netlify/functions/          → Netlify Functions for Studio (commit.mjs) and browser refresh
_template/dashboard.html    → copy this when creating a new dashboard
CLAUDE.md                   → Claude Code conventions (comprehensive)
_pipeline/README.md         → pipeline setup and usage


ADDING OR UPDATING A DASHBOARD
-------------------------------
Option A — via Studio (recommended for most updates):
  Go to the live site, click Studio in the nav, log in with your admin email + password.
  Studio commits to GitHub and Netlify deploys automatically (~30s).

Option B — locally with Claude Code:
  Edit files locally, then run /ship to commit and push.
  See CLAUDE.md for step-by-step conventions.

Option C — pipeline-backed dashboard (live data from CrateDB):
  See _pipeline/README.md for how to create a query module and wire it up.


DEPLOYING
---------
Every push to `main` on mbeard-collab/lantern triggers a Netlify deploy automatically.
There is no manual drag-and-drop step. The site is live in ~30 seconds after a push.

To push:  git push origin main
This pushes to both mbeard-collab/lantern AND smartprocure/lantern simultaneously
(dual-push remote config — no extra steps needed).


PASSWORD PROTECTION
-------------------
The entire site is protected by Netlify site-level basic auth.
Credentials are set in the Netlify dashboard (not in this repo).
The pipeline and Studio functions authenticate via separate mechanisms (see CLAUDE.md).


NOTES
-----
- Never commit _pipeline/.env — it contains real CrateDB credentials.
- GITHUB_TOKEN, CRATE_PASSWORD, and all other secrets live only in Netlify env vars
  and in _pipeline/.env (gitignored). If you accidentally expose them, rotate immediately.
- The "Updated X days ago" badge in the landing page is set in the DASHBOARDS array
  in index.html (the `updated` field). Update it whenever you refresh a dashboard.
