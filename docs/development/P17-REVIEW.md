# P17 implementation review — 21 September 2026

P17 is in progress, not released. For each of the five feature releases (P17A leases, P17B statutory discounts, P17C marketplace and POS, P17D payroll data and remittances, P17E local obligations) build-order steps 1–5 are implemented; no feature capability is activated for a live entity and no authority, provider or accounting example has been reviewed by the owner.

## P17x-01 contracts and migration

Contracts: the reviewed lease (5) and discount eligibility (5) operations were in the OpenAPI; the escalation steps and base rent were added to the lease schema and a masked identity reference to the eligibility schema as optional additions. Under the phase rule that screens may add read/list and versioned-mutation operations, 35 entity-scoped operations were added and the catalog regenerated (464 operations): lease schedule, events and billing; the invoice discount application and its lines; channels, payouts (reconcile, post), POS machines and closings (approve, match); payroll batches (records, approve, post) and remittances (approve, remit); local obligations (complete, waive). Twenty-two permissions were published (`permissions.json`) and seeded; the five capabilities were defined with their dependencies.

Migration `0032_p17_local_operations.sql`:

- `lease_contracts` (one per billing schedule, evidence, approved by another principal, terms frozen once approved) and append-only `lease_events` (applications and refunds carry an approver other than the recorder).
- `discount_eligibility` (one live per customer and category, evidence, approved by another principal, immutable once approved, revoked final) and `discount_lines` (one per document line).
- `channels`, `payout_batches` (unique per channel and source; net = gross − fees − withholding − other deductions; posted only from reconciled with an entry; immutable once posted), `pos_machines` (unique per serial and MIN) and `pos_closings` (unique per machine, shift and reading; gross = ending − beginning; approved by another principal; matched only with a deposit).
- `payroll_batches` (unique per file; approved by another principal; posted once per source and period), append-only `employee_tax_records` (identifier encrypted and masked) and `remittance_records` (unique per agency, period and batch; remitted only with a reference and evidence).
- `local_obligations` (unique per authority, kind, period and property; complete only with payment evidence and, where required, filing evidence; complete and waived final).
- RLS `tenant_scope` policies, `touch_row` triggers, grants to `lara_api`; the runtime role cannot delete these records.

Verification: `scripts/test-p17-schema.mjs` (7 groups) in CI on fresh and upgraded databases; teardown and snapshot tooling cover the twelve new tables.

## P17x-02 domain rules

`packages/domain/src/localops.mjs`:

- Leases: schedule from the base rent with every escalation step compounded from its boundary; billing one schedule month at the escalated rent from the schedule's template invoice; deposits and advances received into the profile's liabilities within the contract, applied by another principal as a non-cash settlement of a posted rent invoice through the allocation model (no revenue again) or refunded (P17-T01).
- Statutory discounts: eligibility validated against the approved profile (required identity evidence, expiry, one live per customer and category); application to a draft invoice discounts each line on an eligible account on the profile's basis and exempts it, records the golden case, refuses customers without approved eligibility, expired eligibility at the document date and posted invoices (P17-T02).
- Marketplace and POS: a payout's deductions must explain the net; reconciliation to posted invoices or journal entries whose total equals the gross, each sales reference used once; posting once with the net to clearing, fees and withholding recognized and the channel receivable settled; a replayed statement is refused; closings validated (readings, gross) and matched to a posted deposit with the difference as an exception (P17-T03).
- Payroll: records validated line by line and against the totals (an untying file stays an exception), the file hash refuses replays, individual records behind `payroll_record.read` with encrypted storage and masked display and an audit per read, the journal per the approved profile once per source and period, remittances tied to the batch totals and remitted on evidence (P17-T04).
- Local obligations: the authority profile decides kinds and filing requirements; completion needs payment evidence and, where required, filing evidence, by the completing authority; waivers need a reason (P17-T05).

Verification: `scripts/test-p17-domain.mjs` (6 groups) covers P17-T01–T05.

## P17x-03 API

All 45 P17 operations are served by `apps/api/src/workspace-api.mjs`; each feature answers `FEATURE_NOT_ENABLED` until its capability is active and `RULE_PROFILE_NOT_APPROVED` until its profile is approved.

Verification: `scripts/test-p17-api.mjs` (6 groups, API as a process, in CI): a lease through approval, schedule, billing, the invoice review and the deposit received and applied; eligibility through approval and the discount applied; a channel, payout reconciliation and posting, a machine and a matched closing; a payroll batch with restricted records, approval, posting and a remittance; an obligation completed on evidence and another waived; gates.

## P17x-04 user journeys

`apps/web/src/app/_components/workspace-localops.tsx`: `/local` (leases, schedule with billing, deposits and advances), `/local/discounts` (eligibility, approval, application to a draft invoice with the recorded lines), `/local/channels` (channels, payouts with reconciliation and posting, POS machines and closings with approval and matching), `/local/payroll` (batches, restricted records, approval, posting, remittances), `/local/obligations` (obligations, completion with evidence, waiver). Each screen names its authoritative source and the unsupported variants; the capabilities screen offers the five features; the navigation gained the Extensibility placeholder (P18).

Verification: `tests/browser/workspace.spec.mjs` local operations journey on the production composition — lease billing activated by two principals (the other four seeded), a lease approved, scheduled, billed and its deposit received, an eligibility approved and applied, a payout reconciled and posted, a closing approved and matched, a payroll batch with masked records approved and posted and its remittance recorded, an obligation completed only with the filing evidence, WCAG checks (also in CI).

## P17x-05 acceptance and operations

Acceptance: P17-T01–T05 in `scripts/test-p17-domain.mjs` and `scripts/test-p17-api.mjs`; CORE regressions unchanged; migration, restore and fresh/upgrade paths in `scripts/ci-database.mjs`. `P17-RUNBOOK.md` covers activation gates per feature, the operating rules and the rollback rule.

## Open items for the owner

- No seeded role template holds the P17 authorities; tests and the journey create an operations officer, a reviewer and HR.
- Lessee right-of-use and lease liability measurement is not inferred from recurring rent and is not part of this release.
- Discount categories beyond the profiles the advisor approves cannot be recorded; VAT treatment follows the profile's exemption tax code.
- Channel sales import rides the existing journal and invoice imports; a provider statement adapter arrives with a reviewed source format.
- Payroll integrations beyond the validated file import are Phase 3; 2316 rendering from the imported data arrives with the report increment.
- `ADR 001` still names NestJS/Vitest; the codebase remains plain Node + `node:test` (see `P02-REVIEW.md`).
