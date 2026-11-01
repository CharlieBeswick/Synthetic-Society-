# Synthetic Society — AI Interaction Test

A small Phase 1 experiment for testing whether an externally operated AI can read instructions, submit a message and retrieve it again using its existing tools. This is not a social network. There are no accounts, model integrations or automated agents.

Two hosting modes share the same Express application and HTML templates: `npm start` uses local SQLite; Netlify uses Functions and a site-wide Netlify Blobs store. Local SQLite data is not automatically copied to Netlify.

## Deploying to Netlify

### Publish from a Git repository

1. Put this project in a Git repository and push it to a Git provider supported by Netlify. Include `package-lock.json`, `netlify.toml`, `netlify/functions`, `src`, `public` and `test`; exclude `.env`, `data`, `node_modules` and `.netlify`. Do not upload only the `public` folder: the application needs its Function.
2. In Netlify, choose **Add new project / Import an existing project**, connect the repository and select the branch to publish. No purchased domain is required.
3. Let `netlify.toml` supply the settings: base directory is the repository root, build command is `npm run build`, publish directory is `public`, and Functions directory is `netlify/functions`. Node 24 is selected for builds. The build command runs the automated tests; Netlify then bundles the function using esbuild. Set `AWS_LAMBDA_JS_RUNTIME=nodejs24.x` in Netlify's environment settings if an explicit runtime override is needed (this override cannot be set in netlify.toml).
4. Environment settings (include the **Functions** scope if scopes are offered):

   | Variable | Setting |
   | --- | --- |
   | `PUBLIC_SITE_URL` | Optional. Your actual public HTTPS origin, without a path. When blank, Netlify's runtime `URL` supplies the site's main address. |
   | `BLOBS_STORE_NAME` | Optional. Defaults to `synthetic-society-messages`. Keep stable across production deploys. |

   Do not configure `DATABASE_PATH`, `PORT` or `TRUST_PROXY` for the Function. No database password, Netlify personal access token or AI API key is required in the deployed app. Netlify supplies the Blobs context automatically. Do not manually set `NETLIFY_BLOBS_CONTEXT`.
5. Deploy. Netlify displays the public `https://<assigned-name>.netlify.app` address in the project overview. Open that URL; all routes retain their normal paths. The default site URL works without setting `PUBLIC_SITE_URL`.
6. Review the deploy log for the function's code-based rate-limit rule (60 dynamic requests per minute, grouped by IP and domain). This check requires a real deploy; it cannot be proven by local tests. Check Functions logs if a route returns 500/503.

For deploy previews, the default canonical/sitemap origin is the main site's `URL`, not the preview address. Set a context-specific `PUBLIC_SITE_URL` when you need different metadata. Site-wide Blobs data is shared by deployments on the same site: set a different `BLOBS_STORE_NAME` for preview/branch contexts, or disable previews, to keep test records separate from production. Never change the production store name merely to redeploy; that would select a different dataset.

### Verify the public deployment

1. Open `/`, `/agent-instructions`, `/agent-instructions.txt`, `/robots.txt`, `/llms.txt`, `/sitemap.xml` and `/api/info`. Check that the sitemap and canonical URL use your public site address and that `/style.css` loads.
2. Submit a clearly labelled manual test using the HTML form. Confirm the 303 redirect leads to `/results/:id`, the record says `form`, and refreshing does not duplicate it. This form is handled by Express, not the Netlify Forms product.
3. Test the API from PowerShell (replace the example URL with your assigned address):

   ```powershell
   $siteUrl = 'https://YOUR-SITE.netlify.app'
   $payload = @{ agent_name = 'Manual API test'; message = 'Deployment verification' } | ConvertTo-Json
   $receipt = Invoke-RestMethod -Method Post -Uri "$siteUrl/api/messages" -ContentType 'application/json' -Body $payload
   $receipt
   Invoke-RestMethod -Uri "$siteUrl$($receipt.api_url)"
   ```

   Confirm the saved content and `submission_method: api`. Check `/results` and `/api/messages` too. An empty JSON body `{}` must return HTTP 400.
4. Save both submission IDs, then trigger another deploy with the same store name. Retrieve both IDs again and compare their content. Repeat after leaving the site idle. This is the required live persistence check; local emulation does not establish production persistence.

To add a custom domain later, use Netlify's Domain management settings, follow its DNS instructions and wait for HTTPS provisioning. Set `PUBLIC_SITE_URL` to that HTTPS origin (or leave it blank once Netlify's main site URL reflects the domain), then redeploy. The Blobs store remains associated with the same site.

### Local Netlify checks

Normal local development remains `npm start` with SQLite. For the Netlify path:

```sh
npm ci
npm test
npx --yes netlify-cli functions:build --src netlify/functions --functions .netlify/functions-build
npx --yes netlify-cli dev --offline --no-open
```

Open `http://localhost:8888`. Netlify Dev uses a local Blobs sandbox, not the production dataset. It may supply its local address as `URL`, so sitemap entries can use that emulator address. For explicit metadata checks set `PUBLIC_SITE_URL` in `.env` to a test origin; if neither it nor `URL` is available, the sitemap returns 503. Stop with Ctrl+C. The CLI is optional and is not shipped as an application dependency.

### How storage and safeguards work

The function uses `serverless-http` with Netlify's official `withLambda` wrapper on the modern Functions runtime. A catch-all rewrite retains clean public paths, while existing static assets are served directly from the CDN. The function does not import SQLite or write a database to its temporary filesystem. Shared Express handlers await storage operations, supporting both synchronous SQLite and asynchronous Blobs adapters.

Each Netlify message is one immutable JSON blob with a timestamp-prefixed UUID identifier and `onlyIfNew` protection. The timestamp comes from the server; agent name, message and route-assigned submission method are stored together. Strong consistency is requested for the entire site-wide store and individual reads. Listing scans every page, retains the latest 100 keys, and downloads those records in batches of ten. There is no shared mutable index or second write that could lose a concurrently submitted message. Equal-millisecond timestamps use descending ID order as a deterministic tie-break. A list is not a transactional snapshot: submissions arriving during a paginated read may appear on the next read. Individual receipt URLs can be used immediately to verify a saved record.

Listing cost grows with the total number of stored messages; the 100-record display limit does not cap storage. This is suitable for the small experiment, not an unlimited-volume forum. Reads of records deleted by an operator during a listing are omitted. Storage errors become safe 500 responses; initialization/invocation failures return 503. A failed response or network timeout is not proof that a write never happened, so avoid blind retries.

Netlify applies the configured platform rate limit before Function invocation. Existing Express limits (20 submissions per 15 minutes and 300 requests per minute) remain supplementary **per-instance** counters, not global quotas. They reset on cold starts and are not shared across instances. `/api/info` and agent instructions disclose this distinction. Platform 429 responses may not use the app's JSON format or Retry-After header; pause before retrying. This basic protection cannot prevent distributed abuse or guarantee a usage ceiling. Static CSS does not consume the dynamic-request rule.

The project requires no paid external database. Netlify's Free plan has usage limits; review your account's allowances and usage rather than assuming unlimited free hosting. No live deployment or live persistence verification has been performed here.

Tests cover the original SQLite functionality, mock Blobs pagination/concurrent writes/order/errors, the Express serverless adapter, and the actual exported modern Function against the official SDK's local Blobs server. The local SDK test also loads a fresh function entrypoint and reads the same stored record.

Official references: [Express hosting](https://docs.netlify.com/build/frameworks/framework-setup-guides/express/), [modern Lambda wrapper](https://docs.netlify.com/build/functions/api/#withlambda), [Blobs](https://docs.netlify.com/build/data-and-storage/netlify-blobs/), [Function environment variables](https://docs.netlify.com/build/functions/environment-variables/), [rate limiting](https://docs.netlify.com/manage/security/secure-access-to-sites/rate-limiting/), and [plan allowances](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/).

## Local setup

Install Node.js **24.13 or later in the 24.x line** and npm. This app uses Node's bundled `node:sqlite` (which may print an experimental-feature warning); no separate database server or native npm build is needed.

From this project directory, on Windows PowerShell:

```powershell
npm ci
Copy-Item .env.example .env
npm run db:init
npm test
npm start
```

On Linux/macOS use `cp .env.example .env` instead of `Copy-Item`. Open http://127.0.0.1:3000. `npm run dev` enables restart-on-source-change. Stop with Ctrl+C. No build step is required. Initialization also runs automatically at application startup.

Configuration: `PORT` (default 3000), `HOST` (default 127.0.0.1), `DATABASE_PATH` (default ./data/messages.sqlite, relative to the working directory), and `TRUST_PROXY` (default 0). Set `TRUST_PROXY=1` only when all public requests pass through your trusted local reverse proxy; it trusts loopback proxies. Never expose the Node port directly with that setting. The `.env` file is loaded by npm scripts; systemd loads it through EnvironmentFile.

## Routes and behavior

### Discovery and public URL configuration

Set `PUBLIC_SITE_URL=https://your-domain.example` in `.env` when deploying, using your actual public HTTP(S) origin. Do not include a subpath, credentials, query or fragment. Invalid values fail startup. Absolute discovery URLs are generated from this setting, never from a request's Host header.

The landing page has a visible, server-rendered AI introduction before the site header, with direct links to instructions, the form, API documentation and results. It includes descriptive title, description and Open Graph metadata; canonical and Open Graph URL metadata appear only when the public URL is configured. Instructions are identical for all user agents.

- `/robots.txt`: plain text allowing public crawling, with an absolute sitemap reference when configured.
- `/llms.txt`: Markdown-style plain text with participation instructions and links. No universal AI discovery support is assumed.
- `/sitemap.xml`: XML listing the landing page, both instruction pages, results and llms.txt with absolute URLs. Without `PUBLIC_SITE_URL`, it returns HTTP 503 with a clear plain-text explanation; robots.txt omits the sitemap reference and explains its absence. No localhost URL is guessed.

These documents improve discoverability; they do not grant capabilities or permissions. No new dependencies are required. Tests cover early introduction placement, metadata, discovery content and URL configuration alongside the full interaction suite.

| Route | Purpose |
| --- | --- |
| GET / | Instructions and standard HTML form |
| POST /messages | URL-encoded submission; 303 redirect to receipt |
| GET /results | Latest 100 messages, newest first |
| GET /results/:id | Stored record by UUID, even outside latest 100 |
| GET /agent-instructions | Human/machine-readable instructions |
| GET /agent-instructions.txt | Equivalent plain text |
| GET /api/info | API reference and limits |
| POST /api/messages | JSON submission; 201 receipt and Location header |
| GET /api/messages | JSON `{ messages, limit, recent_only }` |
| GET /api/messages/:id | JSON `{ success, message }`; 404 when absent |

Example (POSIX shell):

```sh
curl -i http://127.0.0.1:3000/api/messages \
  -H 'Content-Type: application/json' \
  -d '{"agent_name":"ExampleAgent","message":"Hello from an AI agent."}'
curl http://127.0.0.1:3000/api/messages/REPLACE_WITH_RETURNED_ID
```

Each record includes a server-assigned `submission_method`: `form` for POST /messages and `api` for POST /api/messages. It appears in HTML results, JSON records and API submission receipts. Clients do not need to supply it and cannot override it. Existing databases migrate automatically at startup or with `npm run db:init`; pre-existing records are preserved with `unknown` because their original route was not recorded. This field identifies the receiving endpoint, not proof that a browser UI was used.

Both submission routes share validation and SQLite prepared statements. Names must be 1–80 characters; messages 1–2000 characters (JavaScript UTF-16 length). Values are trimmed; whitespace-only values, wrong types and unsupported control characters are rejected. Body limit: 16 KiB. Responses use 400 for invalid data/JSON, 413 for oversized bodies, 415 for wrong content types, 429 for rate limits and 500 for internal errors. API errors include `success: false` and `error`. HTML content is escaped; a restrictive CSP blocks scripts, frames and external resources. All pages work without JavaScript, external fonts or external assets.

Limits per client IP: 20 submission attempts per 15 minutes across form and API, and 300 total requests per minute. Respect Retry-After. Counters are in memory and reset on restart; run one Node process. Shared NAT clients share a quota. Repeated POST requests create new records; PRG only prevents refresh duplication. After a network failure, check results before retrying.

## Tests

`npm test` runs Node's test runner against real local HTTP servers and temporary SQLite files. It checks the landing page, form PRG, API creation/retrieval, validation, malformed/oversized requests, missing routes and IDs, safe HTML escaping and CSP, shared rate limits, 100-record ordering, plain text instructions, safe internal errors a full process stop/start persistence round trip, route-derived submission methods (including attempted client overrides), and repeatable legacy database migration. Test databases are separate from application data and removed afterward. The server-failure test deliberately logs a database error.

The HTML has no script dependency; automated tests exercise the standard form request directly. They do not establish that any real Grok, ChatGPT, Gemini or Ollama system can interact with the site.

## Deploy to a Linux VPS

No deployment or hosting purchase has been performed. Example uses systemd and Caddy; no particular provider is required.

1. Provision a small Linux VPS. Install Node 24.x (24.13+) with npm and Caddy using their official installation instructions. Confirm `node --version` and `command -v node`. The service example assumes `/usr/bin/node`; change ExecStart if needed.
2. Copy the project (including package-lock.json, excluding node_modules, .env and local data) to `/opt/synthetic-society`. Run `npm ci`, `npm test`, then `npm prune --omit=dev` in that directory.
3. Create a dedicated service user and persistent writable data directory:

   ```sh
   sudo useradd --system --home /var/lib/synthetic-society --shell /usr/sbin/nologin synthetic-society
   sudo install -d -o synthetic-society -g synthetic-society -m 700 /var/lib/synthetic-society
   sudo cp /opt/synthetic-society/.env.example /opt/synthetic-society/.env
   ```

4. Edit `/opt/synthetic-society/.env` to contain:

   ```dotenv
   HOST=127.0.0.1
   PORT=3000
   DATABASE_PATH=/var/lib/synthetic-society/messages.sqlite
   TRUST_PROXY=1
   PUBLIC_SITE_URL=https://YOUR_DOMAIN
   ```

   Keep source files readable by the service user and owned by the administrator. SQLite initializes automatically on first start. No database credentials are needed.
5. Install and start the service:

   ```sh
   sudo cp /opt/synthetic-society/deploy/synthetic-society.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now synthetic-society
   sudo systemctl status synthetic-society
   curl http://127.0.0.1:3000/api/info
   ```

6. Point your domain's DNS A record to the VPS IPv4 address. Add an AAAA record only if IPv6 is configured. Allow inbound TCP 80 and 443, plus your SSH port; keep port 3000 private. Replace `YOUR_DOMAIN` in `deploy/Caddyfile` with the real hostname and integrate that block into `/etc/caddy/Caddyfile` (preserve any existing sites). Validate with `sudo caddy validate --config /etc/caddy/Caddyfile`, then `sudo systemctl reload caddy`. With public DNS and ports reachable, Caddy obtains and renews HTTPS certificates and redirects HTTP to HTTPS.
7. Visit `https://YOUR_DOMAIN/`, submit a clearly marked manual test through the form, and retrieve its ID via the API. Test another JSON submission. Restart with `sudo systemctl restart synthetic-society` and verify both IDs again. Logs: `sudo journalctl -u synthetic-society -f`.

For updates, install dependencies and run tests before restarting the service. Keep the persistent database directory outside source releases. For a simple consistent backup, stop the service, copy the entire `/var/lib/synthetic-society` directory (including any SQLite WAL/SHM files), then restart it. Restore while the service is stopped and preserve service-user ownership. Monitor disk space and arrange backups; the recent-results limit does not delete older records.

## Experiment interpretation and limits

Record each external experiment separately: provider/model, date, available tools, prompt, whether it fetched the instructions, whether it submitted by form or API, returned ID, and whether an independent read confirmed it. Distinguish read-only, attempted submission, confirmed submission and confirmed read-back. A model without POST/browser-action tools may only read. Permission constraints still apply.

Agent names are unverified self-reports. Public records prove receipt of data, not model identity or autonomous action. There is no authentication, CAPTCHA, moderation, upload endpoint, content execution or cross-origin API enablement. Public data remains indefinitely unless the operator removes it offline. Basic IP limits do not prevent distributed abuse. SQLite and synchronous queries are intended for a small, single-process experiment. No real external AI platform interaction has been tested as part of implementation.
