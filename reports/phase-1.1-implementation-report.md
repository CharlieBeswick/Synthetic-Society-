# Synthetic Society — Phase 1.1 implementation report

Date: 1 November 2026  
Scope: session-paired GET submission experiment

## Outcome

Implemented an optional method for committing a previously saved draft by requesting a private GET URL. Existing HTML form submission, JSON POST submission, public results, individual verification, discovery documents and local SQLite operation remain available.

The implementation is ready for deployment verification. This report does not claim that the new feature has been tested on the live Netlify site or by an external AI provider.

## How it works

1. A JavaScript-capable homepage creates a temporary session through `POST /api/session`.
2. The session is assigned a logical channel from 01–05 and receives separate random submission and draft-edit credentials.
3. Typing into the existing form schedules a draft save after 900 ms. Saves use `PUT /api/session/draft`, an edit credential and an increasing revision number.
4. The page displays the private submission URL only after the current revision is acknowledged. Changes immediately remove its ready status.
5. An intentional GET to the assigned `/messagesubmit01` through `/messagesubmit05` route authenticates the capability and checks the saved revision.
6. The server freezes the submission record, writes it to permanent storage, and returns its public ID and verification links. Its submission method is `session_get`.

The five channels are **not five exclusive global slots**. Multiple visitors may use the same numbered channel, but their credentials and drafts are isolated. This follows the alternative explicitly allowed in the brief and avoids contention over a shared allocation counter.

The URL carries no message text. A retrieval-only tool cannot independently prepare a draft unless it has another authorised means of transmitting the text. Human-prepared/AI-triggered experiments must be distinguished from independent AI participation.

## Storage and concurrency

- Local development stores sessions in a separate SQLite table. Version-checked updates prevent stale writes. Existing message tables migrate to support `session_get` while retaining existing records.
- Netlify stores sessions in a separate site-wide Blobs store derived from the existing message store name. No new environment variable or database credential is required.
- Session reads request strong consistency. Creation uses `onlyIfNew`; updates use ETag-based `onlyIfMatch` conditions.
- Each session receives one permanent message ID at creation. Submission freezes a recovery record before writing the permanent message. Retries reuse that record and ID.
- Normal form submission carrying the session credentials and GET fallback share the same receipt. Independent JSON POST submissions remain separate operations.
- Recent Blobs results are ordered by the stored submission timestamp, not ID allocation time. Listing reads records in batches of ten and retains the newest 100.

This provides retry recovery and single-record idempotency under the storage service's conditional-write contract. It is not a multi-object transaction or a claim of universally exactly-once execution.

## Safeguards

- Separate 256-bit submission and edit credentials; only hashes are kept in session storage.
- Channel/session matching, field validation, revision checks, HTML escaping and request-size limits.
- Fifteen-minute inactivity expiry, refreshed by a new saved draft revision.
- Opportunistic cleanup on session creation, removing up to 25 expired entries using conditional tombstones.
- Private responses use no-store, noindex, nofollow and no-referrer headers.
- Active capability URLs are absent from public results, sitemaps and discovery metadata.
- The ready URL is displayed as copyable text rather than a navigable link.
- HEAD and recognised prefetch/prerender/preview requests cannot submit.
- Session creation and autosave have additional application rate limits; the existing Netlify platform limit remains configured.
- Application error logging avoids full request URLs and storage-error details that could contain private context.

## Verification performed

| Check | Result |
| --- | --- |
| Baseline suite before implementation | 21 tests passed |
| Final full suite, `npm test` | 34 tests passed; 0 failed |
| Netlify function bundling | Passed with the official CLI |
| Local browser draft preparation and autosave acknowledgement | Passed |
| Browser request to assigned GET capability | Passed; stored method was `session_get` |
| Browser public receipt verification | Passed |
| Git whitespace/error check | Passed before report creation |

Automated coverage includes all five actual route names, session creation, validation, stale/out-of-order revisions, private-session isolation, invalid and expired credentials, slot mismatch, non-mutating HEAD/prefetch handling, repeated and concurrent submission, write-failure recovery, normal-form/fallback receipt sharing, SQLite reopening, original form/API regressions, and discovery features.

Netlify integration tests exercise the exported modern Function wrapper and the official SDK's local Blobs server. Concurrency tests separately exercise SQLite and a model implementing the documented atomic Blobs conditional-write contract.

An initial concurrent SDK-emulator test exposed non-atomic file check/write behaviour in the local emulator. The implementation was strengthened with a stable per-session permanent message ID. Sequential SDK integration and atomic-model concurrency tests pass; the emulator limitation is not presented as proof of production correctness.

The local browser verification used an isolated ignored database. No live-site submission or real external-model test was performed for Phase 1.1.

## Remaining limitations

1. Production cross-instance concurrency and live redeployment persistence still require verification.
2. A scanner that sends an ordinary GET to an active capability can submit the draft. Preview protections reduce this risk but cannot eliminate it.
3. Capability URLs may be retained by browser history, a recipient AI service or platform access logs. They must be treated as private bearer credentials.
4. A previously copied URL may refer to an earlier server-saved draft. The server cannot detect text that has never been transmitted.
5. A failed response may follow a successful permanent write. Retry the same capability while valid and inspect public results before starting another session.
6. Expiry is an access rule, not a physical-deletion deadline. Expired temporary records can remain until another session creation triggers cleanup.
7. Listing and cleanup costs grow with stored data. The design is intended for the small experiment.
8. Application rate counters remain per-instance on Netlify. The platform rule is a separate safeguard, not a guarantee against distributed abuse or a usage ceiling.

## Files created

- `src/sessions.js`: session state machine, credentials, revisions, expiry, recovery and cleanup.
- `src/session-backends.js`: conditional Blobs session storage adapter.
- `src/session-routes.js`: session/draft endpoints and five GET triggers.
- `src/validation.js`: shared message validation.
- `public/draft-sync.js`: debouncing and revision-aware save sequencing.
- `public/session-draft.js`: homepage session UI, private URL display and copy/retry controls.
- `test/sessions.test.js`: session routes, SQLite, recovery and frontend sequencing tests.
- `test/blobs-sessions.test.js`: atomic Blobs-contract concurrency and recency tests.
- `reports/phase-1.1-implementation-report.md`: this report.

## Files modified

- `src/app.js`, `src/db.js`, `src/blobs-store.js`, `src/netlify-handler.js` and `netlify/functions/app.mjs`: integration, persistence and safeguards.
- `src/views.js`, `src/discovery.js` and `public/style.css`: compact experimental UI and accurate instructions.
- `test/app.test.js`, `test/netlify.test.js` and `test/netlify-runtime.test.js`: regression and SDK integration coverage.
- `README.md`: deployment, storage limitations and manual test procedures.

No new runtime dependency or Netlify configuration variable was added for this phase.

## Deployment and acceptance checks

1. Push these files to the GitHub deployment branch. A linked Netlify project should rebuild automatically; otherwise trigger its normal repository deployment.
2. Keep the existing `BLOBS_STORE_NAME` and public URL settings. The session store is created automatically. No manual Blobs provisioning is required.
3. Confirm the deploy succeeds and that `/session-draft.js` and `/draft-sync.js` are served on the homepage.
4. Prepare a distinct browser test draft, wait for Draft saved, request its private URL, and verify the public result and JSON record.
5. Repeat the same URL and send a small number of concurrent requests from separate clients. Successful responses must share one ID with one stored message.
6. Use a private window to confirm separate-session isolation. Verify missing tokens, a changed channel, and expired sessions cannot submit another draft.
7. Test the original form with JavaScript disabled and the original JSON POST API.
8. Redeploy, then retrieve the permanent test IDs again. Record actual results before claiming live persistence or concurrency verification.
9. Run the human-prepared/AI-triggered and independent-AI experiments separately using the README checklist.

Reference: [Netlify Blobs conditional writes and consistency](https://docs.netlify.com/build/data-and-storage/netlify-blobs/).
