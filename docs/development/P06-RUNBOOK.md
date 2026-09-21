# P06 treasury cash and bank reconciliation runbook

Extends `P02-RUNBOOK.md` through `P05-RUNBOOK.md`; earlier procedures apply unchanged. Direct edits to committed `lara.bank_statement_batches` and `lara.bank_statement_lines`, `lara.reconciliation_allocations`, checks in circulation, posted `lara.transfers`, closed `lara.cash_sessions`, `lara.cash_count_lines`, `lara.cash_handovers`, `lara.bank_file_runs` or `lara.bank_file_items` are prohibited; the database refuses them for every application role, and a privileged edit is a Sev1 posting-integrity incident handled as in the P03 runbook. Nothing in this module sends money or instructs a bank: files are generated and stored; releases and settlements record what happened.

## Activation gates

Treasury work on an entity needs, in order: the `purchasing` capability active, the `treasury` capability activated with evidence and an independent approval (`/settings/capabilities`), an approved `treasury_profile` settings version naming the petty cash account, the cash variance (over and short) account, the bank file format version (`lara-csv-1` in this release) and the match window in days, and at least one bank account entered from the bank's confirmation and approved by a different principal. Until the reviewed contract gains an operation for the profile, an operator seeds `lara.settings_versions` (kind `treasury_profile`, status `approved`, author and approver different) through the runtime role with the tenant set, exactly as `tests/browser/workspace.spec.mjs` does. Before activation for a live customer: the pilot bank's file layout must be accepted by the bank and the customer, the signer matrix recorded, and outbound custody of generated files agreed; the direct bank API stays disabled unless separately contracted and tested.

## Statement import

Statements are CSV evidence imported under kind `bank_statement` with the approved bank account id as the source: `source_line_key, booked_date (YYYY-MM-DD), value_date (optional), signed_amount (credit to bank positive), currency, reference, description`, plus one `opening_balance` and one `closing_balance` row. Validation refuses a statement whose opening plus lines differs from its closing (`VALIDATION_FAILED` with the difference), lines after the cutoff, currency mismatches and in-file duplicates; keys already imported for the account count toward the balance and are skipped at commit (never reposted). Approval must come from a principal other than the author; commit writes the lines and posts nothing. Start reconciliation from a signed opening cutoff: the first statement's opening balance must equal the ledger balance of the bank account at that date, otherwise record the difference through approved journals before matching. Historical matched status is never fabricated.

## Matching

After each commit the worker proposes matches for lines with exactly one candidate (same amount and direction, exact reference first, then value date within the window); lines with several candidates stay unmatched and the reason is audited (`bank_match.ambiguous`) — never confirm them blindly. A reviewer confirms proposals; a manual match must be confirmed by someone other than its preparer. Matches conserve amounts: the allocations equal the unmatched total of the selected lines, partial and grouped matches included. A bank fee, interest or exchange difference is never a tolerance: post it as an approved journal against the bank's ledger account and match the statement line to the entry. The database refuses any confirmed amount beyond a line or a counterpart (`ALLOCATION_EXCEEDS_BALANCE`). A wrong confirmation is reversed with its reason; the line reopens. The reconciliation view (`GET /bank-reconciliation`) explains the difference between the statement closing balance and the ledger balance through unmatched lines and settlements not yet on a statement.

## Checks

A received (post-dated) check is registered in custody and, when it settles a receipt, links to that receipt with method `check`; the receipt cannot post until the check clears (`STATE_CONFLICT`), so available cash is never inflated. Deposit records the presentation; clearing is the recognition event (post the receipt then). A bounce is recorded with `POST /checks/{id}/dishonor`: when the receipt was posted, the linked reversal posts and only that receipt's allocations unwind; other receipts and allocations stay. A replacement check links to the dishonored one. Issued checks are released to the payee with a reason and clear at the bank; the payment settlement records the money leaving. The release calendar lists checks by due date.

## Transfers

Transfers move money between two approved bank accounts of one book and post both sides in one entry after a submitter and an approver other than the preparer; posting is idempotent. Cross-book and cross-currency transfers wait for P09.

## Cash sessions

One open session per branch, cashier and business date. Count by denomination; the expected cash is the float plus posted cash receipts less posted cash payments of the date at the session's branch (a settlement names its `branchId`; one without a branch belongs to the entity's first active branch, and posts on it); a difference needs a reason and, at close, posts under the profile's variance account (shortage `Dr cash over and short / Cr cash`, overage the reverse). Without a variance policy a non-zero variance cannot close. Counted values are never overwritten after close; a recount before close is a new numbered count. The handover is attested by an incoming principal other than the cashier (`SELF_APPROVAL` otherwise) and records the counted value and the variance.

## Bank files and payment custody

`POST /payments/{id}/release` with channel `bank_file` generates one locked CSV for the authorized payment, stores it as restricted evidence, records the run and uses the file hash as the release reference; the same idempotency key replays, a new key on a released payment is refused, and a payment never appears in two runs. The file is handed to the bank outside the system under the agreed custody; the bank's acceptance and the settlement are then recorded with evidence (`/settle`), or a return with `/return`. On rollback of this module: stop generating release files, then reconcile every released or unknown payment against the bank before anything else. `qualified_api` releases are refused.

## Evidence to preserve

For every treasury incident: trace ids, the `audit_events` range for the entity, the import and statement batch ids with their checksums, the statement line ids, match and allocation ids, check ids, transfer ids, cash session ids with their count numbers and handover ids, bank file run ids with hashes and evidence ids, and the journal entry ids. Export them with `POST /exports` before any operator action.
