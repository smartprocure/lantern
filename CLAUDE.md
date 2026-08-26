# Dashboards Site — Conventions for Claude Code

This repo is the GovSpend internal dashboard hub, deployed to Netlify with continuous deploy from `main` on `github.com/mbeard-collab/lantern`. When you (Claude Code) help build or update a dashboard, follow everything below.

---

## Architecture overview

```
Browser ──→ Netlify (govspend-ops-dashboards.netlify.app)
               │
               ├─ serves static files from the repo (index.html, <slug>/index.html, <slug>/data files)
               └─ runs Netlify Functions for Studio (commit.mjs) and browser refresh (refresh-usage-data.mjs)

Pipeline (runs locally on Matt's laptop or any machine with CrateDB access)
  node _pipeline/refresh.mjs <slug>
               │
               └─ queries CrateDB → serialises → commits data file to GitHub via GitHub Contents API
                  (bypasses Netlify entirely — Netlify site-level password protection blocks external function calls)

Studio (govspend-ops-dashboards.netlify.app/studio/)
               │
               └─ calls /.netlify/functions/commit to ship HTML and data files to GitHub
```

**Key insight:** The pipeline (`_pipeline/`) commits data files **directly to GitHub** via the GitHub REST API — it does NOT call any Netlify function. The site has Netlify password protection which blocks all external HTTP requests (including `/.netlify/functions/*`). Only a browser with the site cookie can reach those functions.

---

## Repo structure

```
index.html                      Landing page — has the DASHBOARDS registry JS array
README.txt                      Quick-start for human maintainers
CLAUDE.md                       This file (Claude Code conventions)
netlify.toml                    Netlify config (redirects, function settings)

_template/
  dashboard.html                Skeleton for new dashboards (copy this, don't write from scratch)

.claude/
  commands/
    build-dashboard.md          Slash command: generate dashboard HTML from data
    ship.md                     Slash command: commit + push + verify deploy

_pipeline/
  refresh.mjs                   Main pipeline runner — node _pipeline/refresh.mjs <slug>
  .env                          Secrets (GITIGNORED — never commit)
  .env.example                  Blank placeholders (safe to commit)
  lib/
    crate.mjs                   CrateDB HTTP query helper (SELECT/WITH only; 30s timeout)
    publish.mjs                 GitHub Contents API commit helper
    claude.mjs                  Narrative generation via Anthropic API (optional)
  queries/
    usage-data.mjs              Query module for usage-data/ dashboard
    sales2.mjs                  Query module for sales2/ dashboard
    renewal-manager-dashboard.mjs  Query module for renewals/ (legacy stub)

netlify/
  functions/
    commit.mjs                  Studio commit function (ship, delete, edit-meta, data actions)
    refresh-usage-data.mjs      Browser-triggered refresh for usage-data/ dashboard

<slug>/
  index.html                    One folder per dashboard, e.g. sales/, renewals/
  sales_data.js                 Data files set window.GS_* globals (for pipeline-backed dashboards)
  usage_data.js
```

---

## Existing dashboards

The authoritative list is in the `DASHBOARDS` array near the bottom of `index.html`. Current set:

**Operational**
- `sales/` — Sales Dashboard (manual upload, daily)
- `sales2/` — Sales Pipeline (Live) — pipeline-backed from CrateDB, daily
- `renewals/` — Renewals (pipeline-backed via Evan's Python pipeline, daily)
- `marketing/` — Marketing (manual upload, weekly)
- `customer-success/` — Customer Success (manual upload, weekly)

**Intelligence**
- `competitive/` — Competitive Analysis (manual upload, weekly)
- `agencies-po/` — Agencies with PO Data (manual upload, weekly)

**AI & Cost**
- `ai-spend/` — AI Spend (manual upload, daily)
- `token-usage/` — Token Usage (real-time)

**Reference**
- `news-feed/` — News Feed (manual upload, daily)
- `tech-completion/` — Tech Completion (manual upload, weekly)

**Special**
- `usage-data/` — Usage & Token Analytics (pipeline-backed from CrateDB, daily; has in-browser Refresh button)

---

## Git setup (dual-push)

The local repo is configured to push to **two remotes simultaneously**:

```
origin  https://github.com/mbeard-collab/lantern.git  (fetch + primary push)
origin  https://github.com/smartprocure/lantern.git   (second push URL)
upstream  https://github.com/smartprocure/lantern.git (fetch + push)
```

`git push` (or `git push origin main`) pushes to both repos in one command. Netlify is linked to `mbeard-collab/lantern` (the personal private repo). The `smartprocure/lantern` org repo is kept in sync as a backup.

**To push:** `git push origin main` — this is what `/ship` does.

**Auth:** The local git credential for GitHub is associated with `mbeard-collab`. If you get a 403, run `gh auth switch --user mbeard-collab` and retry.

---

## Netlify environment variables

These must be set in the Netlify dashboard (Site → Environment variables). They are **not** in the repo.

| Variable | Purpose |
|---|---|
| `GITHUB_TOKEN` | PAT with repo write access to `mbeard-collab/lantern` — used by the Netlify commit function |
| `GITHUB_REPO` | `mbeard-collab/lantern` |
| `STUDIO_ADMINS` | Comma-separated list of admin email addresses (e.g. `matt@govspend.com,ops@govspend.com`) |
| `STUDIO_ADMIN_PASSWORD` | Shared password for Studio human admins |
| `PIPELINE_SECRET` | Pipeline auth token — must match `PIPELINE_SECRET` in `_pipeline/.env` |
| `REFRESH_PASSWORD` | Password for the in-browser "Refresh data" button on `usage-data/` (currently `BeardLovesMe`) |
| `ANTHROPIC_KEY` | Anthropic API key for Studio's AI features |
| `CRATE_URL` | CrateDB HTTP endpoint (used by `refresh-usage-data.mjs` Netlify function) |
| `CRATE_USER` | CrateDB read-only username |
| `CRATE_PASSWORD` | CrateDB password |

---

## Pipeline env vars (`_pipeline/.env`)

Copy `_pipeline/.env.example` to `_pipeline/.env` and fill in:

```
CRATE_URL=https://govspend-production.aks1.eastus2.azure.cratedb.net:4200/
CRATE_USER=mcp_reader
CRATE_PASSWORD=<ask Matt>
PIPELINE_SECRET=<must match PIPELINE_SECRET in Netlify>
GITHUB_REPO=mbeard-collab/lantern
GITHUB_TOKEN=<PAT with repo write access>
PIPELINE_ANTHROPIC_KEY=<optional, for narrative generation>
SITE_URL=https://govspend-ops-dashboards.netlify.app
```

**Never commit `.env`.** It is gitignored. If you accidentally expose credentials, rotate them immediately.

---

## CrateDB

CrateDB is the data source for pipeline-backed dashboards. Key facts:

- **HTTP SQL API:** POST to `<CRATE_URL>/_sql` with `{ stmt, args }`. Basic auth. Returns `{ cols, rows }`.
- **Rows are arrays**, not objects. `crate.mjs` converts them to objects keyed by `cols`.
- **Column aliases are lowercased** unless quoted. `MAX(day) AS maxDay` arrives as `maxday`. Use lowercase aliases: `AS maxday`.
- **Reserved words** need double-quoting: `doc."user"`, `"Owner"`, `"Name"`.
- **Object field access:** `"Owner"['Name']` (CrateDB dot-notation inside an object column).
- **Account ID mismatch:** `salesforceopportunity.AccountId` is 18-char; `salesforceaccount.Id` is 15-char. Join via `LEFT(o."AccountId", 15) = a."Id"`.
- **Timeout:** `crate.mjs` enforces a 30-second timeout per query.
- **Only SELECT/WITH** is allowed by `crate.mjs` — it rejects anything else.

**Relevant schema:**

```
analytics.salesforceopportunity   — SF opportunity sync (pipeline, stage, ACV2__c, CloseDate, Owner object, etc.)
analytics.salesforceaccount       — SF account sync
analytics.usage_org_daily         — org-level token usage by day
analytics.usage_user_daily        — user-level token usage by day
analytics.usage_org_feature_rolling — org-level usage by feature (rolling window)
```

---

## Data pipeline — how to add a new live dashboard

### 1. Create a query module

Create `_pipeline/queries/<slug>.mjs`. Required exports:

```js
// What file to write inside the dashboard folder
export const outputFile = 'data.json';          // or 'my_data.js', etc.

// How to serialise the query result into file content (string)
// If omitted, refresh.mjs wraps the data in the standard JSON envelope.
export const formatOutput = (data) => `window.MY_GLOBAL = ${JSON.stringify(data)};\n`;

// The actual query function — receives { query } from crate.mjs
export default async function runQuery({ query }) {
  const rows = await query(`SELECT ... FROM analytics.my_table`);
  return { /* shaped data */ };
}
```

For dashboards that embed data as a JS global (like `usage-data/` and `sales2/`), use a custom `formatOutput` that writes `window.XYZ = ...;`. The dashboard HTML then loads the file with a `<script src="./my_data.js">` tag.

For simpler dashboards, omit `formatOutput` and the pipeline writes a standard JSON envelope. The dashboard fetches `./data.json` on load.

### 2. Build the dashboard HTML

Copy `_template/dashboard.html` to `<slug>/index.html`. The dashboard should load data from its sibling file:

```html
<!-- For JS global approach -->
<script src="./sales_data.js"></script>
<script>
  const data = window.GS_SALES;
  // render...
</script>

<!-- For JSON fetch approach -->
<script>
  const res = await fetch('./data.json');
  const { data } = await res.json();
</script>
```

Always include a fallback for missing/stale data files — the file won't exist on first load until the pipeline runs.

### 3. Test locally

```bash
# Dry run — print output to stdout, commit nothing
node _pipeline/refresh.mjs <slug> --dry-run --no-narrative

# Write file to working tree (for local browser testing)
node _pipeline/refresh.mjs <slug> --local --no-narrative

# Full run — commit to GitHub, trigger Netlify deploy
node _pipeline/refresh.mjs <slug> --no-narrative
```

### 4. Register in `index.html`

Add an entry to the `DASHBOARDS` array in `index.html` (see Updating the landing page below).

---

## Design system

Every dashboard uses the same dark aesthetic. **Do not invent new colors or fonts.**

```css
--bg:        #0B0F17  /* page background */
--bg-elev:   #121826  /* card background */
--bg-elev-2: #1A2235  /* deeper card / nested surfaces */
--line:      #232C42  /* card and divider borders */
--text:      #E6EAF2  /* primary text */
--text-strong: #FFFFFF /* titles, KPI values */
--muted:     #8A93A6  /* secondary text, axis labels */
--muted-2:   #6B7488  /* tertiary text, footer */

/* Accents — use sparingly, one per chart series */
--accent:    #4DA3FF  /* blue, primary */
--accent-2:  #7C5CFF  /* purple, secondary */
--green:     #39D98A  /* positive deltas, "win" states */
--amber:     #F5B556  /* warning, "active" states */
--red:       #FF6B6B  /* negative deltas, "at risk" states */
```

**Typography:** `-apple-system, "SF Pro Text", "Inter", Segoe UI, system-ui, sans-serif`. Use `font-variant-numeric: tabular-nums` for any column of numbers.

**Spacing rhythm:** Cards use 14–16px border-radius, 20–22px internal padding, 1px solid `--line` border.

**Charts:** Use Chart.js from `https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js`. Defaults:
- Line/area: `borderWidth: 1.8`, `pointRadius: 0`, `tension: 0.32`, fill at `1F` opacity
- Bar: `borderRadius: 6`, `barThickness: 22–28`
- Tooltips: dark `#0B0F17` background, `#232C42` border, padding 12, cornerRadius 8
- Grid: `rgba(255,255,255,0.04)` on Y axis only, no X grid
- Ticks: `--muted`

**Animations:** Subtle. `translateY(-2px)` on card hover, 0.18s ease.

---

## Conventions for new dashboards

1. **Start from `_template/dashboard.html`.** Copy to `<slug>/index.html`. Don't write HTML from scratch.

2. **Always include a back link** in the top-left: `← Back to all dashboards` pointing to `/`.

3. **Browser tab title:** `<Dashboard Name> — Dashboards`

4. **KPI row at the top** — four cards is standard, three is acceptable, more than four crowds the page.

5. **One main chart** below KPIs — full width, tells the headline story.

6. **Secondary charts or tables** in a 2-column grid below. Keep scannable at 1280px.

7. **Footer line** with data source, refresh cadence, owner.

8. **Freshness indicator** in the top-right of the main header — small green dot + "Refreshed Xm ago" badge using the data file's `generatedAt` or `generated_at` timestamp.

---

## Updating the landing page

Update the dashboard's entry in the `DASHBOARDS` array near the bottom of `index.html`:

- `updated`: set to today's date (YYYY-MM-DD) for fresh changes
- `description`: ≤ 160 chars, action-oriented
- `cadence`: `daily`, `weekly`, `ondemand`, or `realtime`
- `section`: `operational`, `intelligence`, `ai-cost`, or `reference`

For a brand-new dashboard, append a new object with all fields populated.

---

## Asking the user before building

When `/build-dashboard` is invoked, **ask clarifying questions first**:

1. Confirm the dashboard slug.
2. Confirm columns and their meanings (don't guess from headers).
3. Ask which metrics should be KPIs.
4. Ask what story the main chart should tell.
5. Ask the time grain if not obvious.
6. Ask whether this should be pipeline-backed (live from CrateDB) or a manual upload dashboard.

The user has a strong design eye. Expect 2–3 rounds of iteration after the first draft.

---

## Things not to do

- Don't add chart libraries beyond Chart.js (no D3, Plotly, ECharts) unless explicitly asked.
- Don't fetch data from URLs at browser runtime — all dashboards are statically generated from data files.
- Don't add tracking, analytics, or external scripts beyond the approved Chart.js CDN.
- Don't change the landing page sections (Operational, Intelligence, AI & Cost, Reference) without asking.
- Don't commit or push without an explicit `/ship` invocation.
- **Never commit `_pipeline/.env`** or any file containing real credentials, passwords, or tokens.
- Don't call Netlify functions from the pipeline — use `_pipeline/lib/publish.mjs` (GitHub API directly) instead. Netlify site-level password protection blocks external callers.
- Don't add new Netlify functions without updating `netlify.toml` if you need a URL alias.
