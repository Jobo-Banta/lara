# P03 general ledger runbook

Extends `P02-RUNBOOK.md`; the workspace procedures (start/stop, deploy, migration, queue, restore, revocation, evidence, exports) apply unchanged. This document adds the ledger-specific procedures. Direct edits to `lara.journal_entries`, `lara.journal_lines`, `lara.report_snapshots` or `lara.periods` are prohibited; the database refuses them for every application role, and a privileged edit is a Sev1 posting-integrity incident.

## Posting integrity (Sev1)

Detection: the deferred balance trigger or `lara.post_journal_entry` raising `UNBALANCED_ENTRY`/`DUPLICATE_SOURCE` in production logs, a trial balance snapshot whose `totals.balanced` is false, or a source version with more than one entry. Response: stop the affected posting capability (`capability_activations.status='disabled'` for `general_ledger` on the entity through the controller's reviewed change), preserve the trace ids and the `audit_events` range, run `select * from lara.account_balances(...)` and the line sums for the book, and open the incident with Controller and Engineering. Never delete or edit entries; corrections are new linked reversals.

## Period close and reopen

Close: soft close (`POST /periods/{id}/soft-close`), complete every required close task with evidence (`POST /close-tasks/{id}/complete`), review substantiations, then lock (`POST /periods/{id}/lock`). The lock lists open requirements as field errors. Reopen (`POST /periods/{id}/reopen`) needs `period.reopen`, records the reason, starts a new close version (new checklist, prior snapshots retained) and is refused when the approved `ledger_profile` settings set `reopenForbidden`. Late postings into a locked period fail with `PERIOD_LOCKED`; use reopen or an adjustment in the current open period.

## Fiscal-year close

`ledger.closeFiscalYear` (domain command, no reviewed operation yet) requires every period of the year locked and an active equity account; it posts one `closing` entry with a stable source id, so repeating it returns the same entry. A wrong retained-earnings account is corrected by a reviewed reversal in the following year, never by deleting the closing entry.

## Opening import failures

States: `staged → validated → approved → committed`. Validation failures keep the batch staged with per-row errors (unknown account, non-leaf, inactive, unknown branch, invalid amount or date, date after cutoff, duplicate source key) and an `UNBALANCED_ENTRY` total. Correct the source, upload it as new evidence and create a new import; the same external batch id with a different checksum is refused (`STATE_CONFLICT`) and must use a new external batch id. Commit posts one `opening` entry and returns the same entry on replay; a second committed openings load for the same cutoff and book is refused.

## Report snapshots

Snapshots are immutable and versioned per report type and period key; a later posting produces a new version with a new checksum and the old version stays. Rendered files are restricted evidence; downloads recheck membership. If a report job dead-letters, the requester runs `POST /reports` again after the worker recovers; nothing is lost.

## Chart corrections

Accounts with postings cannot change code, book or category and cannot be archived; freeze them and open a new account. Parent changes are refused when they would form a cycle or cross categories. Control accounts never accept manual journals; module postings (imports, later modules) own them.

## Evidence to preserve

For every ledger incident: trace ids, the `audit_events` sequence range for the entity, the `journal_entries` ids involved, the report snapshot ids and checksums, and the job ids. Export them with `POST /exports` before any operator action.
