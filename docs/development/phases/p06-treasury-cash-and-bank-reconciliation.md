# P06 Treasury cash and bank reconciliation

**Depends on:** P05. **Release:** complete supported module or explicitly enumerated feature release. **Baseline:** shared data/API/security specifications and RG-01–08 apply in full.

## Shipped scope

Complete supported-bank CSV reconciliation, manual transfer controls, checks/PDCs, cash count/handover, payment-file generation and explicit settlement confirmation. No direct bank execution is implied by file export.

## User flow and states

Statement upload → validate totals/duplicates → stage → propose matches → reviewer confirms → reconciled snapshot. Payment authorize → generate locked bank file → release evidence/unknown → settle/return. PDC receive/issue → custody/release → present/deposit → clear or dishonor → linked replacement.

## Data and migration contract

Shared bank/check/reconciliation tables plus bank_file_runs(bank_account_id,format_version,hash,state,export_evidence), bank_file_items(run_id,payment_id,amount), cash_sessions(branch_id,cashier,opened_at,closed_at,expected,counted,variance,state), cash_count_lines(session_id,denomination,quantity), transfers(from_account,to_account,currency,amount,state), and handovers(session_id,outgoing,incoming,attestations).

All references use tenant/entity/book composite scope as applicable. Positive amount/quantity checks, unique source keys and enum checks are database-enforced. Archive referenced masters; retain immutable posted facts. Index owner/state/due queues and source/period lookups with tenant/entity leading columns.

## Calculation and business rules

CSV contract: source_line_key, booked_date YYYY-MM-DD, value_date optional, signed_amount decimal (credit to bank positive), currency, reference, description. Batch supplies opening/closing balances; opening + lines = closing. Duplicate line keys across imports do not repost. Match candidate hierarchy exact reference/currency/amount, then deterministic date/amount suggestions; never silently confirm ambiguous matches. Partial/grouped matches conserve amounts. Fees/exchange differences require approved journal, not tolerance write-off. Transfers post both sides in one command or a documented clearing path. PDC receipt is custody only until approved recognition event; default collection accounting at clearing, with no available-cash inflation. Bounce reverses only recorded settlement. Cash variance requires reason and approved expense/receivable policy, never overwrite counted value.

## Screens and interaction

Bank import preview, side-by-side matching, split/group allocations, difference breakdown; payment runs; check register and release calendar; cashier close with denominations, deposits, handover signatures and unresolved variance. Export file displays generated versus bank-accepted versus settled.

Every screen implements empty/loading/error/forbidden/stale-version/retry states and keyboard/mobile review behavior. No UI action bypasses API/domain rules. Output lists provide permitted CSV/PDF exports with scope, cutoff and checksum.

## Commands and service boundaries

Use the typed operations listed for P06 in [OpenAPI](../contracts/openapi.json) and the shared command envelopes. Only the owning application service may execute transitions; side effects use outbox. Every financial effect calls PostingService inside the same transaction. Any additional endpoint needed to expose the specified screens must use the read/list and versioned-mutation conventions and be added to the reviewed OpenAPI before implementation; it may not invent a second payload/state model.

## Acceptance scenarios

- P06-T01: AC-07 and CORE-10/12; ambiguous match remains unconfirmed.
- P06-T02: Statement opening + lines differs from closing: reject completion.
- P06-T03: Repeat payment file generation/release with same key and get one run/effect.
- P06-T04: Bounced partial PDC preserves unrelated allocations and creates linked reversal.
- P06-T05: Cashier cannot certify own required independent handover; variance remains visible.

Also pass CORE-01–18 where applicable, previous-phase regressions, migration/restore/load checks for the new tables and the complete UI/API journey. The exact scoped BRD IDs are in [requirements.json](../contracts/requirements.json).

## Migration and recovery

Add treasury tables; convert P05 manual payments to references without rewriting prior journal lines. Start bank reconciliation from signed opening statement cutoff; historical matched status cannot be fabricated.

## Activation and release

Qualify one actual pilot bank format/check layout with bank/customer acceptance, signer matrix and outbound custody controls. Direct bank API remains disabled unless separately contracted and tested. On rollback stop new release files, reconcile all released/unknown effects first.

## Build order inside this phase

1. Add typed contracts, SQL migrations and permission/capability definitions.
2. Implement deterministic domain/state rules and transaction/repository tests.
3. Implement controllers, imports/jobs/provider adapter and idempotency/failure paths.
4. Implement complete UI journey, reports/evidence and accessible recovery states.
5. Run acceptance/regression/security/migration/recovery tests; record evidence and operator runbook.
6. Release the module with activation gates satisfied for each enabled customer profile. No later phase is reserved merely to harden this module.
