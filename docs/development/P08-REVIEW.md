# P08 implementation review — 20 September 2026

P08 is in progress, not released. Build-order steps 1 (contracts, migration, permission and capability definitions), 2 (domain and state rules), 3 (API and jobs), 4 (user journeys) and 5 (acceptance and operations) are implemented; no `fi_coexistence` capability is activated for a live institution, no source system is named outside test tenants and no bank feed adapter exists — feeds enter as CSV evidence through the reviewed import pipeline. Core banking, valuation, lending and ECL stay in their authoritative systems.

## P08-01 contracts and migration

Contracts: the 5 P08 operations (`/source-ownership` create/list/get/edit/approve) and their schemas were already in the reviewed OpenAPI; the `source_ownership.*` permissions and the `fi_coexistence` capability (depends on `compliance`) were seeded by `0009`. Canonical feeds use the reviewed P03 import operations (`POST /imports` with kinds `journal` and `source_balances`, the source system code as `sourceId` and the mapping version label), so no second batch model was invented. Under the phase rule that screens may add read/list operations, nine reads were added and the catalog regenerated (365 operations): `GET /source-systems`, `GET /mapping-versions`, `GET /mapping-versions/{id}/lines` (with `againstId` for the diff), `GET /source-batches`, `GET /source-batches/{id}/rows`, `GET /expected-batches`, `GET /feed-reconciliation`, `GET /branch-rollup` and `GET /institution-tax-worksheet`. `validate_specifications` passes.

Migration `0023_p08_fi_coexistence_schema.sql`:

- `source_systems` (code unique per entity, owner, granularity detail | summary, cutoff timezone, feed format).
- `source_ownership` (book, system, transaction family, window, evidence ids ≥ 1; draft → approved | rejected → draft, approved → archived; approver ≠ author; approved records immutable; no two approved windows overlap for a book and family).
- `mapping_versions` (per source system and label, evidence hash, line count; draft → approved | rejected, approved → superseded; approver ≠ importer; content immutable once approved) and `mapping_lines` (unique source account per version, target account, dimensions, tax profile; frozen once approved).
- `source_batches` (one per import and per source and external batch id while not rejected; declared manifest, staged counts and totals, currency totals, duplicate count, `replaces_batch_id`/`replaced_by_batch_id`, posted and reversal entries; staged → validated → approved → posted → replaced; approval refused with errors; a journal batch posts only with its entry; posted content immutable) and `source_rows` (unique external line id per batch, mapped target and branch, instrument columns, status and error; frozen once the batch is approved).
- `expected_batches` (unique per source, kind and period start; expected → received | missing | waived; received needs the batch; close task link).
- `source_balance_snapshots` (append-only, unique per source, account, branch, currency and cutoff), `tax_instrument_facts` (one per source row, positive amount, enumerated instrument type, maturity ≥ event; immutable, superseded only by a replacement batch) and `branch_rollups` (append-only manifests with checksum).
- `opening_batches` accept a committed `source_balances` import without a journal entry or balanced totals.
- RLS `tenant_scope` policies, `touch_row` triggers, grants to `lara_api`, `lara_worker` (updates expected batches, records roll-ups) and `lara_audit_reader`.

Verification: `scripts/test-p08-schema.mjs` (7 groups) in CI on fresh and upgraded databases; teardown and snapshot tooling cover the ten new tables.

## P08-02 domain and accounting rules

`packages/domain/src/fi.mjs`:

- Institution profile (`settings_versions` kind `fi_profile`): due-from and due-to accounts, ordered instrument rules (income category, instrument type, remaining-maturity band → tax rule code), profile version.
- Source systems and ownership: ownership is created from the signed matrix evidence, approved by another principal, and ingestion requires an approved window for the system, book and family (`journal` or `balances`) effective on the batch cutoff.
- Mapping versions are imported from reviewed CSV evidence (`source_account, target_account_code, dimensions, tax_profile`) with the evidence hash, validated against the book (active leaf targets), approved by another principal; the lines read returns the diff against another version (added, removed, changed).
- Canonical feed contract `lara-feed-1` with one `MANIFEST` row (count, sha-256 of the data lines, debit and credit or balance totals, optional currency totals, `replaces=` and `partial_ok`). The pipeline hook `sourceFeed` is injected into `ledger.createImport/validateImport/approveImport/commitImport`: preparation checks capability, system, ownership and mapping and applies the duplicate rule (P08-T01: the same external batch id with the same checksum is the one batch, counted and never re-staged; a different checksum is `DUPLICATE_SOURCE`); validation stages every row with its error (book, branch, mapped and postable account, book currency until P09, one side, summarized granularity needing a detail reference, instrument columns, one accounting date per batch, atomic balance) and checks the declared manifest against the staged detail so a mismatch cannot reach approval (P08-T03) — errors stay on the rows for the workbench and the batch simply is not validated; commit posts exactly one entry per journal batch through the posting function (retry idempotent), records instrument facts, reverses a replaced batch as a linked reversal and supersedes its facts, writes balance snapshots for a balance batch, and marks the expected batch received (completing its close task with the feed evidence).
- Expected batches: overdue expectations become `missing` and raise a required close task on the period of their book only; the close hook `feeds.beforeClose` runs before every soft close and lock so the existing gate refuses the affected period and nothing else (P08-T02).
- Feed reconciliation: the latest source balance per account, branch and currency against the mapped ledger balance at its cutoff, with the difference and state.
- Branch roll-up: per-branch totals, interbranch pairs by the `counter_branch` dimension on the due-from and due-to accounts, elimination at the entity and the open difference with the latest date on each side (P08-T04); recorded as an immutable manifest through the `branch_rollup` report type. No cross-entity consolidation exists.
- Institution tax worksheet: instrument facts classified through the profile rules to an active reviewed tax rule version on the event date (GRT, DST, final withholding), rounded half-up per fact, grouped by rule and category with drill-through fact ids; unclassified facts are listed, never zeroed. Every enabled rule is a `tax_rule_versions` row with its evidence and golden cases (P08-T05).

Verification: `scripts/test-p08-domain.mjs` (9 groups) covers P08-T01–T05, ownership windows, mapping diffs, the error workbench, feed reconciliation and linked replacements; P03–P07 suites pass with the hooks registered.

## P08-03 API and jobs

All 5 operations plus the nine reads are served by `apps/api/src/workspace-api.mjs`; the import operations carry the `sourceFeed` hook and the period soft-close and lock operations carry the `feeds` hook. The worker offers `feed.sweep` and renders the `branch_rollup`, `institution_tax` and `feed_reconciliation` report types through the P03 snapshot job.

Verification: `scripts/test-p08-api.mjs` (5 groups, API and worker as processes, in CI): ownership over HTTP with the examiner refused, mapping reads, the feed through `POST /imports` (unapproved mapping refused, validation, approval, commit posting once, five duplicates counted, checksum conflict, a staged batch with its error rows), expected batches, reconciliation, roll-up and worksheet reads with contract shapes, the roll-up report job, 404s and later-phase gates.

## P08-04 user journeys

`apps/web/src/app/_components/workspace-fi.tsx`: the source ownership matrix at `/institution/ownership` (systems, record from evidence, approve or reject), the batch monitor and error workbench at `/institution/feeds` (stage a batch from CSV evidence, validate, approve, post; rows with the error filter; the feed calendar with missing batches; mapping versions with the diff preview), the branch reconciliation and missing-feed dashboard at `/institution/branches` (roll-up, interbranch pairs, snapshot job, source balance reconciliation), and the institution tax worksheet at `/institution/tax` with drill-through and unclassified facts. The imports screen offers the feed kinds; the capabilities screen offers the activation; the auditor's read-only scope holds on every screen.

Verification: `tests/browser/workspace.spec.mjs` institution journey on the production composition — two-principal activation, mapping and feed CSV uploaded as evidence, profile, system, mapping version, calendar and GRT rule seeded through the runtime role (no reviewed operations exist for them), ownership recorded on screen with the self-approval refused and the controller approving, the overdue expectation shown missing, the batch staged, validated, approved and posted with its rows, the calendar satisfied, the roll-up and the worksheet, WCAG checks on the four routes (also in CI).

## P08-05 acceptance and operations

Acceptance: P08-T01–T05 in `scripts/test-p08-domain.mjs` and `scripts/test-p08-api.mjs`; CORE regressions unchanged; migration, restore and fresh/upgrade paths in `scripts/ci-database.mjs`. `P08-RUNBOOK.md` covers activation gates, the feed contract, duplicates and corrections, the missing-feed close gate, reconciliation, the worksheet and the rollback rule (stop source acceptance at a durable watermark and reconcile in-flight batches).

## Open items for the owner

- No reviewed operations exist for source systems, mapping version import and approval, expected batches, the institution profile or waivers; the domain implements them and the journey seeds them through the runtime role.
- No seeded role template holds `source_ownership.create/edit`; tenants create an institution-officer role (tests and the journey do).
- Feeds arrive as CSV evidence only; a scheduled API or SFTP pull is a separate adapter with measured volume and recovery tests before any reuse claim.
- Foreign-currency rows, FCDU and trust books are refused until separate books (P09); a pilot needing them pulls P09 in.
- Non-VAT invoice wording for institutions (FR-FI-003) has no field on `DocumentResource`; the sales profile can carry `vatRegistered:false` for a later print template.
- Read-only examiner access is enforced through permissions and logged as requests; a per-read audit trail and export bundle for examiners are not yet a separate feature.
- `ADR 001` still names NestJS/Vitest; the codebase remains plain Node + `node:test` (see `P02-REVIEW.md`).
