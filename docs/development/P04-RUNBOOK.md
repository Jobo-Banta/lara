# P04 sales invoicing and receivables runbook

Extends `P02-RUNBOOK.md` and `P03-RUNBOOK.md`; the workspace and ledger procedures apply unchanged. Direct edits to `lara.documents` after issuance, `lara.document_lines` of issued documents, `lara.number_events`, `lara.tax_events`, `lara.allocation_events`, `lara.party_snapshots` or `lara.settlements` after posting are prohibited; the database refuses them for every application role, and a privileged edit is a Sev1 posting-integrity incident handled as in the P03 runbook.

## Activation gates

Sales work on an entity needs, in order: the `general_ledger` capability active, the `sales` capability activated with evidence and an independent approval (`/settings/capabilities`), an approved `sales_profile` settings version naming the receivables control account, output tax account, cash account, optional withholding receivable account, currency scale, due days and flags (`reportingRequired`, `enforceCreditLimits`), one active numbering series per branch for `invoice` and `credit_note`, and at least one active tax rule version. Until the reviewed contract gains operations for the profile and series, an operator seeds `lara.settings_versions` (kind `sales_profile`, status `approved`, author and approver different) and `lara.document_series` through the runtime role with the tenant set, exactly as `tests/browser/workspace.spec.mjs` does. Never activate a sample tax rate for a live tenant: rules are created from cited evidence and golden cases, approved and activated by different principals, and the activation publishes `rule.activated.v1`.

## Numbering incidents

Detection: a gap between `document_series.next_number` and the highest `issued` event, an official number without an `issued` event, or a duplicate number refused by `documents_official_number`. Numbers are allocated inside the issuing transaction, so a failed issuance never consumes one; a gap therefore means a manual `skipped`/`voided` event exists (with its reason) or the series was replaced. Response: list `lara.number_events` for the series ordered by number and reconcile against `lara.documents`; record any operator-authorised skip as a `skipped` event with a reason; never lower `next_number` (the database refuses it) and never reassign a number. An exhausted series is replaced by a new active series with a new prefix, not reopened.

## Issuance failures

`POST /invoices/{id}/post` fails atomically. `PERIOD_LOCKED` means the accounting date falls in a soft-closed or locked period: reopen through the close procedure or re-date the draft (the edit returns it to draft for re-approval). `RULE_PROFILE_NOT_APPROVED` means a line cites a tax code with no version active on the document date, or the profile or series is missing. `FEATURE_NOT_ENABLED` on a `reportingRequired` profile is expected until the compliance capability (P07) is active; the drafts remain and issue later. A retry of a committed issuance returns the same journal entry (`sourceType=document`, `sourceVersion=approved content version`).

## Corrections

Issued documents are never edited. A partial credit note (`POST /invoices/{id}/correct`, kind `credit_note`) is limited to the remaining creditable net per revenue account after prior credits; a `reversal` credits everything; an `additional_invoice` bills more. The credit travels through submit, approval by a principal other than its author, and issuance, then applies to the original open item up to its outstanding; any remainder shows as `credit_balance` on the credit note. A credit note issued in error is corrected by an additional invoice, never by deletion.

## Receipts and allocations

Receipts (`/collections`) post `Dr cash / Dr withholding receivable / Cr receivables` and apply their allocation intents as `apply` events. The database refuses any allocation beyond the item's outstanding or the receipt's unallocated amount (`ALLOCATION_EXCEEDS_BALANCE`), so the same receipt cannot settle an invoice twice. A wrong allocation is undone with `POST /allocations/{id}/reverse` (one reverse per apply, reason required); a wrong receipt is reversed with `POST /collections/{id}/reverse`, which posts the mirrored entry, unwinds open allocations and leaves the receipt as a `reversed` fact. Unallocated posted receipts are customer advances and are applied later from the receipt page.

## Delivery

`POST /invoices/{id}/deliver` records a delivery (hashed recipient) and queues `document.deliver`; the worker marks it `sent` with `<MAIL_ADAPTER>:<jobId>` as the provider reference. With the local mail adapter nothing leaves the system; a qualified delivery adapter is a release gate. A dead-lettered delivery job is retried by requesting delivery again; the document keeps only the projection state, and the issued facts are unaffected.

## Reports

Customer aging runs as `POST /reports` with `reportType=aging` into an immutable snapshot (JSON or CSV rendering stored as restricted evidence). Open items and statements come from `GET /open-items`, whose amounts derive from allocation events at read time; a discrepancy between an aging snapshot and the current statement is expected after later allocations and is explained by the snapshot's cutoff.

## Evidence to preserve

For every sales incident: trace ids, the `audit_events` range for the entity, the document ids and official numbers, `number_events` for the series, the journal entry ids, the allocation event ids and the job ids. Export them with `POST /exports` before any operator action.
