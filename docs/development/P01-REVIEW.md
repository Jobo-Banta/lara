# P01 implementation review — 18 September 2026

P01 is in progress, not released. The hosted-demo and eight-user usability gates have not been met. See the 19 September update below for the current state.

## Implemented and verified in this session

- Added migration 0008 for persistent session-owned synthetic aggregates with forced row-level security. The authenticated browser session is bound into the signed BFF identity; separate sessions for the same subject have separate runs.
- Demo commands hold a PostgreSQL row lock and commit state and retry receipts together. Synthetic financial values use integer cents; simulated journals must balance.
- Added draft, approval, posting, collection, bill review, payment authority, reconciliation, reporting repair, close, comments, feedback, reset and actor-switch commands.
- Added persistent navigation and the required detail routes. These screens are implementation candidates; full browser acceptance remains outstanding.
- Production build and type checks passed; all 11 foundation tests passed.
- Real Supabase workflow suite passed: 100 identical posting retries; conflicting retry payload; simultaneous stale edits; partial allocations and explicit fees; payment approval invalidation; immutable reporting source; retained close report and late-post denial; cross-tenant and same-user session isolation; scoped reset.
- Local browser smoke test passed at 390px: authenticated /work rendered its session-owned task with no JavaScript errors. Screenshot: .local/p01-restored-workspace.png. This does not establish full mobile/accessibility acceptance.

## Diagnosed local failure

The Next.js development server hot-reloaded the new UI while the old API process continued serving the prior code. Requests to /api/demo/workspace returned 404. Restarted the complete stack and enabled Node watch mode for the API in scripts/dev.mjs. A temporary synthetic account verified the full web/BFF/API/Supabase path returned HTTP 200; its diagnostic data was removed.

The workflow test was slow rather than failed: it opened a remote database connection for each assertion and originally emitted output only at completion. Added progress messages and bounded connection/query timeouts for subsequent runs.

Occasional helper_unknown_error messages originated from the local command-launch environment. Retrying the affected command through the approved execution path succeeded.

## Update — 19 September 2026

- Browser acceptance: `tests/browser/demo.spec.mjs` covers DEMO-01 through DEMO-08 plus branch isolation, setup, feedback and responsive layout; `tests/browser/accessibility.spec.mjs` runs axe WCAG 2.1 A/AA on the login page and thirteen workspace routes at 1440 and 390 and checks the keyboard path into the invoice editor. All pass locally against Supabase (`node scripts/test-demo-browser.mjs`) and in CI against the clean database (runs 35370240350 and 35371504895).
- Usability details completed: autosave on saved invoice drafts, amount preview after leaving a quantity or unit price field, date filters retained in the URL with search and status, branch context scoping, scenario-specific starting states, unknown-acknowledgement fixture, authorized evidence and watermarked export endpoints, focusable scrollable tables.
- Legacy demo handlers removed; the API serves every `/demo/*` path through the session-bound command service and readiness requires migration 0008. `scripts/test-api-readiness.mjs` proves the routes are absent outside demo mode (P01-T03).
- CI validates fresh and upgrade migration paths including the workspace table, restore rehearsal and both demo/production compositions.
- Hosting: `render.yaml`, the `demo-host` image target, `scripts/start-demo-host.mjs` and `/api/health/ready` are prepared. No hosting account, domain or dashboard secrets have been provisioned; P01-10 is blocked on the owner.
- Tickets P01-01 through P01-08 are recorded done with the CI evidence above. P01-09 remains in review because P01-T08 requires eight actual participants. No P01 release is recorded.

## Remaining release work

- Provision the hosted demo (Render with the existing Supabase project is the recommendation), configure OIDC redirect and secrets, and verify `/api/health/ready`.
- Run the facilitated sessions with at least eight representative users using `docs/development/P01-FACILITATOR.md`; record results in the usability template and validate them with `node scripts/check-p01-usability.mjs <results.json>`.
- Fix any role-blocking defects, then record the P01 release with the tag and gate evidence.

## Synthetic storage boundary

The JSONB workspace is a removable prototype adapter, not a production accounting schema. One session aggregate is the consistency boundary, providing atomic command/replay/lock behavior without introducing production ledger state. Existing foundation tables and prior migrations remain unchanged. Snapshot enumeration now includes the new table.
