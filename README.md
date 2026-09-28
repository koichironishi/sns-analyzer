# SNS Analyzer

Collects post data from **Instagram / Facebook / Threads / X** for each client and outputs analysis reports (HTML, PDF, CSV, and AI analysis).
Everything except AI analysis runs on the Python 3.10+ standard library alone.

## Quick start (demo)

```bash
python3 -m snsanalyzer demo --zip
open reports/demo/latest.html
```

## Features

| Feature | Details |
|---|---|
| **Web dashboard** | Browser access with login. **Admins** (full access to all clients — grant only to your own staff) and **users** (view, download, and regenerate reports for assigned clients). User management, operation log, and running report updates, data collection, and AI analysis from the browser |
| **Report pages** | Split into Overview / AI analysis / SNS comparison / Competitor comparison / Posting times / Formats & tags / Top posts. Navigate with the left sidebar (a top tab bar on smartphones). PDF output prints every page in order |
| **Per-client management** | Each client's connection details, database, and reports are kept separate under `clients/<ID>/`. `--all-clients` runs collection or reporting for every client at once, and also creates a client overview page |
| **SNS connection** | `connect meta` (Facebook Page + Instagram), `connect threads` (OAuth), `connect x`. Tokens are converted to long-lived tokens automatically and the account IDs are detected automatically |
| **Connection check** | `status` checks each connection, follower counts, and token expiry. Threads tokens are extended automatically |
| Data collection | Retrieves posts, reactions, and follower counts via the official APIs (`collect`) |
| CSV import | Imports exports from Meta Business Suite / X Analytics and similar tools |
| Analysis | KPIs and comparison with the previous period, cross-platform comparison using the performance index, weekday × time-slot heatmap, post formats, hashtags, and top posts |
| **Competitor comparison** | Compares your accounts with registered competitor accounts on followers, growth, posts per week, reactions per follower, post format mix, strongest formats, common posting slots, and hashtags. Also shows the competitor posts that got the strongest reactions |
| **AI analysis (Claude)** | Reads post text together with the numbers and suggests what is working, specific improvements, post ideas with sample copy, and KPI targets for the next period. You can also ask questions |
| **Download** | In the report: 「PDFで保存・印刷」 (save as PDF / print) and the 「データをダウンロード」 (download data) menu with posts, summary, formats, hashtags, and competitor CSVs plus the AI analysis (Markdown). `export` / `--zip` bundles everything into a ZIP |

## Web dashboard (accounts)

```bash
# 1. Create the first admin (password is entered interactively)
python3 -m snsanalyzer user add admin --role admin --name "Admin Name"

# 2. Create a user who can view specific clients only (asked to change password at first login)
python3 -m snsanalyzer user add hanako --client acme --client shop-b --name "Hanako" --must-change

# 3. Start
python3 -m snsanalyzer serve            # → http://127.0.0.1:8000
```

| | Admin | User |
|---|---|---|
| Clients visible | All | Assigned only |
| Viewing reports, downloading files | ✓ | ✓ |
| Report update, ZIP creation | ✓ | ✓ |
| Data collection, AI analysis (API costs apply) | ✓ | — |
| Adding clients | ✓ | — |

> Admins can see and operate **every** client. Never give the admin role to people at client companies; give them the user role with their own client assigned.
| User management, operation log | ✓ | — |

Account operations are also available from the CLI: `user list` / `user passwd NAME` / `user set NAME --role user --client acme --state disable` / `user remove NAME`.

Security:
- Passwords are hashed with salted scrypt (at least 10 characters, must not contain the username). Changing a password logs out other sessions
- Sessions: HttpOnly / SameSite=Lax cookies, 8 hours idle and 7 days maximum. All form submissions are CSRF-protected
- 5 consecutive login failures lock the account for 15 minutes. Logins, user changes, downloads, and runs are recorded in the operation log
- The last admin cannot be deleted or disabled

## Accessibility

Checked against the Digital Agency Design System (DADS v2.18.0) and WCAG 2.2, with values measured in a real browser (report: all pages, web app: every screen, light and dark modes).

- All text is at least 14px (buttons, navigation, and body text 16px). Text contrast at least 4.5:1; input borders and focus rings at least 3:1
- Buttons, tabs, navigation, and checkboxes have tap targets of at least 44×44px
- Focus ring uses the DADS pattern (dark outline + yellow halo); a skip link to the main content is provided
- Switching report pages moves focus to the page heading and updates the tab title. Esc closes menus
- Charts can also be viewed as tables. The heatmap has a table caption and header associations
- Meaning is never carried by color alone (increase/decrease uses arrow + screen-reader text; insight types use text labels)
- Honors `prefers-reduced-motion` (turns off animations)
- `tests/test_accessibility.py` checks contrast, font sizes, target sizes, and heading structure for regressions

## Web version (Next.js + Supabase)

`web/` is a rebuild of every feature as a Next.js app that shares the MEO console's Supabase project (login and clients) and runs on Vercel.
Apply `supabase/sns.sql` (it only adds `sns_` tables; never run MEO's `schema.sql`), then follow [web/README.md](web/README.md) (Japanese) for environment variables, Meta / Threads / X app setup, and deployment.

## Deploying on the web

To access it over the internet, run it on a server (VPS or cloud VM) with Docker. [Caddy](https://caddyserver.com/) obtains and renews the HTTPS certificate automatically.

```bash
# On the server
git clone <this repository> sns-analyzer && cd sns-analyzer
cp deploy/.env.example .env        # set DOMAIN=sns.example.jp etc.
mkdir -p data && cp config.example.json data/config.json   # enter the Meta / Threads app details
docker compose build
docker compose run --rm app python -m snsanalyzer --config /data/config.json user add admin --role admin
docker compose up -d
```

- Point your domain's DNS (A record) at the server's IP address, and open ports 80 and 443 only
- `scheduler` runs collection and report updates for all clients every day at `COLLECT_AT` (default 09:00)
- Connecting SNS accounts and registering competitors is done with commands on the server:
  `docker compose run --rm app python -m snsanalyzer --config /data/config.json -c acme connect meta`
- Back up the `data/` folder (settings, databases, reports, accounts)
- In production, `--secure-cookies` (HTTPS-only cookies and HSTS) and `--trust-proxy` (read the client IP from the proxy) are enabled
- If you run `serve` directly without Docker, always put it behind an HTTPS reverse proxy (Caddy, nginx, etc.)

## Data deletion and AI analysis consent

### AI analysis consent (per client)
AI analysis sends data to Anthropic (US), so it **does not run until the client's consent is recorded**.

```bash
python3 -m snsanalyzer -c acme consent show                      # status and the explanation to show the client
python3 -m snsanalyzer -c acme consent grant --by "Hanako Yamada (ACME PR)"   # record consent
python3 -m snsanalyzer -c acme consent grant --by "..." --no-post-text        # send aggregate metrics only (no post text)
python3 -m snsanalyzer -c acme consent revoke                    # withdraw (deletes stored AI results)
```

- In the web dashboard, admins use the client's **設定 (Settings)** page. Recording consent requires the name/affiliation of the person who agreed and a confirmation that the explanation was shown
- Consent is stored per client (never inherited from the shared config). The explanation has a version; if it changes, consent must be recorded again
- The report's AI section shows who consented, when, and whether post text was sent

### Data deletion
| What | CLI | Web (Settings page) |
|---|---|---|
| Data older than the retention period (`retention_days`, default 400 days) | Automatic on every `collect`; manual: `purge [--days N]` | 「今すぐ保存期間を適用する」 |
| Posts deleted on the SNS | Automatic on `collect` (posts in the collection window that no longer exist are removed). X only, full check: `sync-deletions` (uses X API credits) | — |
| One platform's data (own + competitors) | `data delete --platform x --scope all` / `disconnect x --delete-data` | Select the platform, type the client ID to confirm |
| One competitor's data | `data delete --competitor "Competitor A"` | Select the competitor |
| Everything for a client (contract end) | `client remove acme` | 「クライアントを削除する」 |
| Meta / Threads deletion requests | — | Register `https://<your domain>/meta/data-deletion` (Meta app → Data deletion callback URL) and `https://<your domain>/threads/data-deletion` (Threads app → Delete callback URL). Requests are verified with the app secret, the matching client data is deleted and disconnected, and a status page URL with a confirmation code is returned |

- Deleting data also deletes reports, ZIPs, and AI results that contain it. The database is compacted (VACUUM) so deleted rows do not remain in the file
- Deletions are recorded in the operation log. Set `public_url` in `config.json` to the public URL used for the deletion status page

### Privacy policy
A privacy policy that matches how this system actually handles data is published at **`/privacy`** (no login required; linked from the login page and the footer of every page).

1. Fill in `privacy_policy` in `config.json`: `service_name`, `operator_name`, `operator_address`, `representative`, `contact` (email or form URL), `established` (and `revised` when updated), `server_location` (country where the server stores data), `org_measures` (your organizational, human, and physical security measures). Also set `public_url` and `retention_days`
2. Unfilled items are shown as 「【要記入】」 with a warning at the top of the page, and `serve` prints a warning at startup. No company details are ever filled in automatically
3. **Have the text reviewed by your legal counsel before publishing.** It covers: operator info, data collected, purposes, third-party provision, sending to Anthropic (US) with the information APPI requires for foreign transfers, relationship with each SNS, retention, deletion (Meta/Threads deletion flow), security measures, cookies and the Chart.js CDN, disclosure requests, and revisions
4. Register `https://<your domain>/privacy` as the Privacy Policy URL in the Meta and Threads app settings

To host it elsewhere (for example your company website), export a standalone HTML file:

```bash
python3 -m snsanalyzer privacy-policy --out reports/privacy.html
```

### Terms of service
Terms of service matching this system's features are published at **`/terms`** (no login required; linked from the login page, the page footer, and the privacy policy).

- Company name and contact are shared with `privacy_policy`. Terms-specific items go in `terms` in `config.json`: `court` (exclusive jurisdiction for the first instance, e.g. 東京地方裁判所), `established`, `revised`
- Covers: scope, definitions (client / user / admin), accounts, SNS connection responsibilities, AI analysis (consent required; output is reference information), prohibited acts (including training AI models on SNS data), data handling and retention, SNS API changes, service changes, disclaimers, limitation of liability (12 months of fees as the cap — **adjust to your contracts**), suspension, data deletion at contract end, anti-social forces, changes under Civil Code Art. 548-4, governing law, and priority of individual contracts
- Unfilled items show as 「【要記入】」 with a warning. **Have it reviewed by your legal counsel before publishing**, and align it with your service contracts
- Standalone HTML for another site: `python3 -m snsanalyzer terms --out reports/terms.html` (links point to `public_url`, or to `privacy.html` next to it)

## Terms, privacy, and legal notes (check before production use)

This section lists points to confirm; it is not legal advice. Items marked **(expert review)** should be confirmed with your legal counsel.

| Topic | What to prepare |
|---|---|
| Meta Platform Terms | Fill in and publish the privacy policy at `/privacy` (see "Privacy policy") and register the data deletion callback implemented at `/meta/data-deletion`. Retention period, deletion on contract end, and deletion on disconnect are implemented (see "Data deletion") |
| Sending data to Claude (Anthropic, US) | Meta Platform Terms 5.a requires a written agreement with service providers; X's Developer Agreement prohibits using X content to train foundation models; Japan's APPI Article 28 (provision to a third party in a foreign country) may apply **(expert review)**. Anthropic's commercial API does not use inputs for training by default and deletes API inputs/outputs within 30 days (with exceptions). AI analysis is blocked until consent is recorded per client (see "AI analysis consent") |
| Competitor data | Limit to public data of business/creator accounts and use it for aggregate comparison only. Whether continuous collection counts as "monitoring/profiling" under Meta terms, and how X content may be shown to clients, needs **(expert review)** |
| X deletion requests | Content deleted on X must be deleted from stored data (within 24 hours per the Developer Policy). `collect` removes deleted posts within the collection window; run `sync-deletions` daily to cover older posts |
| Personal information | Usernames and post text can be personal information when combined with other data. Handle stored data as personal information |
| Trademarks | This tool is not affiliated with or endorsed by Meta Platforms, Inc. or X Corp. Platform names are used only to identify data sources; do not use their logos |

Sources: [Meta Platform Terms](https://developers.facebook.com/terms/), [Meta data deletion callback](https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback/), [Meta Access Verification](https://developers.facebook.com/docs/development/release/access-verification/), [X Developer Agreement](https://docs.x.com/developer-terms/agreement), [X Developer Policy](https://docs.x.com/developer-terms/policy), [PPC APPI Q&A](https://www.ppc.go.jp/personalinfo/faq/APPI_QA/), [Anthropic: model training](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training), [Anthropic: data retention](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data), [Meta trademarks](https://www.meta.com/brand/resources/meta/our-trademarks/)

### Running on an existing server (e.g. alongside another app)

If the server already runs nginx or Caddy on ports 80/443, use `deploy/coexist/` instead of the default `docker-compose.yml` (which includes its own Caddy):

```bash
sh deploy/coexist/check-server.sh                 # read-only: OS, memory, Docker, who uses ports 80/443/8010
mkdir -p data && cp config.example.json data/config.json && sudo chown -R 1000:1000 data
docker compose -f deploy/coexist/docker-compose.yml up -d --build
docker compose -f deploy/coexist/docker-compose.yml run --rm app python -m snsanalyzer --config /data/config.json user add admin --role admin
```

- The dashboard listens only on `127.0.0.1:8010` (change with `SNS_PORT`). Add a **separate subdomain** (e.g. `sns.example.jp`) to your existing web server with `deploy/coexist/nginx-sns.conf` or `deploy/coexist/Caddyfile-sns.snippet`. A separate subdomain keeps login cookies apart from the other app
- nginx must pass `Host` and `X-Forwarded-For` (included in the example); the app relies on them for CSRF checks and login lockout
- Memory is capped at 512 MB per container; keep `data/` separate from the other app and back it up separately

## Setup

### 1. Shared settings

```bash
python3 -m snsanalyzer init      # creates config.json (permissions 600)
```

Fill in `config.json` with the app details shared across all clients.

| Key | Where to get it |
|---|---|
| `meta_app.app_id` / `app_secret` | App on [Meta for Developers](https://developers.facebook.com/apps/) (a Business-type app with Facebook Login and the Instagram Graph API added) |
| `threads_app.app_id` / `app_secret` / `redirect_uri` | The Threads use case in the same app. Set `redirect_uri` to the same URL as the callback registered in the app (for example `https://localhost/callback`) |
| X | Issue a Bearer Token for each client in the [X Developer Portal](https://developer.x.com/) |

### 2. Add a client

```bash
python3 -m snsanalyzer client add acme --name "ACME Inc." --brand "BtoB SaaS. Main goal is generating document downloads"
python3 -m snsanalyzer client list
```

`--brand` is used as background information for AI analysis (you can also edit `ai.brand_context` in `clients/acme/config.json`).

### 3. Connect the SNS accounts

After this step, run every command against one client by adding `-c <ID>` (or setting the environment variable `SNS_CLIENT=acme`).

```bash
# Facebook Page + Instagram (together)
python3 -m snsanalyzer -c acme connect meta
#  → Open the URL shown and issue a token in Graph API Explorer with the required permissions, then paste it.
#    It is converted to a long-lived token, and the Page and its linked Instagram business account are detected and saved.
#    The Page token does not expire.

# Threads (OAuth)
python3 -m snsanalyzer -c acme connect threads
#  → Open the URL shown, log in with the client's Threads account, and grant access.
#    Paste the full URL of the page you are redirected to (even if it shows an error page).
#    Saved as a long-lived token (60 days). It is extended automatically during collect.

# X
python3 -m snsanalyzer -c acme connect x --username acme_official
#  → Enter the Bearer Token (input is hidden)

# Check the connections
python3 -m snsanalyzer -c acme status
python3 -m snsanalyzer status --all-clients
```

If the client does the authorization themselves, send them the URL printed by `connect threads` and have them send back the redirect URL. For Meta, one approach is to have the client grant you permissions on the Page in their Business Manager.

Permissions (scopes) required:
- Meta: `pages_show_list`, `pages_read_engagement`, `read_insights`, `instagram_basic`, `instagram_manage_insights`
  (if the Page role was granted through Business Manager, also `ads_read` or `ads_management`)
- Threads: `threads_basic`, `threads_manage_insights` (competitor follower counts additionally need `threads_profile_discovery`)
- To connect accounts owned by other businesses (your clients), the Meta app must complete **Business Verification → App Review (Advanced Access) → Access Verification (Tech Provider)**. Without these, client accounts cannot be connected in production.

## Usage

```bash
# Collect data
python3 -m snsanalyzer -c acme collect                 # posts from the last 60 days (metrics are updated too)
python3 -m snsanalyzer collect --all-clients           # all clients

# Report (last 30 days vs. the previous 30 days)
python3 -m snsanalyzer -c acme report
python3 -m snsanalyzer -c acme report --days 7 --zip   # also create a ZIP (HTML + CSVs + AI analysis)
python3 -m snsanalyzer report --all-clients            # all clients + clients/index.html

# AI analysis (Claude)
python3 -m snsanalyzer -c acme ai
python3 -m snsanalyzer -c acme ai --question "Should we post more Reels?"
python3 -m snsanalyzer -c acme report --ai             # include AI analysis in the report

# Downloads (ZIP bundle)
python3 -m snsanalyzer -c acme export
python3 -m snsanalyzer export --all-clients

# Other
python3 -m snsanalyzer -c acme import-csv export.csv --platform facebook --followers 8600
python3 -m snsanalyzer -c acme followers --platform threads --count 2100 --date 2026-09-01
python3 -m snsanalyzer -c acme disconnect x
python3 -m snsanalyzer refresh --all-clients           # extend Threads tokens
```

Without `-c`, everything runs against the default workspace (`config.json` / `data/sns.db` / `reports/`), the same as before.

### Output files

```
clients/acme/reports/
  latest.html                      Latest report (always overwritten)
  report_2026-09-28_30d.html       Report for this period
  report_2026-09-28_30d.zip        report.html / posts.csv / summary.csv / media_types.csv /
                                   hashtags.csv / ai_analysis.md / data.json
  ai_2026-09-28_30d.json           AI analysis result (reused for later reports of the same period; the API is not called again)
clients/index.html                 Client overview (report --all-clients)
```

- **PDF**: the 「PDFで保存・印刷」 button in the report sidebar → choose "Save as PDF" in the print dialog (a print layout is included).
- **CSV**: UTF-8 with BOM, so it opens in Excel without garbled characters.

## Competitor comparison

```bash
# Register competitors (running the same name again adds more platforms to it)
python3 -m snsanalyzer -c acme competitor add "Competitor A" --instagram rival_a --x rival_a --threads rival_a
python3 -m snsanalyzer -c acme competitor add "Competitor B" --instagram rival_b --facebook RivalBPage
python3 -m snsanalyzer -c acme competitor list

# collect now fetches competitors too (--no-competitors to skip)
python3 -m snsanalyzer -c acme collect
python3 -m snsanalyzer -c acme report      # adds a "Competitor comparison" section to the report
```

Competitor data is fetched **using your own connection for that platform** (for example, Instagram competitors require your own Instagram to be connected).

| SNS | What can be fetched | Notes |
|---|---|---|
| Instagram | Followers, posts (likes, comments, format, text) | Business Discovery API. The competitor must be a business or creator account. For posts with hidden like counts, likes are counted as 0 |
| X | Followers, posts (likes, replies, reposts, quotes, bookmarks) | Pay-per-use X API credits (charged per request) |
| Threads | Followers only | Requires the `threads_profile_discovery` permission. With standard access only Meta's official accounts (@meta, @threads, etc.) can be looked up, so App Review for advanced access is needed. Public profiles with 100+ followers only, 1,000 lookups per 24 hours. The official API does not provide engagement metrics for other accounts' posts |
| Facebook | Followers only (conditional) | Requires Meta review (Page Public Content Access). Before that, use manual entry |

Anything the API can't fetch can be added manually:

```bash
python3 -m snsanalyzer -c acme followers --platform facebook --count 12000 --competitor "Competitor B"
python3 -m snsanalyzer -c acme import-csv rival_posts.csv --platform threads --competitor "Competitor A"
```

- **Fair comparison:** because only public figures are available for competitors, your own accounts are also measured on **public reactions only** (Instagram = likes + comments; X and Threads = likes + replies + reposts + quotes; Facebook = reactions + comments + shares). Your own saves and shares are excluded from this comparison.
- **Follower growth:** competitors' follower history builds up from the day collection starts, so run `collect` daily.
- `competitor remove` only takes a competitor out of the comparison. Data already collected is kept.
- When competitors are registered, the AI analysis also returns "What we can learn from competitors".

## AI analysis (Claude)

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
.venv/bin/python -m snsanalyzer -c acme ai
```

- Model: `claude-opus-5` (can be changed with `ai.model` / `ai.effort` in `config.json`)
- Input: aggregate figures plus the text and metrics of up to 200 posts in the period (the top and bottom posts by performance index take priority)
- Output: overall assessment, evaluation of each platform, what works in the post content (with supporting evidence), prioritized recommendations, post ideas (with sample copy), and KPI targets for the next period
- **Note:** post text and figures are sent to the Anthropic API. Check your client contracts before using it.
- Cost: roughly several tens of thousands of input tokens and several thousand output tokens per run (usage is shown after each run)

## Run automatically every day (macOS / cron)

```bash
crontab -e
# 9:00 every day: collect for all clients → refresh reports
0 9 * * * cd "/Users/koichiro/Documents/Claude Code/SNS" && /usr/bin/env python3 -m snsanalyzer collect --all-clients && /usr/bin/env python3 -m snsanalyzer report --all-clients >> clients/cron.log 2>&1
```

## Structure

```
snsanalyzer/
  collectors/     API collectors for each platform
  connect.py      Token acquisition, long-lived token conversion, refresh, connection check
  config.py       Shared and per-client settings
  importers.py    CSV import
  db.py           SQLite (posts, per-day metric history, follower snapshots)
  analysis.py     KPIs, performance index, heatmap, automatic commentary
  compare.py      Competitor comparison (compared on public metrics)
  ai.py           AI analysis with Claude (structured output)
  export.py       CSV / Markdown / ZIP export
  report.py       HTML report and client overview
  auth.py         Accounts, authentication, sessions (scrypt, CSRF, login lockout)
  web.py          Web dashboard (standard library HTTP server)
  ui.py           Shared design tokens and components (used by both the report and the web UI)
  cli.py          Command line
tests/            python3 -m unittest discover -s tests
```

### Metric definitions

- **Engagement** = likes/reactions + comments/replies + shares/reposts + saves/bookmarks + quotes
- **ER (per follower)** = engagement ÷ follower count at the time of posting / **ER (per view)** = engagement ÷ views
- **Performance index** = a post's engagement ÷ the median for that platform in the period × 100 (100 = a typical post)

### Security

- `config.json` and `clients/*/config.json` contain tokens. They are saved with permissions 600 and excluded by `.gitignore`.
- Environment-variable token overrides (`SNS_X_BEARER_TOKEN`, etc.) apply only when no client is specified (to prevent one client's token being used for another).
