# P11 implementation review — 20 September 2026

P11 is in progress, not released. Build-order steps 1 (contracts, migration, permission and capability definitions), 2 (domain and calculation rules), 3 (API and jobs), 4 (user journeys) and 5 (acceptance and operations) are implemented; no `assets` capability is activated for a live entity, no opening register is imported outside test tenants and no scheduled posting authority is granted for a customer.

## P11-01 contracts and migration

Contracts: the 13 P11 operations (`/assets` create/list/get/edit/approve/events, `/schedules` create/list/get/edit/approve/pause, `POST /schedule-runs` as a 202 job) and their schemas were already in the reviewed OpenAPI; the `asset.*` and `schedule.*` permissions and the `assets` capability (depends on `general_ledger` and `purchasing`) were seeded by `0009`. Under the phase rule that screens may add read/list operations, five reads were added and the catalog regenerated (380 operations): `GET /asset-classes`, `GET /assets/{id}/events` (events, components, carrying amount), `GET /assets/{id}/layers` (book/tax comparison), `GET /schedules/{id}/lines` (versions and lines with the checksum) and `GET /schedule-runs` (the run calendar). `validate_specifications` passes.

Migration `0026_p11_assets_and_schedules.sql`:

- `asset_classes` (code unique per entity; asset, accumulated depreciation, depreciation expense, disposal gain and loss accounts distinct; optional CIP and revaluation surplus accounts; default method and life; optional tax method and life for the memo tax layers).
- `assets` (tag unique per entity; cost > 0, residual ≤ cost, accumulated ≤ cost; a source bill or a parent; draft → approved → disposed | merged | rejected; approver ≠ preparer; method, life and class fixed once approved — changes are prospective schedule versions; disposed and merged assets immutable) with `asset_events` (append-only, sequenced per asset, evidence required, kind-specific fields checked: proceeds on disposal, amount on split/impairment/revaluation, target on transfer; before/after cost and accumulated recorded) and `asset_components` (append-only split and merge lineage).
- `recognition_schedules` (one live schedule per kind and source; identity fixed; draft → approved ↔ paused → completed | rejected; approver ≠ preparer), `schedule_versions` (one draft at a time; immutable once reviewed; approver ≠ preparer), `schedule_lines` (unique per schedule and period, periods start on the first; posted and drafted lines immutable and undeletable; planned → posted | drafted | blocked | cancelled), `schedule_runs` (at least one schedule; job id and results) and `book_tax_layers` (append-only, unique per asset, period and rule version).
- RLS `tenant_scope` policies, `touch_row` triggers, grants to `lara_api`; `lara_worker` may execute runs (update lines, runs, schedules and the register's accumulated depreciation; insert layers, journal drafts, documents, lines, relations and tasks).

Verification: `scripts/test-p11-schema.mjs` (4 groups) in CI on fresh and upgraded databases; teardown and snapshot tooling cover the nine new tables.

## P11-02 domain and calculation rules

`packages/domain/src/assets.mjs`:

- Asset profile (`settings_versions` kind `asset_profile`: asset clearing and disposal clearing accounts). Recognition policies are approved settings versions of kind `recognition_policy_<code>` (proration `monthly` or `daily`, declining-balance annual rate, a method override, the account mapping for prepayments, deferred revenue and deductions); a schedule names the code as its `policyVersion`.
- Classes are created under `asset.approve` (the controller approves them). An asset is drafted from a posted bill whose lines on the asset clearing account cover its cost net of the assets already drawn from the bill; approval by another principal posts the capitalization (Dr asset — or CIP when the class has a CIP account — / Cr asset clearing).
- Deterministic generators (exported, pure): straight line `(cost − residual) / months` rounded each period with the residue in the final period; declining balance at the approved rate (default double-declining, `2 / months` a month) on the opening carrying amount, floored at the residual, remainder in the final month; sum of the years' digits with annual weights `(M − 12(y − 1)) / 12` over the digits (fractional final year) and an even monthly allocation inside each year with the year's residue in its last month; daily actual/actual for straight line and ratable schedules (a leap day counts); ratable schedules for prepayments, deferred revenue and deductions with the residue in the final period (P11-T04); recurring templates one line a month.
- Versions: the initial version carries every period; editing an approved or paused schedule creates a prospective draft version from the first unexecuted period with the recognized amount as its opening; approval by another principal supersedes the current version; posted periods never change (P11-T01 method change). Lifecycle events (impairment, revaluation, split, merge) regenerate the open periods as an approved prospective version; a disposal or merge ends the schedule; a pending draft version holds the run for its periods.
- Events post once and link to the asset: transfer changes the location; capitalization from CIP moves cost into the asset account and sets the in-service date; impairment debits the loss account against accumulated depreciation; revaluation debits the asset against the surplus account; disposal removes cost and accumulated depreciation, takes the proceeds through the disposal clearing account and posts the gain or loss; split moves the stated cost and the proportional accumulated depreciation to a new approved child asset (`<tag>-S<n>`); merge absorbs approved assets of the same class (they become `merged`). Cost and accumulated depreciation are conserved (P11-T03); events dated inside posted periods are refused.
- Runs: `POST /schedule-runs` under `schedule.execute` queues a `schedule.run` job; the worker rechecks the authority and executes: depreciation, prepayment and deferred revenue lines post through `lara.post_journal_entry` (`schedule_line` source, once — a rerun answers `already_executed`); recurring invoices, recurring journals and employee deductions create drafts for review under the approved schedule's authority and never post; a locked or soft-closed period blocks the line and opens one `schedule_blocked` task instead of a bypass (P11-T02); paused schedules skip; a schedule with no open line completes.
- Book/tax layers: every depreciation posting writes the book depreciation and carrying amount beside the tax depreciation and carrying amount from the class tax rule (`tax:<method>:<months>` or `tax=book`), reproducible from the rule and the asset facts with a stable checksum (P11-T05).
- Reads: events with components and the carrying amount, the book/tax comparison, schedule versions and lines with the checksum, the run calendar; the `asset_register` report type renders through the P03 snapshot job.

Verification: `scripts/test-p11-domain.mjs` (6 groups) covers P11-T01–T05 and AC-08 (120,000 over 60 months posts Dr depreciation expense 2,000 / Cr accumulated depreciation 2,000).

## P11-03 API and jobs

All 13 operations plus the five reads are served by `apps/api/src/workspace-api.mjs`; the worker gains the `schedule.run` handler and the `asset_register` report. Postings inside events and approvals are synchronous in the command transaction; schedule execution is a job.

Verification: `scripts/test-p11-api.mjs` (4 groups, API and worker as processes, in CI): the register over HTTP with If-Match and role refusals, the schedule previewed, redrafted, approved and executed by the worker from the 202 job with AC-08 posted once and a rerun posting nothing, the layers and run reads with contract shapes, an impairment with evidence, pause, the report job, 404s and later-phase gates.

## P11-04 user journeys

`apps/web/src/app/_components/workspace-assets.tsx`: the register with capitalization drafts, approval, the asset detail (events, components, carrying amount, the event form) and the book/tax comparison at `/assets`; the schedule workbench with the deterministic preview, versions, approval, pause and resume, the run per period and the run calendar with its results and task links at `/assets/schedules`. The capabilities screen offers the activation; the navigation gained Schedules and the Assistant placeholder (P12).

Verification: `tests/browser/workspace.spec.mjs` assets journey on the production composition — two-principal activation, profile, accounts, class, policy and roles seeded through the runtime role (no reviewed operations exist for them), an asset drafted on screen from the bill posted by the purchasing journey, approved by the controller with the capitalization entry, the schedule previewed (60 × 166.67), approved and run for October by the worker, the book/tax comparison and a transfer event with evidence, WCAG checks on both routes (also in CI).

## P11-05 acceptance and operations

Acceptance: P11-T01–T05 and AC-08 in `scripts/test-p11-domain.mjs` and `scripts/test-p11-api.mjs`; CORE regressions unchanged; migration, restore and fresh/upgrade paths in `scripts/ci-database.mjs`. `P11-RUNBOOK.md` covers activation gates, classes and policies, capitalization, schedules and versions, runs and blocked periods, events, the book/tax layers and the rollback rule (pause the scheduler, reconcile its last committed period).

## Open items for the owner

- No reviewed operations exist for asset classes (creation), the asset profile, the recognition policies or the opening register import; the domain implements class creation under `asset.approve` and the journey seeds the rest through the runtime role. Opening assets enter as capitalizations from an opening bill on the asset clearing account until the reviewed import exists.
- No seeded role template holds the asset or schedule authorities beyond reads; tenants create the asset clerk and approver roles (tests and the journey do).
- Method and life changes flow through prospective schedule versions; the register keeps the capitalization facts (the current life and method are on the approved version).
- Daily actual/actual proration applies to straight-line and ratable schedules; declining balance and sum of the years' digits stay monthly.
- Tax depreciation is a memo layer from the class tax rule (no separate tax book posting); P09 separate books are not combined with the register.
- Custodian is a party reference without a screen; locations are branches.
- `ADR 001` still names NestJS/Vitest; the codebase remains plain Node + `node:test` (see `P02-REVIEW.md`).
