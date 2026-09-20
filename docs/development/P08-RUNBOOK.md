# P08 financial institution coexistence runbook

Extends `P02-RUNBOOK.md` through `P07-RUNBOOK.md`; earlier procedures apply unchanged. Direct edits to approved `lara.source_ownership` and `lara.mapping_versions`, the rows of approved `lara.source_batches`, posted batches, `lara.source_balance_snapshots`, `lara.tax_instrument_facts` or `lara.branch_rollups` are prohibited; the database refuses them for every application role, and a privileged edit is a Sev1 posting-integrity incident handled as in the P03 runbook. LARA never replaces the core banking, valuation, lending or ECL systems: it posts what their feeds declare, once, under approved ownership and mapping.

## Activation gates

Institution work on an entity needs, in order: the `compliance` capability active, the `fi_coexistence` capability activated with the signed feed matrix as evidence and an independent approval (`/settings/capabilities`), an approved `fi_profile` settings version (due-from and due-to accounts, instrument classification rules naming reviewed tax rule codes), the pilot's source systems registered (code, owner, granularity, cutoff timezone), an approved source ownership window per book and transaction family (`/institution/ownership`), and an approved mapping version per source system imported from reviewed CSV evidence. Until the reviewed contract gains operations for systems, mappings, expectations and the profile, an operator seeds them through the runtime role with the tenant set, exactly as `tests/browser/workspace.spec.mjs` does. Before activation for a live institution the design partner signs the entity, books, currency, tax and feed matrix and a representative parallel month reconciles; separate currencies, FCDU or trust books pull P09 in or stay outside LARA with verified interfaces.

## Feed contract (lara-feed-1)

A journal batch is one CSV with the columns `external_line_id, accounting_date, book_code, branch_code, account_code, currency, debit, credit, source_document_ref, dimensions, tax_event_ref` and the optional instrument columns `instrument_ref, instrument_type, maturity_date, income_category`, plus exactly one `MANIFEST` row carrying `count=<n>;sha256=<hex of the data lines joined by newline>` in `account_code`, the debit and credit totals, optional currency totals as JSON in `dimensions`, `replaces=<external batch id>` in `source_document_ref` for a correction and `partial_ok` in `tax_event_ref` when the batch is not atomic. A balance batch has `external_line_id, cutoff_date, book_code, branch_code, account_code, currency, balance` and a manifest with the balance total. Each batch carries one accounting date; daily files are the norm. Rows in another currency than the book's are errors until P09.

## Staging, validation and posting

Upload the CSV as evidence, then stage it (`POST /imports`, kind `journal` or `source_balances`, the source system code as `sourceId`, the approved mapping label, the external batch id and the cutoff). Staging refuses a system without effective ownership, an unapproved mapping and a batch id already presented with a different checksum (`DUPLICATE_SOURCE`); the same file presented again is counted as a duplicate of the one batch and returns it. Validation stages every row with its error and checks the manifest; a batch with errors stays staged and appears on the error workbench (`/institution/feeds`, rows with errors) — fix the source and present a corrected file under a new batch id that names the one it replaces if the original already posted. Approval by a principal other than the stager needs a clean validation; posting writes one journal entry per batch through the posting function (a retry returns the same entry), records instrument facts, and for a correction posts the linked reversal of the replaced batch and supersedes its facts. Summarized feeds (`granularity=summary`) must carry a durable detail reference on every row.

## Missing feeds and the close

The feed calendar (`/institution/feeds`, `GET /expected-batches`) lists what each system owes per period with its deadline. Past the deadline the expectation is missing; every soft close and lock first sweeps the book and period and raises a required close task `source_feed_<system>_<period>` on that period only, so the lock is refused until the batch arrives (which completes the task with the feed evidence) or the controller resolves the task with its own evidence. Other periods and other entities are never blocked.

## Reconciliation and roll-up

`/institution/branches` compares the latest source balances per account and branch with the mapped ledger balances at their cutoff and names every difference; investigate differences before the close, never adjust the ledger to match a feed. The branch roll-up shows per-branch totals and the interbranch pairs (`counter_branch` dimension on the due-from and due-to accounts): pairs cancel at the entity, an open difference is asymmetric batch timing and stays visible with the latest date on each side. Record the roll-up snapshot before the close; the manifest and its checksum are immutable.

## Institution tax worksheet

`/institution/tax` classifies the period's instrument facts through the profile rules to active reviewed tax rule versions (GRT by income category and remaining-maturity band, DST by instrument, final withholding where applicable). Every enabled rule is a `tax_rule_versions` row with the advisor's evidence and golden cases; a change of rate or boundary is a new version. Unclassified facts are listed with the reason and must be resolved by a profile rule or a mapping tax profile before any return preparation uses the worksheet; nothing is silently zero.

## Rollback

Stop source acceptance at a durable watermark (the last posted external batch id per system, recorded in the batch monitor), leave staged and validated batches as they are, reconcile every in-flight batch against the source before resuming, and never delete a posted batch — a wrong posting is corrected by a replacement batch with its linked reversal.

## Evidence to preserve

For every institution incident: trace ids, the `audit_events` range for the entity, the source system and ownership ids, the mapping version ids with hashes, the import and source batch ids with checksums and manifests, the row ids in error, the expected batch and close task ids, the journal entry ids (posting and reversal), the balance snapshot ids, the instrument fact ids and the roll-up ids with checksums. Export them with `POST /exports` before any operator action.
