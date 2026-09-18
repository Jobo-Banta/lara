# P07 Tax compliance and e invoicing

**Depends on:** P06. **Release:** complete supported module or explicitly enumerated feature release. **Baseline:** shared data/API/security specifications and RG-01–08 apply in full.

## Shipped scope

Complete enabled taxpayer-profile return preparation, books, filing evidence, registration evidence and durable e-invoice reporting. Every form and adapter is enabled individually only with its authoritative version and test evidence.

## User flow and states

Select period/profile → freeze reconciled source cutoff → compute deterministic tax events/return lines → resolve exceptions → independent approval → export → record external filing/payment acknowledgement. Invoice event → build immutable payload → validate/sign → send → accepted/rejected/unknown → reconcile. Registration checklist → evidence pack → actual external decision recorded separately.

## Data and migration contract

return_runs/lines(line_code,basis,amount,source_query_version), return_source_links(run_id,tax_event_id), filing_records(run_id,external_reference,filed_at,evidence_id), regulatory_profiles(jurisdiction,coverage,version,source_hash,approved_by), schema_artifacts(profile_id,type,version,hash,evidence_id), transmission jobs/attempts and registration_cases(authority,status,scope,evidence).

All references use tenant/entity/book composite scope as applicable. Positive amount/quantity checks, unique source keys and enum checks are database-enforced. Archive referenced masters; retain immutable posted facts. Index owner/state/due queues and source/period lookups with tenant/entity leading columns.

## Calculation and business rules

Supported form registry includes 2550Q/SLSP, 0619-E/1601-EQ/QAP, 1601-FQ/2306 where applicable, 2307/SAWT, 1604-E, payroll-import 2316 and annual income-tax/eAFS preparation as independently enabled outputs. Exact official field widths/codes/schema are imported as reviewed artifacts, not guessed in this spec. For each output store mapping from tax event/account to field, filter basis/date, rounding, validation, totals and authority evidence. No missing mapping may produce a plausible zero. One click books/export uses immutable report snapshot and manifest. EInvoiceTransport contract handles key custody, deadline profile, unknown acknowledgement, signed payload and correction rules. No blanket three-day/PTI/QR claim. Already issued financial data stays immutable; a transport-only re-encoding has versioned hash and reason.

## Screens and interaction

Compliance workbench, readiness with failed/not-tested states, return-to-ledger drill-down, certificate matrix, registration pack, filing/payment evidence, reporting queue with deadline and accountable owner. Plain-language rejection view distinguishes financial correction from envelope repair.

Every screen implements empty/loading/error/forbidden/stale-version/retry states and keyboard/mobile review behavior. No UI action bypasses API/domain rules. Output lists provide permitted CSV/PDF exports with scope, cutoff and checksum.

## Commands and service boundaries

Use the typed operations listed for P07 in [OpenAPI](../contracts/openapi.json) and the shared command envelopes. Only the owning application service may execute transitions; side effects use outbox. Every financial effect calls PostingService inside the same transaction. Any additional endpoint needed to expose the specified screens must use the read/list and versioned-mutation conventions and be added to the reviewed OpenAPI before implementation; it may not invent a second payload/state model.

## Acceptance scenarios

- P07-T01: Every enabled form has golden accepted fixture plus each validation-failure class.
- P07-T02: Return/source/ledger totals tie and replay of old cutoff/profile produces same hash.
- P07-T03: Kill worker after remote acceptance; recover via status query without duplicate submission.
- P07-T04: Unsigned/unapproved payload, wrong taxpayer credentials and expired profile are blocked.
- P07-T05: Generated pack cannot mark actual permit or filing as complete; evidence required.

Also pass CORE-01–18 where applicable, previous-phase regressions, migration/restore/load checks for the new tables and the complete UI/API journey. The exact scoped BRD IDs are in [requirements.json](../contracts/requirements.json).

## Migration and recovery

Add compliance tables/adapter metadata; no live credentials or certified schemas in seed. Backfill existing issued documents into reporting queue only after signed applicability/cutoff plan to prevent historic double reporting.

## Activation and release

Tax lead approves current official schema/form artifacts, taxpayer coverage, correction/retention profiles and golden cases. Provider/taxpayer sandbox/certification and credentials are required. This is an explicit external activation gate; working fixtures alone are insufficient. Rollback pauses transmission, preserves queue and reconciles remote status.

## Build order inside this phase

1. Add typed contracts, SQL migrations and permission/capability definitions.
2. Implement deterministic domain/state rules and transaction/repository tests.
3. Implement controllers, imports/jobs/provider adapter and idempotency/failure paths.
4. Implement complete UI journey, reports/evidence and accessible recovery states.
5. Run acceptance/regression/security/migration/recovery tests; record evidence and operator runbook.
6. Release the module with activation gates satisfied for each enabled customer profile. No later phase is reserved merely to harden this module.
