# P18 Controlled extensibility and advanced assistance

**Depends on:** P12/P14–P17 as applicable. **Release:** complete supported module or explicitly enumerated feature release. **Baseline:** shared data/API/security specifications and RG-01–08 apply in full.

## Shipped scope

Independently shipped P18A report authoring, P18B rule-change/impact proposals, P18C external draft tools and P18D versioned industry packs. Peer benchmarking and deferred government withholding are explicitly not activated by this phase.

## User flow and states

Authorized builder selects allowlisted fields/metrics or draft tools → preview under current permissions → validate → reviewer publishes version → execute under caller scope → audit. Rule ingestion proposes changes/test cases; qualified human review and software release assessment precede activation.

## Data and migration contract

report_definitions(metric_ids,dimension_ids,filters,sort,version,state), custom_fields(resource_type,key,type,validation,visibility), tool_grants(client_id,allowed_tools,scope,expiry), rule_proposals(source_evidence,delta,impact_run,test_cases,state), pack_versions(manifest,dependencies,schemas,rule_refs,migrations,hash,state).

All references use tenant/entity/book composite scope as applicable. Positive amount/quantity checks, unique source keys and enum checks are database-enforced. Archive referenced masters; retain immutable posted facts. Index owner/state/due queues and source/period lookups with tenant/entity leading columns.

## Calculation and business rules

Report builder compiles an allowlisted query AST to parameterized queries; no raw SQL/JS, arbitrary joins or access to masked fields. Max query cost/row/time budget; async export uses scoped snapshot. Custom fields cannot replace statutory/accounting fields or bypass validation. Client tools may read authorized reports and propose drafts/tasks only; every request has scoped identity, request schema, idempotency and rate limits. No autonomous posting/approval/payments/filing/sending. Rule proposals show affected profiles/periods and cannot rewrite historical postings. Industry packs ship reviewed reusable configuration/code with dependency and upgrade tests, not customer forks. Tax computation comparisons use approved deterministic calculators and advisor review.

## Screens and interaction

Report field/metric builder and saved report; rule source/diff/impact/review; tool client grant and revocation; pack install/upgrade preview with disabled unsupported dependencies.

Every screen implements empty/loading/error/forbidden/stale-version/retry states and keyboard/mobile review behavior. No UI action bypasses API/domain rules. Output lists provide permitted CSV/PDF exports with scope, cutoff and checksum.

## Commands and service boundaries

Use the typed operations listed for P18 in [OpenAPI](../contracts/openapi.json) and the shared command envelopes. Only the owning application service may execute transitions; side effects use outbox. Every financial effect calls PostingService inside the same transaction. Any additional endpoint needed to expose the specified screens must use the read/list and versioned-mutation conventions and be added to the reviewed OpenAPI before implementation; it may not invent a second payload/state model.

## Acceptance scenarios

- P18-T01: Query attempts unauthorized field/join or resource overrun and is rejected.
- P18-T02: Client tool attempts approve/post/exfiltrate despite prompt injection and is denied.
- P18-T03: Rule proposal cannot activate without independent review and passing test examples.
- P18-T04: Pack upgrade preserves original data/profile snapshots and supports compatible rollback.
- P18-T05: Multi-client custom report applies client mandate to each result and aggregate.

Also pass CORE-01–18 where applicable, previous-phase regressions, migration/restore/load checks for the new tables and the complete UI/API journey. The exact scoped BRD IDs are in [requirements.json](../contracts/requirements.json).

## Migration and recovery

Store definitions/grants/pack manifests; no runtime tenant scripting engine. Version query AST/schema and retain compiled report reproducibility. New field backfills are explicit reviewed jobs.

## Activation and release

Security/Finance accepts tool and query allowlist, provider contracts and per-pack tests. Benchmarking requires a future separate privacy/cohort design and is not implementation-ready or promised here. Government withholding remains deferred by original scope decision. Rollback revokes tool grants and reverts definitions without changing financial facts.

## Build order inside this phase

1. Add typed contracts, SQL migrations and permission/capability definitions.
2. Implement deterministic domain/state rules and transaction/repository tests.
3. Implement controllers, imports/jobs/provider adapter and idempotency/failure paths.
4. Implement complete UI journey, reports/evidence and accessible recovery states.
5. Run acceptance/regression/security/migration/recovery tests; record evidence and operator runbook.
6. Release the module with activation gates satisfied for each enabled customer profile. No later phase is reserved merely to harden this module.
