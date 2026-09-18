# P05 Purchasing payables and expenses

**Depends on:** P04. **Release:** complete supported module or explicitly enumerated feature release. **Baseline:** shared data/API/security specifications and RG-01–08 apply in full.

## Shipped scope

Complete PO/non-PO services purchasing, bills, supplier credits, advances, expense claims, withholding records and authorized manual payment settlement. Three-way stock matching waits for P10; bank-file automation waits for P06.

## User flow and states

Optional purchase request → approval → PO; bill direct or PO-linked → duplicate/evidence/tax validation → approve → post. Payment proposal → independent authority → record real manual release with evidence → settlement. Employee advance → liquidation lines → return/reimburse difference. Supplier credit/advance application uses linked accounting.

## Data and migration contract

purchase_orders/lines with ordered/received/invoiced amounts, receipts_of_service(order_id,evidence_id,accepted_by), bills as documents, withholding events/certificates, payment_orders/settlements, expense_claims(employee_party_id,advance_id?,policy_version,state), expense_lines(claim_id,expense_date,account_id,tax_rule_id,evidence_id,amount), and beneficiary_versions.

All references use tenant/entity/book composite scope as applicable. Positive amount/quantity checks, unique source keys and enum checks are database-enforced. Archive referenced masters; retain immutable posted facts. Index owner/state/due queues and source/period lookups with tenant/entity leading columns.

## Calculation and business rules

Duplicate key: entity + supplier + normalized supplier invoice reference + approved identity context; retain original reference. Exact duplicate blocks; fuzzy amount/date similarity warns with reviewer disposition. Policy decides PO and receipt-of-service requirements. Withholding timing is profile-selected accrual/payment; tax_events prevent repeated recognition. Payment proposal uses payable residual after recognized withholding/credits and separate approval from bill. Beneficiary change invalidates payment authority. Manual released and settled states need independent evidence; no screen action sends bank money. Advance liquidation posts expense/tax against advance, with remainder refund/payable. Certificates derive from tax events and store reviewed output version.

## Screens and interaction

Bill source/draft review; request/PO list; two-way match differences; supplier aging; payment authority/release evidence; employee claims and unliquidated advances; withholding certificate preview. No dummy PO for utility bills.

Every screen implements empty/loading/error/forbidden/stale-version/retry states and keyboard/mobile review behavior. No UI action bypasses API/domain rules. Output lists provide permitted CSV/PDF exports with scope, cutoff and checksum.

## Commands and service boundaries

Use the typed operations listed for P05 in [OpenAPI](../contracts/openapi.json) and the shared command envelopes. Only the owning application service may execute transitions; side effects use outbox. Every financial effect calls PostingService inside the same transaction. Any additional endpoint needed to expose the specified screens must use the read/list and versioned-mutation conventions and be added to the reviewed OpenAPI before implementation; it may not invent a second payload/state model.

## Acceptance scenarios

- P05-T01: AC-03/04 tie expense/input tax/AP/withholding and ensure payment does not repeat tax.
- P05-T02: Payment-time profile recognizes withholding once at settlement instead.
- P05-T03: Supplier reference with case/spacing/punctuation normalization is detected; legitimate distinct reference can proceed.
- P05-T04: Change beneficiary after approval and reject release; repeated manual settlement yields one effect.
- P05-T05: Liquidate partial advance then return remainder; balances and evidence reconcile.

Also pass CORE-01–18 where applicable, previous-phase regressions, migration/restore/load checks for the new tables and the complete UI/API journey. The exact scoped BRD IDs are in [requirements.json](../contracts/requirements.json).

## Migration and recovery

Introduce purchasing/claims/payment tables with explicit settlement effects. Separate beneficiary encrypted history and reviewed version. Existing customer-only parties can gain supplier role without merging balances.

## Activation and release

Finance signs PO/non-PO policy, withholding profiles, manual payment responsibility and certificate obligations. If required certificate/form output is not available until P07, retain supported external preparation with signed reconciliation boundary or block that customer. Never call unsupported tax workflow complete.

## Build order inside this phase

1. Add typed contracts, SQL migrations and permission/capability definitions.
2. Implement deterministic domain/state rules and transaction/repository tests.
3. Implement controllers, imports/jobs/provider adapter and idempotency/failure paths.
4. Implement complete UI journey, reports/evidence and accessible recovery states.
5. Run acceptance/regression/security/migration/recovery tests; record evidence and operator runbook.
6. Release the module with activation gates satisfied for each enabled customer profile. No later phase is reserved merely to harden this module.
