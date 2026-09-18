# P12 Evidence backed AI assistance

**Depends on:** P07; enabled target modules. **Release:** complete supported module or explicitly enumerated feature release. **Baseline:** shared data/API/security specifications and RG-01–08 apply in full.

## Shipped scope

Optional capture/coding/matching suggestions, exception explanations, finance questions, close/audit drafts and local document readers with measurable quality. Deterministic controls remain authoritative.

## User flow and states

Authorized evidence selection → provider policy/masking → model request with constrained tool schema → validated suggestion or abstain → source-linked review → named user accepts/edits/rejects → normal domain command. No tool directly approves/posts/sends/files/pays.

## Data and migration contract

ai_runs(feature,model_version,prompt_version,tool_schema_version,input_refs,scope,started/completed,cost,status), ai_suggestions(run_id,fields_json,source_spans,uncertainty,review_decision,reviewer), evaluation_sets(id,version,hash,consent_basis), evaluation_results(metrics,failures), and model_feature_configs(tenant,feature,enabled,budget,provider_policy). Store only minimized input/output per approved retention policy.

All references use tenant/entity/book composite scope as applicable. Positive amount/quantity checks, unique source keys and enum checks are database-enforced. Archive referenced masters; retain immutable posted facts. Index owner/state/due queues and source/period lookups with tenant/entity leading columns.

## Calculation and business rules

Allowlist tools: read permitted source, read canonical report, propose draft fields, propose task/comment and explain deterministic finding. Deny arbitrary SQL, filesystem, arbitrary URLs and outbound communication. Numeric answers come from canonical reports with entity/book/period/currency/as-of and source links; model prose cannot replace calculated values. Uploaded text is data, not instruction. Coding learns only through reviewed tenant-specific mappings; no shared training without explicit approval. Missing/poor-quality evidence causes abstain or field uncertainty. Evaluate at least 200 held-out local bills including handwriting and poor scans before enabling those readers; require Finance-approved material-field error thresholds, zero unauthorized actions and no control bypass. Match suggestions never auto-reconcile ambiguous lines.

## Screens and interaction

Source/draft split view, per-field evidence and uncertain marker; review all material tax/payee/amount fields; ask-your-books with scope banner; run history and explain/accept/edit/reject; feature opt-out. Registration/audit packs show evidence gaps and cannot sign attestations.

Every screen implements empty/loading/error/forbidden/stale-version/retry states and keyboard/mobile review behavior. No UI action bypasses API/domain rules. Output lists provide permitted CSV/PDF exports with scope, cutoff and checksum.

## Commands and service boundaries

Use the typed operations listed for P12 in [OpenAPI](../contracts/openapi.json) and the shared command envelopes. Only the owning application service may execute transitions; side effects use outbox. Every financial effect calls PostingService inside the same transaction. Any additional endpoint needed to expose the specified screens must use the read/list and versioned-mutation conventions and be added to the reviewed OpenAPI before implementation; it may not invent a second payload/state model.

## Acceptance scenarios

- P12-T01: Document prompt injection cannot change tool authority, leak tenants or send messages.
- P12-T02: Canonical finance questions return exact report totals; unsupported questions abstain.
- P12-T03: Provider timeout/budget exceeded leaves manual work fully usable.
- P12-T04: Model/prompt update failing held-out metrics cannot activate.
- P12-T05: Actor revoked during run cannot retrieve result or execute suggested action.

Also pass CORE-01–18 where applicable, previous-phase regressions, migration/restore/load checks for the new tables and the complete UI/API journey. The exact scoped BRD IDs are in [requirements.json](../contracts/requirements.json).

## Migration and recovery

No vectors/shared training required for first release. Add AI run/suggestion tables and explicit per-feature opt-in. Existing deterministic controls unchanged; migrations never infer approved training consent.

## Activation and release

Privacy/security approves provider region/retention/training terms; Finance accepts evaluation threshold and results; Product measures review time versus baseline. No invented confidence threshold from model self-rating. Rollback feature/model version only, not accounting records.

## Build order inside this phase

1. Add typed contracts, SQL migrations and permission/capability definitions.
2. Implement deterministic domain/state rules and transaction/repository tests.
3. Implement controllers, imports/jobs/provider adapter and idempotency/failure paths.
4. Implement complete UI journey, reports/evidence and accessible recovery states.
5. Run acceptance/regression/security/migration/recovery tests; record evidence and operator runbook.
6. Release the module with activation gates satisfied for each enabled customer profile. No later phase is reserved merely to harden this module.
