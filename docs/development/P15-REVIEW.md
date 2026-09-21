# P15 implementation review — 21 September 2026

P15 is in progress, not released. Build-order steps 1 (contracts, migration, permission and capability definitions), 2 (domain rules), 3 (API), 4 (user journeys) and 5 (acceptance and operations) are implemented; no `group_accounting` capability is activated for a live group and no consolidation has been published for a customer.

## P15-01 contracts and migration

Contracts: the 18 P15 operations (`/groups` create/list/get/edit/activate, `/intercompany-pairs` create/list/get/edit/accept/post, `/consolidations` create/list/get/edit/preview/approve/publish) and their schemas were already in the reviewed OpenAPI; the `group.*`, `intercompany_pair.*` and `consolidation.*` permissions and the `group_accounting` capability (depends on `multi_currency` and `assets`) were seeded by `0009`. Under the phase rule that screens may add read/list and versioned-mutation operations, ten entity-scoped operations were added and the catalog regenerated (412 operations): rate sets (`POST/GET /rate-sets`, `GET /rate-sets/{id}`, `POST /rate-sets/{id}/approve`), mapping versions (`POST/GET /groups/{id}/mappings`, `POST /group-mappings/{id}/approve`), member-close readiness (`GET /groups/{id}/readiness`), manual eliminations (`POST /consolidations/{id}/eliminations`) and the worksheet (`GET /consolidations/{id}/worksheet`). The reviewed `ConsolidationCreate` names `rateSetId` and `mappingVersion`; both now resolve to approved records.

Migration `0030_p15_intercompany_and_consolidation.sql`:

- `groups` (one live per reporting entity, reporting currency and its own `CONSOL` management book, draft → active → archived, activated by a principal other than the definer, currency and book frozen once active) and `group_members` (wholly-owned, `full` method only; the check keeps the pilot boundary in the database).
- `group_mapping_versions` and `group_account_mappings` (member account → group account code, name, category and role; one account per version; approved by another principal; immutable once approved).
- `consolidation_rate_sets` (closing, average and historical rates per currency for a period end, source evidence, approved by another principal, immutable once approved).
- `intercompany_pairs` (source and target entities and documents, shared reference `ICP-nnnnnn`, target draft, draft → accepted → posted with `exception` and `rejected`; each side's `posted_at` is never cleared; posted and rejected pairs final).
- `consolidation_runs` (versioned per group and period end; result and hash required from `previewed`; inputs and result frozen from `approved`; one `published` per group and period; `superseded` final), `elimination_entries` (pair or manual with reason and evidence, amount and difference) and `translation_adjustments` (one per run, member and source with policy and rate).
- RLS `tenant_scope` policies, `touch_row` triggers, grants to `lara_api`; the runtime role cannot delete group, pair or run records.

Verification: `scripts/test-p15-schema.mjs` (5 groups) in CI on fresh and upgraded databases; teardown and snapshot tooling cover the nine new tables.

## P15-02 domain rules

`packages/domain/src/consolidation.mjs`:

- Group definition with members validated (each once, wholly owned under the full method, the reporting entity included), the reporting book created with the group, activation by a second principal only after an approved mapping version; mapping versions validated against the member charts (one category per group code, roles restricted, reserve and retained earnings roles in equity); rate sets validated per currency with positive rates.
- Pairs are raised in the source entity between members of one active group on an invoice or bill with the counterpart draft in the source currency; acceptance in the target entity prepares the target document under the accepter's name (`intercompany_pair.accept` is the authority; approval and posting follow the entity's own maker-checker so the accepter never approves it) and marks a gross mismatch as an exception; posting a side runs the entity's own posting inside a savepoint — success records that side, a domain failure rolls back only the attempt and records the pair as `exception` with the reason; the first side is never rolled back (P15-T02).
- Runs validate their inputs as a whole: an active group, one `statements` snapshot per effective member for the period end from a soft-closed or locked period, an approved rate set for the period end covering every member currency (transaction-rate income translation refused as an unapproved extension), an approved mapping version.
- The worksheet is computed from the inputs alone: balance sheet lines at closing, income at the period average, equity and prior-period earnings at historical, each member's residual booked to the translation reserve line with the rates recorded per source (P15-T03); eliminations from pairs posted on both sides — the reciprocal receivable and payable still outstanding at the snapshot cutoff and, for pairs dated in the period, the revenue and expense from the posted journal lines, each once (P15-T01); a difference that only the rates cause goes to the reserve, a difference in the transaction currency stays unresolved; manual eliminations with reason and evidence; unmapped accounts and pairs not posted on both sides are listed; totals never sum mixed currencies (every amount is translated to the reporting currency first). The result hash covers the snapshot ids, the mapping and rate set hashes, the eliminations, lines and totals (P15-T04).
- Approval by a second principal refuses any unresolved difference or an unbalanced result (no plug); publication writes the `consolidated_statements` snapshot in the group book and supersedes the earlier published run.
- Nothing in the module writes a member ledger; every member read is a report snapshot or posted journal lines, and every mutation requires the entity's own authority (P15-T05).

Verification: `scripts/test-p15-domain.mjs` (7 groups) covers P15-T01–T05 with a three-member fixture (parent and subsidiary in PHP trading with each other, an overseas member in USD).

## P15-03 API

All 18 operations plus the ten additions are served by `apps/api/src/workspace-api.mjs`; pairs are read from either side under the caller's entity, runs only in the reporting entity; `?detail=1` returns the pair and run details the screens show.

Verification: `scripts/test-p15-api.mjs` (5 groups, API as a process, in CI): the group, mapping and activation by two principals over HTTP, the rate set, the pair raised, edited, accepted, the exception path and the posting of both sides, a run created, previewed, worked through the worksheet with a manual elimination blocking approval, a second run with the same hash approved and published, isolation and gates.

## P15-04 user journeys

`apps/web/src/app/_components/workspace-group.tsx`: `/group` (the group and members, mapping versions drafted from the member charts with roles by account code and approved by the reviewer, rate sets from source evidence), `/group/pairs` (pairs from either side with accept, refuse and post-our-side actions and the exception reason on screen; a pair raised against an invoice with the target's party, account and branch), `/group/consolidations` (member-close readiness per period end, runs with preview, approve and publish, the worksheet with pair exceptions, unresolved differences, consolidated statements with member, elimination and translation columns, translation rates per member, eliminations, a manual elimination form and member balances). The capabilities screen offers `group_accounting`; the navigation gained the Planning placeholder (P16).

Verification: `tests/browser/workspace.spec.mjs` group journey on the production composition — activation by two principals, a group with a seeded wholly-owned subsidiary, the mapping drafted and approved, the group activated, a rate set approved, a pair raised in the workspace entity and accepted in the subsidiary, the exception on the unapproved side, both sides posted, readiness, the run previewed into a balanced worksheet with the pair eliminated once, approved and published, WCAG checks (also in CI).

## P15-05 acceptance and operations

Acceptance: P15-T01–T05 in `scripts/test-p15-domain.mjs` and `scripts/test-p15-api.mjs`; CORE regressions unchanged; migration, restore and fresh/upgrade paths in `scripts/ci-database.mjs`. `P15-RUNBOOK.md` covers activation gates, pairs, running a consolidation and the rollback rule (disable the capability; member ledgers untouched; supersede, never delete).

## Open items for the owner

- No seeded role template holds the group, pair or consolidation authorities; tests and the journey create a group accountant and a group reviewer.
- Partial ownership, the equity method and transaction-rate income translation are refused pending an approved extension.
- Reciprocal balances are eliminated per pair from open items at the cutoff; intercompany balances that arise outside pairs (loans, settlements) are entered as manual eliminations with evidence.
- CSV/PDF exports of the worksheet arrive with the report export increment.
- `ADR 001` still names NestJS/Vitest; the codebase remains plain Node + `node:test` (see `P02-REVIEW.md`).
