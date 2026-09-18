# API and workflow contract

## HTTP conventions

Canonical machine contract: [OpenAPI](contracts/openapi.json), version 3.1.1. It defines the prototype/core commands and typed module contracts. Phase documents specify additional module commands using these same envelopes; implement their contract entries before the phase's first application PR. The API is `/v1`; the demo host uses the same `/v1` prefix with isolated service composition; demo controls are `/v1/demo/*` and are never registered on production.

Every domain request supplies `X-Entity-Id`; server derives tenant from authenticated membership and checks entity/branch/book scope. Never accept arbitrary tenant switches through request bodies. Integrations use scoped client identities and the same guards. All list endpoints support opaque cursor, `limit` default 50/max 200 and stable `(created_at,id)` ordering unless an explicitly whitelisted sort is requested. Cursor binds scope/filter/sort; changing them invalidates the cursor. Dates/amounts remain typed and validated, not interpolated into SQL.

Mutation headers: `Idempotency-Key` required for POST commands (UUID recommended); `If-Match` required for resource mutations, containing the quoted integer version from ETag. Create commands do not use If-Match. Same key/hash returns the prior result; same key/different request is 409 `IDEMPOTENCY_CONFLICT`; stale ETag is 412 `VERSION_CONFLICT`; missing required precondition is 428. Commands return 200/201 when local work commits, 202 only for asynchronous jobs with a job URL. Never return success for merely queued financial posting.

Error body: `{code,message,traceId,fieldErrors:[{path,message}],retryable,resourceVersion?}`. Codes: `VALIDATION_FAILED` 422, `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404 (also inaccessible record IDs), `FEATURE_NOT_ENABLED` 409, `STATE_CONFLICT` 409, `SELF_APPROVAL` 403, `PERIOD_LOCKED` 409, `UNBALANCED_ENTRY` 422, `DUPLICATE_SOURCE` 409, `ALLOCATION_EXCEEDS_BALANCE` 409, `RULE_PROFILE_NOT_APPROVED` 409, `EVIDENCE_NOT_READY` 409, `VERSION_CONFLICT` 412, `RATE_LIMITED` 429 and `DEPENDENCY_UNAVAILABLE` 503. Technical stack/SQL/provider secrets never appear in user messages.

`GET /commands/{key}` returns the authorized request's committed resource or pending/unknown state. Request replay never bypasses current read authorization; revoked actors cannot retrieve old sensitive responses. State-transition and accounting definitions are authoritative over client payloads.

## Roles and permission semantics

| Role | Allowed by default | Explicit restrictions |
| --- | --- | --- |
| Clerk | Prepare drafts, attach evidence, request review, resolve assigned tasks | No approve/post/pay/settings |
| Billing | Draft/issue authorized invoices and record collection drafts | No self-approval where policy requires review; no tax-rule editing |
| Accountant | Review/post journals and financial documents, reconcile | Cannot approve own controlled draft or hard-lock exception without authority |
| Treasury | Prepare/release approved payments, bank work | Beneficiary verification/approval must be independent; no bill self-approval |
| Tax | Review tax treatments, prepare outputs, record filing evidence | Cannot activate own rule change or mark filing without required evidence |
| Controller | Final approval, periods, policy review, scope acceptance | No silent lock bypass or audit edit |
| Auditor | Scoped read/export, evidence requests | No scope expansion, transaction change or permanent implicit access |
| Security admin | Invite/revoke memberships with approval | No accounting authority automatically inherited |
| Operations | Health, retry authorized infrastructure jobs, deployment | No ledger edits, tenant financial queries or signing authority by default |

Permissions are explicit verbs (`invoice.prepare`, `invoice.approve`, `invoice.post`, `payment.release`, `period.lock`, `rule.activate`, `evidence.export`, etc.) attached to scoped roles. Approval policy can require additional steps by amount/branch/risk, but cannot allow maker to fulfill a required independent step. Initial policy: all journals, bills, invoice corrections, beneficiary changes, payments and live configuration require independent approval. Routine invoice issuance may be single-actor only if the approved profile permits it. P01 uses the two-person invoice example.

## Workflow transitions

Financial document: `draft → submitted → approved → posted`; `submitted → changes_requested → draft`; `draft/submitted → cancelled`. Material edit to submitted/approved document returns it to draft, increments version and invalidates decisions. Posted document is terminal for content; corrections are new linked documents. Projections may record settlement/reporting changes without editing issued financial facts.

Approval: `pending → approved/rejected/invalidated/expired`; every required policy step must bind the same contentVersion and content hash. State transitions increment the row ETag but do not change contentVersion. A material edit increments both and invalidates the approval chain. Posting rechecks current contentVersion/hash and the complete chain inside its transaction.

Payment: `draft → submitted → authorized → released → settled`; `released → failed/returned`; `draft/submitted/authorized → cancelled` only if no release effect. Unknown provider acknowledgement is `release_unknown`, resolved by query/reconciliation, not a second release. A confirmed return creates linked reversal and adjusts allocations.

Reporting: `not_applicable` or `queued → sending → accepted/rejected/unknown`; transient transport failure goes to retry_wait; unknown resolves through provider status before resend. Rejected financial content requires the regulatory correction workflow; transport envelope repair retains payload versions. `accepted` requires authoritative evidence, not a green UI toggle.

Period: `open → soft_closed → locked`; only controller-approved reopening creates a new close/report version and audit event. Reopening forbidden by the selected regulatory profile must be rejected. Current-open-period adjustment is the default.

Jobs: `queued → running → succeeded/failed/retry_wait/dead_letter`; cancelled only before a non-reversible external action begins. Worker restart picks up expired leases, checks command/inbox receipts, and never assumes a crashed action had no effect.

## Attachments and exports

1. `POST /evidence/uploads` creates metadata/quarantine record with MIME, byte count and expected SHA-256; allow PDF/JPEG/PNG/CSV/XLSX, 20 MB default. Reject executable formats and zip bombs. Type is sniffed, not trusted from extension.
2. Return short-lived upload URL or local-stream endpoint; complete upload verifies checksum/size and scans. Availability is asynchronous; `GET /evidence/{id}` reports state. A required attachment cannot be approved before available.
3. Downloads use authenticated proxy authorization on every request; storage keys are not public URLs. For large exports, short-lived signed URLs may be used only after membership recheck and with a maximum 60-second TTL; revocation prevents new links but cannot recall already issued/downloaded bytes. Sensitive auditor exports use proxy streaming for immediate revocation enforcement.
4. `POST /exports` enqueues a scoped snapshot job; worker rechecks requesting principal and writes immutable manifest/checksum. Expired/revoked access prevents generation and subsequent download. Previously downloaded files are governed by recipient handling terms.

## Event and adapter interfaces

Event envelope: `{eventId,eventType,schemaVersion:1,tenantId,entityId,aggregateType,aggregateId,aggregateVersion,occurredAt,traceId,payload}`. Payload contains IDs and minimum required non-sensitive facts; consumers load authorized current/snapshot state. Types include `document.posted.v1`, `payment.released.v1`, `reconciliation.completed.v1`, `period.locked.v1`, `transmission.status_changed.v1`, `evidence.available.v1`, `rule.activated.v1`. Consumer contract tests reject unknown major schema version and preserve the event for investigation.

`EInvoiceTransport.validate(profile,payload) -> violations`; `send(profile,immutablePayload,idempotencyKey) -> accepted|rejected|unknown + evidence`; `query(profile,externalKey) -> status + evidence`. `SourceFeed.stage(file,mapping) -> canonicalRows/controlTotals`; `ModelGateway.suggest(scopedEvidence,toolSchema,budget) -> suggestion|abstain`; `EvidenceStore.put/get/hold/dispose` enforce tenant paths and retention; `NotificationTransport.send(approvedRecipient,templateVersion,key)` deduplicates. No provider interface receives unrestricted database access.

## Prototype parity

Demo controllers use these same statuses, errors and version/idempotency rules against demo storage. They expose `simulation=true`, fixture provider and run ID. The UI must not infer production capability from a successful demo response. Contract tests verify matching shapes; production tests verify real business effects separately.


