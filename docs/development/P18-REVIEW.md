# P18 implementation review — 21 September 2026

P18 is in progress, not released. For each of the four feature releases (P18A report and custom-field authoring, P18B rule impact and tax proposals, P18C client draft tools, P18D industry pack lifecycle) build-order steps 1–5 are implemented; no feature capability is activated for a live entity and Security/Finance has not accepted the tool and query allowlists, the provider contracts or the per-pack tests. Peer benchmarking and deferred government withholding are not part of this phase.

## P18x-01 contracts and migration

Contracts: the reviewed report definition (5), rule proposal (6), tool grant (6) and pack install (1) operations were in the OpenAPI. Under the phase rule that screens may add read/list and versioned-mutation operations, 11 entity-scoped operations were added and the catalog regenerated (475 operations): the report catalog, the report run, custom fields (create, list, publish), the impact read, tool runs (request, list), the pack catalog, installs and rollback. The report definition publish action takes a reason (not an approval decision); `RuleProposalCreate.summary` and `ToolGrantCreate.rateLimitPerMinute` are optional additions; the pack version resource exposes `versionNo` for `If-Match`.

Migration `0033_p18_extensibility.sql` (capabilities `report_authoring` ← general_ledger, `rule_proposals` ← compliance, `client_tools` ← ai_assistance, `industry_packs` ← general_ledger; six permissions):

- `report_definitions` (one live version per name, the validated query AST with its version and cost, published by a principal other than the author, immutable once published, retired final) and append-only `report_runs` (parameters, scope entity ids, row count, cost, checksum, payload).
- `custom_fields` (unique per resource type and key, `cf_` keys only, never a statutory or accounting key, published by another principal).
- `rule_proposals` (source evidence, affected profiles, proposed rule versions, golden cases; assessed only with an impact; approved only by another principal and only when the impact passed; approved and rejected final).
- `tool_grants` (client principal, allowlisted tools only, entity ids, expiry within a year, rate limit; approved by another principal; never widened or extended once approved; revoked final) and append-only `tool_runs` (request hash, outcome served/proposed/denied/rate_limited, reason, result reference).
- `pack_versions` (unique per pack and semantic version, one installed per pack, the manifest and its hash frozen, the snapshot of the profiles it touches, the applied definitions, the previous version; superseded reinstated only by rollback; failed and rolled back final).
- RLS `tenant_scope` policies, `touch_row` triggers, grants to `lara_api` and the worker; the runtime role cannot delete these records.

Verification: `scripts/test-p18-schema.mjs` (6 groups) in CI on fresh and upgraded databases; teardown and snapshot tooling cover the seven new tables.

## P18x-02 domain rules

`packages/domain/src/extensibility.mjs`:

- Report authoring: the catalog is the allowlist (six metrics over posted functional amounts with the permission each needs, six dimensions, no identities or tax ids); a definition compiles to a versioned AST or is refused (unknown field, unfilterable field, unselected sort field, duplicate, cost above the budget); the compiler emits one parameterized statement from the AST — no raw SQL, no joins beyond the catalog, filter values are parameters — under a row, cost and statement-time budget; a run applies the caller's scope (every metric's permission, only entities the caller holds; an entity outside the scope is not disclosed) to every row and to the aggregate, records the scope and a checksum reproducible for the same definition, period and scope (P18-T01, P18-T05). Custom fields never take statutory or accounting keys and publish independently.
- Rule proposals: a proposal cites issuance evidence, the affected profiles, draft rule versions and golden cases; the impact run recomputes each case's tax effect with the proposed rule through the deterministic kernel, reads the affected profiles' open periods and posted documents and touches nothing; approval needs the impact, a passing result, a principal other than the proposer and the reviewed content version, and activates no rule by itself (P18-T03).
- Client tools: a client integration is a principal without membership whose approved, unexpired grants give `tool.execute` over the granted entities and nothing else (`identity.actorContext`); a request is served only for a granted, allowlisted tool (`read_report` runs a published definition scoped to the granted entity, `read_evidence` returns metadata of unrestricted evidence, `propose_draft` and `propose_task` open tasks for a human); every other tool — approve, post, pay, export, anything an injected instruction asks for — is denied and recorded with the reason; the rate limit counts every request; revocation bumps the client's revocation version so queued work fails its recheck (P18-T02).
- Industry packs: the catalog ships with the release (`packages/packs/<pack>/<version>/manifest.json`); an install is refused unless the manifest hash matches the reviewed catalog, dependencies are satisfied and, for an upgrade, the installed version is a declared path; the worker snapshots the profiles the manifest touches, applies settings and report definitions as drafts under the installer's identity and supersedes the previous version; rollback restores the snapshot as new draft settings, retires the version's report definitions and reinstates the previous version without touching any posted fact (P18-T04).

Verification: `scripts/test-p18-domain.mjs` (6 groups) covers P18-T01–T05.

## P18x-03 API, worker and identity

All 29 P18 operations are served by `apps/api/src/workspace-api.mjs`; each feature answers `FEATURE_NOT_ENABLED` until its capability is active. The worker runs `pack.install` and `pack.rollback` jobs with the authorization recheck. The identity layer scopes client integrations by their grants; the tool scope travels on the actor context and `/me` shows `tool.execute` alone.

Verification: `scripts/test-p18-api.mjs` (5 groups, API and worker as processes, in CI): the catalog and a definition validated, published, run and scoped; a custom field; a proposal assessed, blocked and approved; a grant approved, tool requests served, denied and rate limited, the task proposed, the log and the revocation; a pack installed, upgraded and rolled back by the worker; gates.

## P18x-04 user journeys

`apps/web/src/app/_components/workspace-extend.tsx`: `/extend` (the catalog, the definition builder with allowlisted metrics, dimensions, filters and sort, publication by another principal, runs with rows, aggregate, scope and checksum, custom fields), `/extend/rules` (proposals with their evidence, rules and cases, the impact per case and profile, approval), `/extend/tools` (grants with their tools, entities, expiry and rate limit, approval and revocation, the request log with denials), `/extend/packs` (the reviewed catalog with manifest hashes and upgrade paths, installs with their state, snapshot and rollback). Each screen names its authoritative source; the capabilities screen offers the four capabilities.

Verification: `tests/browser/workspace.spec.mjs` extensibility journey on the production composition — report authoring activated by two principals (the other three seeded), a definition built, published by the reviewer and run with its checksum, a proposal assessed and approved, a grant approved and revoked with a denial in the log, a pack installed by the worker and rolled back, WCAG checks (also in CI).

## P18x-05 acceptance and operations

Acceptance: P18-T01–T05 in `scripts/test-p18-domain.mjs` and `scripts/test-p18-api.mjs`; CORE regressions unchanged; migration, restore and fresh/upgrade paths in `scripts/ci-database.mjs`. `P18-RUNBOOK.md` covers the activation gates per feature, the allowlists, the operating rules and the rollback rule.

## Open items for the owner

- Security/Finance acceptance of the report catalog (metrics, dimensions, budget), the client tool allowlist and the pack catalog is required before any activation; the shipped packs (`retail-ph` 1.0.0/1.1.0, `services-ph` 1.0.0) are configuration-only fixtures for review.
- No seeded role template holds the P18 authorities; tests and the journey create a builder and an independent reviewer. Client integrations are principals without membership.
- Golden-case impact covers the tax effect of VAT-type cases from the shipped accounting cases; withholding and percentage-tax cases need their kernel path before a proposal may cite them.
- Report exports (CSV/PDF with scope, cutoff and checksum) ride the existing report export path; the checksum recorded on each run is the reproducibility reference.
- Peer benchmarking needs a separate privacy and cohort design; government withholding stays deferred.
- `ADR 001` still names NestJS/Vitest; the codebase remains plain Node + `node:test` (see `P02-REVIEW.md`).
