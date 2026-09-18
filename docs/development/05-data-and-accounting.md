# Data model and accounting contract

## Global conventions

This is the logical migration contract, not an executed database schema. Every table below must be implemented in checked SQL migrations in its owning phase. Names are snake_case. Unless specified otherwise, a tenant-owned row has `id uuid`, `tenant_id uuid`, `created_at timestamptz`, `created_by uuid`, `updated_at timestamptz`, and `version bigint >= 1`; composite unique `(tenant_id,id)` supports scoped foreign keys. Entity-owned rows add `entity_id`, and unique `(tenant_id,entity_id,id)`. Financial books add `book_id`. Approval-controlled resources also have `content_version bigint` and `content_hash`; material field edits increment content_version, while every state or content change increments row version/ETag. Approval binds content_version/hash, not a mutable status counter. All nullable fields are explicitly marked `?`; other fields are required. Audit/ledger records omit mutable `updated_at/version` and are append-only.

Database money uses `numeric(24,6)`, rates `numeric(24,12)`, quantities `numeric(24,6)`, JSON money/rates use decimal strings. Functional/transaction currency scales are approved currency metadata, PHP=2. Dates are ISO date-only; events are UTC timestamp. No floating-point money, implicit timezone conversion of business dates or database `money` type. Text codes are Unicode NFC, trimmed; tax/party IDs preserve meaningful leading zeroes. Normalize duplicate invoice keys separately from original display text.

Statuses use CHECK constraints or lookup FKs matching the published state machines. `jsonb` is permitted for versioned provider payloads, dimensional metadata and evidence manifests, not as a substitute for typed amounts, dates, ownership or status. Store opaque encrypted secret references, never bank credentials or model keys in payloads. Soft archive masters; restrict deletion when referenced. Posted financial rows cannot be updated/deleted by runtime roles, including cascade operations.

## Organization and security tables P02

| Table | Specific fields | Constraints and indexes |
| --- | --- | --- |
| tenants | slug, name, mode, status | Unique slug; mode demo/live immutable after creation |
| entities | legal_name, registration_profile_id?, tax_id_encrypted?, fiscal_year_start_month, base_currency, timezone, status | Month 1–12; no active live entity without approved profile and onboarding gates |
| branches | code, name, address_json, status | Unique entity/code; configured statutory branch-code validation |
| books | code, kind, functional_currency, source_owner, status | Unique entity/code; P03 one PHP primary book; P09 expands |
| principals | oidc_issuer, oidc_subject, display_name, status, revocation_version | Unique issuer/subject; do not use email as durable identity |
| memberships | principal_id, entity_id?, branch_id?, role_id, valid_from, valid_to? | Scope references same tenant; expiry and revocation checked per command |
| roles | code, permissions jsonb, protected | Versioned changes independently approved |
| approval_policies | type, version_number, conditions_json, required_steps_json, effective_from, approved_by | Immutable approved versions; no cyclic/ineligible approver routes |
| capability_activations | entity_id, capability, status, evidence_manifest, approved_by?, activated_at? | Unique entity/capability; server checks dependency graph and activation evidence |
| party | legal_name, tax_id_encrypted?, identity_status, address_json, status | Search normalized name; identity_status known/unknown/not_applicable; no dummy IDs |
| party_roles | party_id, role customer/supplier/employee/bank, terms_id?, control_account_id? | Unique party/role; restricted employee fields in separate protected table |
| party_bank_accounts | party_id, encrypted_account, bank_code, verification_evidence_id, status | Approved changes immutable/versioned; prior approval invalidation |
| evidence | object_key, sha256, mime, byte_count, status, classification, retention_policy_id, legal_hold | Tenant private object; status quarantined/scanning/available/rejected; object key unique |
| evidence_links | evidence_id, resource_type, resource_id, resource_version | Unique reference tuple; service validates target authorization and scope |
| tasks | kind, source_type, source_id, owner_id?, due_at?, status, severity, cause_key | Unique active source/kind/cause_key; index owner/status/due_at |
| task_comments | task_id, body, evidence_id? | Append-only; permission-filtered mentions |
| obligations | kind, period_key, due_at, owner_id, status, evidence_id?, rule_version | Unique entity/kind/period/profile; completion requires configured evidence |
| approval_requests | resource_type, resource_id, content_version, content_hash, policy_version, step, status | Decisions bind immutable version; changed material data invalidates request |
| approval_decisions | request_id, actor_id, decision, reason?, decided_at | Append-only; request/step/actor unique; maker restriction enforced |

## Ledger and shared document tables P03 onward

| Table | Specific fields | Constraints and indexes |
| --- | --- | --- |
| accounts | code, name, category, normal_side, parent_id?, control_type?, allow_manual, status | Unique book/code; prevent hierarchy cycles; posting only to active leaves |
| dimensions | type, code, name, parent_id?, status | Unique entity/type/code; account dimension rules separately versioned |
| periods | starts_on, ends_on, status open/soft_closed/locked, close_version | Non-overlap per book; closing/posting lock this row |
| documents | kind, branch_id, party_id?, document_date, accounting_date, tax_date?, currency, state, gross, net, tax, series_id?, official_number?, approved_version?, rule_profile_version, payload_hash | Unique series/official_number when assigned; positive amounts except explicit correction kinds; version required |
| document_lines | document_id, line_no, item_id?, description, quantity, unit_price, discount, account_id, tax_code_id?, net, tax, gross, dimensions_json | Unique document/line; reconcile header to lines; dimensions validated against master |
| document_relations | source_id, target_id, relation correction/credit/replacement/order/receipt, amount? | Same entity; prevent correction cycles and over-credit |
| document_series | branch_id, kind, prefix, next_number, maximum_number?, profile_version | Unique approved scope; lock on issue; never recycle issued numbers |
| number_events | series_id, number, document_id?, event, reason?, occurred_at | Append-only history; unique issued allocation; range validation |
| journal_entries | source_type, source_id, source_version, accounting_date, posted_at, period_id, transaction_currency, functional_currency, rate_version?, reversal_of?, posting_actor, command_id | Unique book/source_type/source_id/source_version/purpose; reversal link controlled; append-only |
| journal_lines | entry_id, line_no, account_id, branch_id, txn_debit, txn_credit, func_debit, func_credit, dimensions_json | Exactly one side positive per line; unique entry/line; same scope/account/book |
| opening_batches | checksum, cutoff, source_id, mapping_version, state, counts, debit_total, credit_total | Unique source/checksum/cutoff; rejected rows quarantined; approve before commit |
| report_snapshots | report_type, period_key, cutoff_posted_at, rule_version, parameters, checksum, evidence_id, version_number | Immutable data cutoff and payload; new report version after adjustment |
| close_tasks | period_id, requirement, owner, status, evidence_id?, waiver_reason? | Required task cannot waive a missing financial control; lock gate checks all |

Only PostingService inserts journal rows. Application runtime cannot update/delete them; enforce through grants and immutable-table triggers. Header balance requires a deferred constraint trigger evaluated at transaction end or an exclusively granted posting function, not a per-row CHECK incorrectly attempting to aggregate lines. SQL migrations must reject direct out-of-balance insertion by the runtime role. Minimum two nonzero lines; sum functional debits equals credits exactly; transaction totals equal for a single-currency journal. No “tolerance” permits an unbalanced journal: any allowed rounding difference has an explicit approved rounding-account line.

Index journal lines by `(tenant_id,entity_id,book_id,account_id,entry_id)` and entries by `(tenant_id,entity_id,book_id,accounting_date,id)`. Optimize based on measured plans; partition only after evidence and with constraints maintained. Reports join on scoped keys, never a globally assumed UUID alone.

## Financial operational tables P04–P09

| Table | Fields beyond common ownership | Invariant |
| --- | --- | --- |
| tax_rule_versions | code, jurisdiction, tax_type, valid_from/to?, rate, basis, rounding, applicability, source_evidence, status, approver | Approved versions immutable; unambiguous date/profile selection |
| tax_events | document_id, line_id?, tax_rule_version_id, tax_point, basis, amount, recognition_entry_id?, reversed_by? | No duplicate recognition at accrual and payment |
| open_items | document_id, side AR/AP, party_id, original_amount, currency, due_date, status | Outstanding derived from active allocation events, not editable amount |
| settlements | direction, party_id, payment_method, gross_amount, cash_amount, withholding_amount, currency, state, value_date?, bank_reference?, evidence_id? | Gross = cash + withholding + explicit adjustments; no posting on mere draft |
| allocation_events | settlement_id, open_item_id, amount, action apply/reverse, reverses_id?, command_id | Append-only; item and settlement remaining amounts cannot go below zero; ordered row locks |
| withholding_certificates | party_id, form, period_start/end, certificate_reference, amount, evidence_id, review_state | Certificate identity deduplicated; expected/received/eligible/claimed separate states |
| certificate_allocations | certificate_id, tax_event_id, amount, claim_snapshot_id? | No overclaim or double claim; amended claim creates new snapshot |
| purchase_orders | supplier_id, document_id, status, committed_amount | Approval/version controls; policy-required receipt cannot be skipped |
| payment_orders | settlement_id, beneficiary_version, approved_version?, state, release_key?, released_at? | One effect per release_key; material beneficiary change invalidates authority |
| bank_accounts | party_id?, account_id, currency, encrypted_number, status | Ledger account and book currency valid |
| bank_statement_batches | bank_account_id, from/to, source_hash, opening/closing_balance, state | Duplicate content rejected; opening + signed lines = closing |
| bank_statement_lines | batch_id, source_line_key, booked_date, value_date?, signed_amount, reference, match_state | Unique account/source_line_key; preserve source text |
| reconciliation_matches | line_id, settlement_id?, entry_id?, amount, state, approved_by? | No overlapping confirmed amounts; write-offs require their own approved entry |
| check_instruments | direction, bank_account_id, check_number, due_date, amount, state, settlement_id, replaces_id? | Unique bank/direction/check_number; no clear twice |
| transmission_jobs | document_id, payload_version, payload_hash, profile_version, state, deadline_at?, remote_id?, attempt_count, next_attempt_at? | Unique document/payload_version/destination; financial data immutable |
| transmission_attempts | job_id, attempt, request_hash, sent_at, response_evidence?, outcome | Append-only; unknown outcome reconciled before resend |
| return_runs | form, period, rule_version, data_cutoff, state, snapshot_id, filing_evidence? | Prepared ≠ filed; correction creates new return run linked to prior |
| source_batches | source_system, external_id, hash, mapping_version, counts, totals, cutoff, state | External ID + differing hash is conflict, not duplicate success |
| source_ownership | source_system, transaction_family, book_id, effective_from/to | No overlapping authoritative owners |
| fx_rates | base, quote, rate_date, rate, source, status, approved_by | Unique source/pair/date/version; no silent missing-rate fallback |

Remaining module-specific tables, calculation rules and command boundaries are defined in phase specifications. Extend `documents`, `tasks`, `evidence` and `approval_requests`; do not clone those engines per module.

## Durable operation tables

`command_receipts`: tenant, entity, actor/client, operation, idempotency_key, request_hash, status, response_json, resource_id, created_at. Unique scoped key. For resource-creating and all financial commands retain the command-to-business-effect linkage for the resource retention period. Response body cache may expire after seven days, but a retry still returns the canonical resource/result, never creates another effect.

`outbox_events`: event_id UUID, tenant/entity, aggregate_type/id/version, event_type, schema_version, payload JSON, created_at, published_at?. Unique aggregate/version/type. `inbox_receipts`: consumer,event_id unique. `jobs`: kind, scoped payload reference, state, run_after, attempt, lease_owner, lease_until, error_code. Workers claim using row locking/`SKIP LOCKED`, lease 60 seconds, heartbeat every 20; bounded retries 1s/5s/30s/2m/10m, then dead-letter with owned task. Provider rate limits override scheduling, never extend legal deadlines silently.

`audit_events`: entity sequence, actor/delegation, action, resource/version, safe before/after reference, timestamp, reason, trace_id, previous_hash, hash. Lock a per-entity chain-head row before append; store independent signed daily checkpoints in protected storage. Restricted DBA audit covers privileged changes separately. Hash chain alone is not administrator-proof storage.

## Posting algorithm

1. Authenticate and resolve membership; reject disabled capability, unsupported profile, wrong entity/book or revoked principal. Reserve/read scoped command key and verify request hash.
2. Begin transaction. Set local tenant context. Lock applicable period `FOR SHARE`, document `FOR UPDATE`, sorted allocation/control aggregates and series as needed. Recheck version, status, approver identity, evidence and rule validity after locks.
3. Determine business dates, approved accounts/dimensions, tax events and posting template. Compute with decimals; do not accept client-computed totals or journal lines for module postings.
4. Recompute totals and check no duplicate source effect, unbalanced journal, invalid control-account source, excessive allocation/credit, frozen account or locked period. Soft-close requires the specific authorized adjustment workflow and reason.
5. Allocate the official number only on successful issuance inside the same transaction. Snapshot party identity, tax/rule/template version and source values so later master edits cannot rewrite issued documents.
6. Insert immutable journal/lines and tax/allocation effects; update document projection/version; insert audit and durable outbox; finalize command receipt. Commit together.
7. Return committed resource with ETag and trace ID. Workers send/notify after commit. A timeout on the HTTP response is resolved by command lookup/retry with the same key. Never issue another invoice to compensate for an unknown response.

## Core accounting rules

Invoice: debit AR gross, credit revenue net, credit output tax. Collection without withholding: debit bank/clearing, credit AR. Collection with approved withholding: debit bank net and withholding receivable, credit AR gross; certificate receipt changes evidence status, not the same receivable again.

Bill: debit expense/asset and eligible input tax; credit AP. When approved withholding recognizes at accrual, credit withholding payable and reduce AP accordingly; payment-time recognition instead occurs at settlement, never both. The profile selects the timing and evidence, not AI. Payment: debit AP, credit bank or clearing. Advance before invoice/bill uses an advance control account, with a linked later application entry. Bank fees require explicit approved expense posting; matching alone cannot create a fee.

Correction: reversal swaps sides at approved effective date and links the original. Partial credit uses separate document with explicit amount; prevent cumulative credits above the eligible original balance except an independently approved policy. A post-close adjustment is a new entry/report version; no mutation of the old record. Foreign-currency and inventory/asset cases extend these rules in their phases.

