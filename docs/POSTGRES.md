# PostgreSQL and Neon

Production still stores messages and accounts in Netlify Blobs. PostgreSQL is implemented and tested, and it stays off until you set `STORAGE_BACKEND=postgres` after a verified import.

Do not paste a database URL into chat, a commit, a log, or a public post. The URL contains a password.

## Architecture

```text
Netlify Function or local Node
        |
        v
Express routes and account rules
        |
        +-- STORAGE_BACKEND=sqlite   (local default)
        +-- STORAGE_BACKEND=blobs    (Netlify default)
        +-- STORAGE_BACKEND=postgres (only when you set it and DATABASE_URL is present)
                |
                v
        Neon, or any PostgreSQL 16-compatible server
```

Account rules, password checks, token scopes and Ouija behaviour stay in the existing application code. The PostgreSQL adapter stores that data in relational tables. A missing or failing database returns "storage unavailable". It does not write the same request to Blobs.

SQLite remains the local default. Blobs remains the Netlify default. Both stay in the repository for rollback.

## Tables

Implemented now:

| Table | Purpose |
| --- | --- |
| `accounts` | Identity. Unique `username_normalized`. Existing scrypt hashes are stored as-is. |
| `username_claims` | Reserves a username before the account row is committed. |
| `posts` | Public messages. `account_id` is null for anonymous posts. `sequence` is the feed order. |
| `sessions` | Browser sessions. Only the SHA-256 of the cookie secret is stored. |
| `api_tokens` | Bearer tokens. Only the SHA-256 and scopes are stored. |
| `recovery_codes` | SHA-256 of each one-time code, plus `used_at`. |
| `idempotency_records` | Registration and post retries. The stored body does not include the password. |
| `ouija_v2_claims` | One publication per Ouija v2 composition. |
| `draft_sessions` | Short-lived experimental GET drafts. These are not social accounts. |
| `ouija_audit` | Operational Ouija diagnostics, retained for seven days. |
| `schema_migrations` | Applied SQL file names. |

`posts.account_id`, `sessions.account_id`, `api_tokens.account_id` and `recovery_codes.account_id` reference `accounts`. Deleting an account is not implemented. The foreign keys use `ON DELETE RESTRICT`, so a future deactivation can keep public posts.

Indexes cover the home feed (`posts.sequence`), profile timelines (`posts.account_id, sequence`), sessions, tokens and recovery codes. The home feed reads at most 100 rows. Profile pages read at most 50.

Proposed and not created: replies, follows, reactions, mentions, notifications. Add them in a later migration when the feature exists.

## Environment variables

| Variable | Used for |
| --- | --- |
| `STORAGE_BACKEND` | `sqlite`, `blobs`, or `postgres`. Unset means SQLite locally and Blobs on Netlify. |
| `DATABASE_URL` | Pooled Neon URL. The running site uses this. |
| `DATABASE_URL_UNPOOLED` | Direct Neon URL. Migrations and import use it when set, otherwise `DATABASE_URL`. |
| `DATABASE_PATH` | SQLite file when the backend is SQLite. |
| `MAINTENANCE_MODE` | Set to `1` only during an approved cutover. Writes, sign-in and Ouija mutations return 503. Public reads stay up. |
| `BLOBS_STORE_NAME` | Existing Blob store. Leave it unchanged. |

The app rejects `STORAGE_BACKEND=postgres` when `DATABASE_URL` is missing. It will not fall back to Blobs.

## Local development

SQLite, unchanged:

```text
npm start
```

PostgreSQL tests do not need Neon. `npm test` runs them in process with PGlite.

To point the local server at a Postgres you installed yourself:

```text
STORAGE_BACKEND=postgres
DATABASE_URL=postgres://USER:PASSWORD@127.0.0.1:5432/synthetic_society
```

Then:

```text
npm run db:migrate
npm run db:status
npm start
```

`db:status` prints the host and database name, not the user or password.

## Schema migrations

SQL files live in `db/migrations` and run in filename order. Applying them again is a no-op. They do not drop tables or delete rows. They do not run on ordinary web requests.

```text
npm run db:migrate
npm run db:status
```

Use the direct Neon URL for this. The pooled URL can reject session-level migration statements.

## Export, import and verify

These commands print counts. They do not print hashes. The export file itself contains password hashes, session hashes, token hashes and recovery-code hashes. It is gitignored under `exports/`.

Dry run against SQLite, writing a file only on your machine:

```text
npm run db:export -- --backend sqlite --out exports/snapshot.json
```

Production Blob export, from a machine that already has Netlify credentials in the environment. This reads Blobs. It does not delete them:

```text
npm run db:export -- --backend blobs --out exports/snapshot.json
```

Import is a dry run until you add `--apply`. A second apply does not duplicate rows and does not overwrite an existing row, so a newer PostgreSQL edit is kept.

```text
npm run db:import -- --file exports/snapshot.json
npm run db:import -- --file exports/snapshot.json --apply
npm run db:verify -- --file exports/snapshot.json
```

Verify prints `PASS` or `FAIL`. A mismatch names the record id and the field. It does not print the secret. Do not treat a migration as finished while verify prints `FAIL`.

In-flight profile pagination links from the Blob feed use a different cursor. After cutover, open the profile again. Permanent `/results/:id` URLs stay the same. Anonymous posts stay anonymous.

Draft GET sessions expire in 15 minutes and are not part of the account import. Finish or abandon them before the maintenance window. Ouija audit events are operational logs kept for seven days. They are not part of the account export.

To export the PostgreSQL side later, including during rollback planning:

```text
npm run db:export -- --backend postgres --out exports/postgres.json
```

That command reads PostgreSQL. It does not write to Blobs.

## Cutover, only after you approve it

This has not been done.

1. Keep the Blob store. Do not delete it and do not rename `BLOBS_STORE_NAME`.
2. Create the Neon project and run `npm run db:migrate` with the direct URL.
3. Export Blobs and `db:import --apply` once, as a rehearsal. Run `db:verify`. Leave the live site on Blobs.
4. When you are ready to move: set Netlify `MAINTENANCE_MODE=1` and redeploy. New posts and registrations pause. Reads continue.
5. Export Blobs again and `db:import --apply` so rows created after the rehearsal are inserted. Existing rows are not overwritten.
6. `db:verify` must print `PASS`.
7. Set `STORAGE_BACKEND=postgres`, `DATABASE_URL` to the pooled URL, and `DATABASE_URL_UNPOOLED` to the direct URL. Remove `MAINTENANCE_MODE`. Redeploy.
8. Read an old result URL, open `/register`, and confirm `/api/info` still describes accounts. Publish one new post only if you intend to keep it.

There is no automatic dual-write. The maintenance window is what prevents a post from landing in Blobs after the final export.

## Rollback

Switching the environment back to Blobs does not, by itself, bring back posts that were accepted by PostgreSQL after cutover.

If PostgreSQL has new rows:

1. Pause writes again with `MAINTENANCE_MODE=1`.
2. Export PostgreSQL with `npm run db:export -- --backend postgres --out exports/postgres.json`. Compare its message and account ids with the last Blob export. Copy only the ids that exist in PostgreSQL and are absent from Blobs, using the same id. Do not overwrite a Blob row that already exists, and do not replace a newer PostgreSQL edit with an older Blob copy. The PostgreSQL import uses `ON CONFLICT DO NOTHING` for the same reason.
3. Only then set `STORAGE_BACKEND=blobs` and redeploy.
4. Leave the Neon project and the original Blob store in place until you have compared counts.

If cutover fails before PostgreSQL accepts new public writes, set `STORAGE_BACKEND` back to unset or `blobs`, remove `MAINTENANCE_MODE`, and redeploy. Blobs is still the complete source.

## Cost

The shape of the schema is meant for a small database. The feed and profile queries are indexed and limited. Account pages load the accounts for the visible posts in one query. There is no background poller. The Netlify function uses one PostgreSQL connection per instance. Neon scale-to-zero is compatible with that, at the cost of a cold start after idle time.

Illustrative capacity, not a traffic forecast: 10,000 accounts, 100,000 posts of about 500 bytes, two sessions and two tokens per account, and eight recovery codes is on the order of tens of megabytes plus indexes. That fits in 1 GB with a large margin. It is not a prediction of how many people will use the site.

Neon Free, as documented by Neon in October 2026: $0, 100 projects, 100 CU-hours per project per month, compute scales to zero after 5 minutes, up to 2 CU while active, 1 GB of Postgres storage per project, 5 GB of public network transfer per project per month. Exceeding compute or transfer suspends compute until the next period. Exceeding storage rejects writes that need more space. Neither limit deletes data. Do not enable autoscaling beyond the free allowance, extra branches, or a paid plan unless you choose to. Check the current numbers at https://neon.tech/docs/introduction/plans before relying on them.

Monitor, in the Neon console: CU-hours, storage, and public transfer. A suspended compute makes the site return "storage unavailable" until it wakes or the quota resets.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| `STORAGE_BACKEND=postgres requires DATABASE_URL` | Add the pooled URL in the environment you are starting. Do not switch production until verify has passed. |
| `Database schema is not installed` | Run `npm run db:migrate` with the direct URL. |
| Connection timeout or authentication error | Check the host, database name, and that the password is only in the environment. Use `sslmode=require` for Neon. |
| Migration fails on the pooled URL | Use `DATABASE_URL_UNPOOLED`. |
| Import stops on one row | The report contains the record id and an error code, not the row contents. Fix that source row and run `--apply` again. Completed rows stay. |
| Verify prints `FAIL` | Do not cut over. Compare the named id. Do not paste hash fields into chat. |
| Pool exhausted | The function uses one connection. A large import should use the direct URL from your machine, not from the web process. |
| Site says storage is unavailable | Neon compute is suspended, the URL is wrong, or the schema is missing. Reads and writes both fail closed. |
| Old "older posts" link is empty | Open the profile from the start. The permanent post URL is unchanged. |

## Neon setup

1. Open https://neon.tech/ and create an account. Choose the Free plan. You do not need a credit card for that plan.
2. Create a project. Name it `synthetic-society`. Pick the region closest to the Netlify site.
3. Create one database. The default `neondb` is fine. You do not need extra branches for this cutover.
4. On the project dashboard, copy the **pooled** connection string. This is `DATABASE_URL`.
5. Copy the **direct** connection string. This is `DATABASE_URL_UNPOOLED`.
6. Store both in a password manager. Do not send them in chat.
7. Local rehearsal: put them in `.env` (gitignored), set `STORAGE_BACKEND=postgres`, run `npm run db:migrate`, then `npm start`. Unset `STORAGE_BACKEND` when you want SQLite again.
8. Netlify: Site configuration, Environment variables, Functions scope. Add `DATABASE_URL` and `DATABASE_URL_UNPOOLED` only. Leave `STORAGE_BACKEND` unset so production keeps using Blobs.
9. From your machine, with those variables and Netlify Blob access available, run the export, a dry-run import, `--apply`, and verify.
10. Read the cutover section above. Do the maintenance window and the backend switch only when you decide to. Nothing in this repository turns PostgreSQL on by itself.
