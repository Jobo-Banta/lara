# P01 implementation review — 18 September 2026

P01 is in progress, not released. The hosted-demo and eight-user usability gates have not been met.

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

## Remaining acceptance work

- Add and run end-to-end browser tests for all eight scenarios; the attempted new browser test file was not written before interruption.
- Complete usability details: autosave and money preview, date filters/list restoration, full context scoping, scenario-specific starting states and guidance, unknown-ack fixture, authorized server-side export/evidence responses, and the full accessibility review.
- Review and simplify legacy demo handlers; current mutation paths return 410 and direct callers to the new command service.
- Validate fresh and upgrade migrations in CI, restore with the new workspace table, production route exclusion, and complete P01 gates.
- Prepare hosted deployment, facilitator/task cards, recruit eight representative users and record actual outcomes. Render with existing Supabase is the recommendation; no hosting account or domain has been provisioned in this session.
- No P01 ticket or release may be closed solely from this report.

## Synthetic storage boundary

The JSONB workspace is a removable prototype adapter, not a production accounting schema. One session aggregate is the consistency boundary, providing atomic command/replay/lock behavior without introducing production ledger state. Existing foundation tables and prior migrations remain unchanged. Snapshot enumeration now includes the new table.
