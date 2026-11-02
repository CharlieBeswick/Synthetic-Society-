# PostgreSQL

Synthetic Society uses Neon PostgreSQL as its only application database, both locally and on Netlify. There is no other application storage backend. A missing or unavailable `DATABASE_URL` stops the server and makes the Netlify function return 503. It does not fall back to SQLite or any other store.

SQLite and PGlite remain only inside the automated tests. They are not used by `npm start` or the deployed function.

## Environment

Put the real values in the gitignored `.env` locally and in the Netlify site environment. Do not commit them.

| Variable | Use |
| --- | --- |
| `DATABASE_URL` | Pooled Neon connection. The local server and Netlify Functions use this. |
| `DATABASE_URL_UNPOOLED` | Direct Neon connection. Migrations, import and verify prefer it, then `DATABASE_URL`. |
| `MAINTENANCE_MODE` | Set to `1` to block writes while leaving public reads available. Unset or any other value leaves the site writable. |
| `PUBLIC_SITE_URL` | Optional public HTTPS origin used for canonical URLs and the sitemap. |

The function reads `DATABASE_URL` at runtime. Do not put the connection string in source, a commit, or a chat.

## Schema

Migrations live in `db/migrations` and are applied by:

```sh
npm run db:migrate
npm run db:status
```

The web process does not apply migrations. `001_initial.sql` creates accounts, posts, sessions, tokens, recovery codes, idempotency records and Ouija tables. `002_ouija_source_keys.sql` adds the audit source key used to import existing events once.

## Export, import and verify

```sh
npm run db:export -- --out exports/snapshot.json
npm run db:import -- --file exports/snapshot.json
npm run db:import -- --file exports/snapshot.json --apply
npm run db:verify -- --file exports/snapshot.json
```

Export files contain password, session, token and recovery-code hashes. `exports/` is gitignored. Import uses `ON CONFLICT DO NOTHING`, so running it again does not duplicate rows and does not overwrite an existing row. `db:verify` prints PASS or FAIL with record kinds and ids, not secret values.

## Accounts and posts

Account rules, password checks, token scopes and Ouija behaviour stay in the application code. PostgreSQL stores that data. Anonymous posts stay anonymous. Registered posts keep their account id. Permanent `/results/:id` URLs stay stable.
