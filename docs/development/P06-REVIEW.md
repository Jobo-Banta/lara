# P06 implementation review — 20 September 2026

P06 is in progress, not released. Build-order steps 1 (contracts, migration, permission and capability definitions), 2 (domain and accounting rules), 3 (API and jobs), 4 (user journeys) and 5 (acceptance and operations) are implemented; no `treasury` capability is activated for a live tenant, no bank account is approved outside test tenants and no bank file has left the system. No operation executes at a bank.

## P06-01 contracts and migration

Contracts: the 34 P06 operations (`/bank-accounts` create/list/get/edit/approve, `/bank-matches` create/list/get/edit/confirm/reverse, `/transfers` create/list/get/edit/submit/approve/post, `/checks` create/list/get/edit/release/deposit/clear/dishonor, `/cash-sessions` create/list/get/edit/count/close/handover) and their schemas were already in the reviewed OpenAPI; the treasury permissions and capability (depends on `purchasing`) were seeded by `0009`. Under the phase rule that screens may add read/list operations, two reads were added and the catalog regenerated (353 operations): `GET /bank-statement-lines` (`bankAccountId`, `matchState`) returning `BankStatementLineList`, and `GET /bank-reconciliation` (`bankAccountId`, `asOf`) returning `BankReconciliationView` (statement balance, ledger balance, difference, unmatched lines and settlements). Bank statements enter through the reviewed P03 import pipeline (`POST /imports` with `kind=bank_statement`, `sourceId` = approved bank account id), so no upload operation was invented.

Migration `0021_p06_treasury_schema.sql`:

- `bank_accounts` (encrypted number with digest and last four, unique per bank and number, draft → approved | rejected → draft | archived, approver distinct from author, approved content changes only through a new draft); `settlements.bank_account_id` now references it (`not valid` for earlier rows).
- `bank_statement_batches` (one per committed import, unique content hash per account, opening and closing balances, append-only) and `bank_statement_lines` (single-use `source_line_key` per account, non-zero signed amount, source text preserved, `match_state` derived).
- `reconciliation_matches` (draft | proposed → confirmed | rejected → reversed; manual matches refuse the preparer as confirmer; confirmed content immutable) and append-only `reconciliation_allocations` whose guard refuses any confirmed amount beyond a statement line's amount or a counterpart's capacity (a posted settlement's cash, or the journal entry's movement on the bank's ledger account), checks direction and currency, and mirrors reversals once.
- `check_instruments` (unique per bank, direction and number; custody → deposited → cleared → dishonored for received, drafted → released → cleared | dishonored for issued; amount, party and number fixed once in circulation; a clearing time is mandatory; `replaces_id`).
- `transfers` (distinct accounts, draft → submitted → approved → posted, approver distinct, posted content immutable).
- `cash_sessions` (one open session per branch, cashier and date; open → counted → closed → handed_over; counted values need a reason when they differ and are never overwritten after close), append-only `cash_count_lines` and `cash_handovers` (outgoing ≠ incoming, attestations).
- `bank_file_runs` (unique content hash per account, immutable, generated → accepted | rejected) and `bank_file_items` (one run per payment).
- `opening_batches` accept a committed `bank_statement` without a journal entry or balanced totals.

Verification: `scripts/test-p06-schema.mjs` (9 groups) in CI on fresh and upgraded databases; teardown and snapshot tooling cover the twelve new tables.

## P06-02 domain and accounting rules

`packages/domain/src/treasury.mjs`:

- Treasury profile (`settings_versions` kind `treasury_profile`): petty cash and cash variance accounts, `fileFormatVersion`, `matchWindowDays`.
- Bank accounts: active non-control asset ledger account in the book's currency, verification evidence, encrypted number shown masked; approval by another principal.
- Statement CSV contract: `source_line_key, booked_date, value_date, signed_amount (credit to bank positive), currency, reference, description`, plus `opening_balance` and `closing_balance` rows. Validation (owned by treasury, invoked by `ledger.validateImport` through an injected hook) checks currency, dates within the cutoff, in-file duplicates and opening + lines = closing (P06-T02); keys already imported for the account count toward the balance but are never written again. Commit writes the batch and lines, posts nothing and queues `bank.propose_matches`.
- Proposals (worker job): for an unmatched line, a single posted settlement of the right direction with the same amount and the line's reference is proposed; failing that, a single settlement with the same amount within the window. Several candidates leave the line unmatched and are audited (P06-T01). Proposals are confirmed by any reviewer; manual matches need a confirmer other than the preparer.
- Matches conserve amounts (allocations equal the lines' unmatched total); a fee or difference is never absorbed — it needs its own approved journal, matched by its posted entry against the bank's ledger account (AC-07). Confirmation writes guarded allocation rows so confirmed amounts never overlap on a line or a counterpart (CORE-12); reversal mirrors them once.
- Reconciliation view: statement closing balance versus the ledger balance of the bank account at the cutoff, unmatched lines and posted settlements not yet on a statement; also available as report type `bank_reconciliation` (bank account through the request's `dimensions.bankAccountId`).
- Transfers between approved accounts of one book post both sides in one entry (`Dr destination / Cr source`) after independent approval; posting is idempotent.
- Checks: a received check is custody only — `sales.postCollection` refuses to post a receipt linked to a check that has not cleared (no available-cash inflation); clearing is the recognition event; dishonor after clearing posts the linked reversal of that settlement only (`sales.reverseSettlementEffect`, injected) and unwinds only its allocations (P06-T04); a replacement links through `replaces`. Issued checks are released to the payee and clear at the bank.
- Cash sessions: expected cash is the float plus posted cash receipts less posted cash payments of the business date; a variance needs a reason; close posts the variance under the profile accounts (shortage `Dr cash over and short / Cr cash`, overage the reverse) or refuses without a policy; the handover is attested by an incoming principal other than the cashier (P06-T05) and records the counted value and variance.
- Bank file runs: `purchasing.releasePayment` with channel `bank_file` calls the injected `treasury.generateBankFile`, which writes one locked CSV (format version, payment id, beneficiary bank and last four, amount, currency, value date, reference) to the object store as restricted evidence, records the run and its item and returns the file hash as the release reference; the payment state machine and the command envelope make repeated generation a single run (P06-T03). `qualified_api` stays refused.

Verification: `scripts/test-p06-domain.mjs` (8 groups) covers P06-T01–T05, single-use line keys, transfers and the reconciliation view; P03, P04 and P05 suites pass with the treasury hooks registered.

## P06-03 API and jobs

All 34 operations plus the two reads are served by `apps/api/src/workspace-api.mjs`; `POST /imports/{id}/validate` and `/commit` carry the treasury hooks for `bank_statement` imports; `POST /payments/{id}/release` carries the bank-file generator and object store; `POST /checks/{id}/dishonor` carries the settlement reversal effect. The worker runs `bank.propose_matches` after each statement commit (rechecking the committer's `import.commit`) and renders `bank_reconciliation` reports.

Verification: `scripts/test-p06-api.mjs` (8 groups, API and worker as processes, in CI): bank account review over HTTP, statement import with the unbalanced refusal and idempotent commit, the propose job, line and reconciliation reads with contract shapes, fee refusal, journal match, `SELF_APPROVAL` on confirmation, reversal, transfers, checks, cash sessions, bank-file release under replay and a refused second release, evidence download of the run, isolation.

## P06-04 user journeys

`apps/web/src/app/_components/workspace-treasury.tsx`: bank accounts (draft with masked number, approval), the reconciliation workbench (bank account and cutoff, difference breakdown, statement lines with selection, counterparts with allocation inputs and a journal-entry allocation, conserve-amount status, proposals and matches with confirm, reject and reverse), transfers, the check register with a release calendar and custody actions, and cashier sessions with denomination counts, variance reason, close and handover. The imports screen offers the `bank_statement` kind; the capabilities screen offers treasury activation; routes `/bank/accounts`, `/bank/reconcile`, `/bank/transfers`, `/bank/checks`, `/bank/cash`.

Verification: `tests/browser/workspace.spec.mjs` treasury journey on the production composition — two-principal activation, ledger accounts, two bank accounts entered and approved on screen, statement uploaded as CSV evidence and imported through the pipeline (validate, approve, commit), worker proposals confirmed on the workbench until nothing is unmatched, a transfer through approval and posting, a check from custody through deposit and clearing, a cash session counted with a variance, closed, refused to the cashier and attested by the controller, WCAG checks on every treasury route (also in CI).

## P06-05 acceptance and operations

Acceptance: P06-T01–T05 in `scripts/test-p06-domain.mjs` and `scripts/test-p06-api.mjs`; CORE regressions unchanged; migration, restore and fresh/upgrade paths in `scripts/ci-database.mjs`. `P06-RUNBOOK.md` covers activation gates, the statement contract, ambiguous matches, fees, check custody, cash variance, bank file custody and the rollback rule (stop new release files, reconcile released or unknown effects first).

## Open items for the owner

- No reviewed operations exist for the treasury profile, statement batches, bank file runs, cash count lines or handover attestations; the domain implements `listStatementBatches`, `listBankFileRuns`, `cashSessionDetail` and `sessionSummary`, and `CashSessionResource` cannot carry the variance (`additionalProperties: false`), so the screens show it through the closing entry and the audit reason.
- No seeded role template holds `transfer.approve`, `transfer.post` or a second `cash_session.handover` principal; tenants create an approver role (tests and the journey do).
- The reconciliation view treats posted transfer-method settlements without a bank account as belonging to the account under review; naming the bank account on every settlement (the P05 payment screen and the P04 receipt screen do not yet) removes the heuristic.
- `release_unknown` and `failed` payment states and `bank_file_runs.state` accepted/rejected exist but no operation reaches them until a bank reports; the pilot bank format is `lara-csv-1` and needs bank acceptance before activation.
- `CheckCreate` has no replacement link; replacements are recorded through the domain only.
- `ADR 001` still names NestJS/Vitest; the codebase remains plain Node + `node:test` (see `P02-REVIEW.md`).
