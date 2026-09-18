# Acceptance verification and accounting cases

## Testing obligations

Use real PostgreSQL for repository, transaction, RLS, concurrency and migration tests. SQLite or mocked repositories cannot prove posting behavior. Provider simulators are valid for deterministic failure tests; real-provider sandbox/certification is additionally required before live activation. UI tests must exercise the shipped API, not replace it with fixture HTTP responses except explicitly labelled P01 simulations.

Domain tests cover each posting template, tax profile branch, allocation and state transition. Integration tests cover transactions, lock conflicts, tenant constraints, immutability, outbox and retry. Browser tests cover complete role journeys, failures and recovery. API contract tests validate request/response examples and authorization. Property tests generate balanced/unbalanced journals, partial allocations, multi-line tax rounding and date boundaries. Load tests use the agreed profile, not only single-user happy paths.

## Shared test IDs

| ID | Setup and action | Expected outcome |
| --- | --- | --- |
| CORE-01 | Send same financial command 100 times with same key | One business effect, one official number; original response/resource returned |
| CORE-02 | Same key, different amount | 409 conflict, no new effect |
| CORE-03 | Two clients update version 4 | One accepted to 5, other 412; no lost update |
| CORE-04 | Maker approves via another assigned role or delegation | Denied; independent-actor rule preserved |
| CORE-05 | Change payee/amount/tax after approval then post | Approval invalidated; post denied |
| CORE-06 | Post while controller locks same period | Serialized result: post before lock or rejected after lock; no post through locked state |
| CORE-07 | Runtime SQL attempts journal edit/delete/unbalanced insert | Database denies; original unchanged |
| CORE-08 | Alter tenant/entity IDs on every access surface | No unauthorized record, count, file or tool result |
| CORE-09 | Crash after DB commit before HTTP response | Retry finds committed result; no duplicate |
| CORE-10 | Crash after provider accepts before acknowledgement persisted | Unknown state; query/reconcile before resend; no duplicate remote effect |
| CORE-11 | Duplicate source batch ID with changed checksum | Conflict and owned exception; no silent overwrite |
| CORE-12 | Concurrent allocations exceed one open item's balance | One succeeds, conflicting command denied; never negative outstanding |
| CORE-13 | Required evidence still quarantined | Approval/post blocked with evidence status |
| CORE-14 | Revoke actor while export/AI/job waits | Reauthorization fails; no new result/download/action |
| CORE-15 | Modify/delete archived audit event | Checkpoint verification detects tampering and alerts |
| CORE-16 | Disable AI or model provider outage | Manual workflows and deterministic controls still work |
| CORE-17 | Restore previous snapshot with pending external effects | Reconcile before resuming sends; totals/holds/evidence verified |
| CORE-18 | Request unsupported/disabled production feature directly | 409 FEATURE_NOT_ENABLED; no hidden draft effect |

## Financial examples

The JSON cases are synthetic accounting fixtures, not tax advice or asserted bank tax treatment. Rates are named test profiles. Every amount is a string; expected debit and credit totals must balance exactly. Implement them both as service tests and report reconciliation tests.

| Case | Expected posting |
| --- | --- |
| AC-01 invoice | PHP 10,000 net + 1,200 test output tax: Dr AR 11,200; Cr revenue 10,000; Cr output tax 1,200 |
| AC-02 collection | Dr bank 11,200; Cr AR 11,200; open item closes |
| AC-03 bill with accrual withholding | Dr expense 10,000; Dr eligible input tax 1,200; Cr AP 11,000; Cr withholding payable 200 |
| AC-04 bill payment | Dr AP 11,000; Cr bank 11,000; withholding is not recognized twice |
| AC-05 customer withholding collection | Dr bank 11,000; Dr withholding receivable 200; Cr AR 11,200; certificate evidence remains pending |
| AC-06 credit note | Half of AC-01: Dr revenue 5,000; Dr output tax 600; Cr AR 5,600; original unchanged |
| AC-07 bank fee | Dr bank fees 50; Cr bank 50; separate approved adjustment, not hidden match tolerance |
| AC-08 asset monthly depreciation | Cost 120,000, residual 0, 60 months: Dr depreciation expense 2,000; Cr accumulated depreciation 2,000 |
| AC-09 inventory issue | FIFO 10 units at 100, issue 4: Dr COGS 400; Cr inventory 400; quantity 6, value 600 |
| AC-10 FX settlement | USD 100 AR recognized at 56=5,600 PHP; settled at 57=5,700 PHP: Dr bank 5,700; Cr AR 5,600; Cr FX gain 100 |

Negative cases: 0.01 imbalance; missing mandatory dimension; control account manual source; locked period; invoice line/header discrepancy; unsupported currency; excessive credit; simultaneous double payment; unapproved/expired tax profile; retired document series; forged provider acceptance; same supplier invoice with punctuation/case variations; one certificate claimed twice. Expected outcome is deterministic error and no financial/outbox mutation.

## Phase-specific acceptance

Each phase's `Pxx-Tnn` cases are mandatory and reference shared tests as needed. Every original BRD requirement has a row in `requirements.json` linking phase, owning specification and required evidence. A mapped requirement is not automatically implemented; the delivery backlog tracks implementation and test evidence separately.

Acceptance record format: requirement IDs; scenario ID; build/image hash; migration/schema version; environment and workload; input fixture hash; expected/actual results; report/export checksum if relevant; tester; date; defect links; accountable reviewer. No screenshots alone as evidence for ledger correctness.

## Prototype usability protocol

Recruit eight representative users, split across primary roles and at least two inexperienced participants. Give a 5-minute orientation, then six critical task cards without step-by-step guidance. Record independent completion, active time, errors/rework, help requests and participant sentiment; distinguish facilitator rescue from success. Target 90% unassisted completion overall with no role-blocking defects or control bypass. Record limitations of this small sample; repeat with the selected live pilot cohort before production activation.

## Regression and upgrade gates

Run previous-phase UI/API cases and all shared invariants for every release. Test migrations against empty DB, last release with representative data and a failed/restarted migration. Restore tests check attachments, period locks, source ownership and pending transmissions as well as table counts. Load/recovery evidence must identify hardware and concurrent workload; passing a unit suite is not production-readiness proof.

## Specification validation

The bundled validation script checks file links, required phase contracts, source requirement coverage, unique API operation IDs, internal JSON references, accounting fixture balance and explicit deferred scope. It does not run PostgreSQL, certify provider schemas or test an application that has not been built.

## Design and tracker checks

Every UI release verifies the [design and asset contract](12-design-and-assets.md): current logo, asset integrity, theme, keyboard operation, responsive layouts and contrast. At handoff, update build tickets and evidence following [build tracking](13-build-tracking.md); run `python scripts/build_status.py check` to verify generated data matches the plan. This check is tracker validation, not application acceptance.
