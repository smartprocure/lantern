# Lantern data pipeline

Queries CrateDB and commits data files directly to GitHub so dashboards refresh automatically. The pipeline talks to GitHub's REST API directly — it does **not** go through any Netlify function (Netlify site-level password protection would block external callers).

## Prerequisites

- Node.js 18+
- Network access to CrateDB (your machine must be on the cluster allowlist)
- A GitHub personal access token with `repo` write access to `mbeard-collab/lantern`
- The values for `CRATE_USER`, `CRATE_PASSWORD`, and `PIPELINE_SECRET` (ask Matt)

## Setup

```bash
cp _pipeline/.env.example _pipeline/.env
# Fill in the values — ask Matt for credentials
```

`.env` is gitignored. **Never commit it.** If you accidentally expose credentials, rotate them immediately.

### `.env` fields

| Variable | Description |
|---|---|
| `CRATE_URL` | CrateDB HTTP endpoint, e.g. `https://govspend-production.aks1.eastus2.azure.cratedb.net:4200/` |
| `CRATE_USER` | Read-only CrateDB username (`mcp_reader`) |
| `CRATE_PASSWORD` | CrateDB password |
| `PIPELINE_SECRET` | Token used to authenticate pipeline calls — must match `PIPELINE_SECRET` in Netlify env vars |
| `GITHUB_REPO` | `mbeard-collab/lantern` |
| `GITHUB_TOKEN` | GitHub PAT with repo write access |
| `PIPELINE_ANTHROPIC_KEY` | Anthropic API key for optional narrative generation (leave blank to skip) |
| `SITE_URL` | `https://govspend-ops-dashboards.netlify.app` (for reference only — not used by the pipeline) |

## Running the pipeline

```bash
# Dry run — run queries, print output to stdout, commit nothing
node _pipeline/refresh.mjs <slug> --dry-run --no-narrative

# Local test — write the output file to the working tree (for testing with `netlify dev`)
node _pipeline/refresh.mjs <slug> --local --no-narrative

# Full run — commit data file to GitHub, trigger Netlify deploy
node _pipeline/refresh.mjs <slug> --no-narrative

# With narrative (requires PIPELINE_ANTHROPIC_KEY)
node _pipeline/refresh.mjs <slug>
```

The `<slug>` must match both a folder in the repo root (e.g. `sales2/`) and a query module in `_pipeline/queries/<slug>.mjs`.

## How it works

1. `refresh.mjs` loads `_pipeline/queries/<slug>.mjs`
2. Calls the module's default export `runQuery({ query })` — `query` is `crate.mjs`'s `query` function
3. Serialises the result using the module's `formatOutput` (or the standard JSON envelope if not provided)
4. Calls `_pipeline/lib/publish.mjs` which PUTs each file to `https://api.github.com/repos/<GITHUB_REPO>/contents/<slug>/<filename>`
5. GitHub triggers a Netlify deploy; the updated data file is live in ~30 seconds

## Adding a new pipeline-backed dashboard

### 1. Create `_pipeline/queries/<slug>.mjs`

Required exports:

```js
// Name of the output file inside the dashboard folder
export const outputFile = 'sales_data.js';

// How to turn the query result into a file string.
// Omit this to use the standard JSON envelope (dashboard then fetches ./data.json).
export const formatOutput = (data) => `window.GS_SALES = ${JSON.stringify(data)};\n`;

// The query function — receives { query } which is crate.mjs's query()
export default async function runQuery({ query }) {
  const result = await query(`SELECT ... FROM analytics.my_table WHERE ...`);
  // result.rows is an array of row objects keyed by column name (lowercased aliases)
  return { /* data shape for the dashboard */ };
}
```

### 2. Build the dashboard HTML

Copy `_template/dashboard.html` to `<slug>/index.html`. Load data from the sibling file:

```html
<!-- JS global approach (used by sales2/, usage-data/) -->
<script src="./sales_data.js"></script>
<script>
  const data = window.GS_SALES;
</script>

<!-- JSON fetch approach (used by standard dashboards) -->
<script>
  const { data } = await fetch('./data.json').then(r => r.json());
</script>
```

Always include a graceful fallback for when the data file doesn't exist yet (first run, or deploy lag).

### 3. Test

```bash
node _pipeline/refresh.mjs <slug> --dry-run --no-narrative   # see the output
node _pipeline/refresh.mjs <slug> --local --no-narrative      # write to disk
node _pipeline/refresh.mjs <slug> --no-narrative              # commit to GitHub
```

### 4. Register on the landing page

Add an entry to the `DASHBOARDS` array in `index.html`. See `CLAUDE.md` for field descriptions.

## CrateDB quirks

- **Column aliases are lowercased** by CrateDB unless quoted with double quotes.
  Write `MAX(day) AS maxday` (lowercase), not `AS maxDay`, or `AS "maxDay"` if you need camelCase.
- **Reserved keywords** need double-quoting: `doc."user"`, `"Owner"`, `"Name"`.
- **Object field access:** use `"Owner"['Name']` (bracket notation), not dot notation.
- **Account ID length mismatch:** `salesforceopportunity.AccountId` is 18 chars; `salesforceaccount.Id` is 15 chars. Join with `LEFT(o."AccountId", 15) = a."Id"`.
- **`crate.mjs` only allows SELECT and WITH** — it rejects any other statement type.
- **Timeout:** 30 seconds per query. Break slow queries into parallel sub-queries if needed.

## Existing query modules

| Module | Output file | Dashboard |
|---|---|---|
| `usage-data.mjs` | `usage_data.js` | `usage-data/` — 8 parallel queries for org/user token analytics |
| `sales2.mjs` | `sales_data.js` | `sales2/` — open pipeline opps + 2-year closed-won history |
| `renewal-manager-dashboard.mjs` | `data.json` | `renewals/` — legacy stub (Evan's Python pipeline is the real source) |

## Scheduling

The pipeline is designed to run from a developer's machine (or any server with CrateDB network access). To schedule it on macOS with launchd:

```bash
# Run once right now
node _pipeline/refresh.mjs usage-data --no-narrative
node _pipeline/refresh.mjs sales2 --no-narrative

# To schedule daily, create a launchd plist at:
# ~/Library/LaunchAgents/com.govspend.lantern-refresh.plist
# See the launchd documentation or ask Claude Code to generate one.
```

**Note:** CrateDB network access is required — the machine running the pipeline must be on the cluster allowlist (Matt's laptop and the GovSpend office network are pre-approved; CI/CD would require a static IP or VPN).
