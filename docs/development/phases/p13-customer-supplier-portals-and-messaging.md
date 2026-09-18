# P13 Customer supplier portals and messaging

**Depends on:** P04–P07. **Release:** complete supported module or explicitly enumerated feature release. **Baseline:** shared data/API/security specifications and RG-01–08 apply in full.

## Shipped scope

Authenticated customer/supplier self-service for their own invoices, statements, bill submissions and certificate requests; one qualified messaging channel and payment-link provider with reconciled status.

## User flow and states

Scoped invite → identity verification → portal membership → view authorized records/upload evidence → finance review. Outbound request draft → authorized send → delivery evidence. Payment link → provider event validation → reconcile → normal settlement command, not immediate trust in browser return.

## Data and migration contract

portal_memberships(principal,party_id,entity,role,expiry,status), share_grants(resource,recipient,expires,scope), message_requests(template,recipient,source,approval,state), delivery_receipts, provider_payment_intents(document,amount,currency,key,status), webhook_receipts(provider,event_id,hash,signature_state).

All references use tenant/entity/book composite scope as applicable. Positive amount/quantity checks, unique source keys and enum checks are database-enforced. Archive referenced masters; retain immutable posted facts. Index owner/state/due queues and source/period lookups with tenant/entity leading columns.

## Calculation and business rules

Portal membership scope is party + entity and allowed resource kinds; one email at two companies confers no cross-access. Uploads use quarantine and cannot become posted bills automatically. Verification page reveals minimal approved fields with opaque identifiers; no public TIN/address/full document. Authenticate webhook signature/timestamp, dedupe event, verify amount/currency/payee and reconcile server-to-server before settlement. Email/chat content minimizes sensitive data and links into authenticated review; permissions are rechecked on opening. Send requires explicit actor authorization; AI chaser only drafts. Revocation stops future hosted access, not copies already downloaded.

## Screens and interaction

Portal invoice/statement and certificate inbox, supplier submission status, secure request history; internal communication timeline and failed-delivery task. Clearly distinguish customer-paid claim from provider-settled receipt.

Every screen implements empty/loading/error/forbidden/stale-version/retry states and keyboard/mobile review behavior. No UI action bypasses API/domain rules. Output lists provide permitted CSV/PDF exports with scope, cutoff and checksum.

## Commands and service boundaries

Use the typed operations listed for P13 in [OpenAPI](../contracts/openapi.json) and the shared command envelopes. Only the owning application service may execute transitions; side effects use outbox. Every financial effect calls PostingService inside the same transaction. Any additional endpoint needed to expose the specified screens must use the read/list and versioned-mutation conventions and be added to the reviewed OpenAPI before implementation; it may not invent a second payload/state model.

## Acceptance scenarios

- P13-T01: Portal user enumerates another party record and receives no data.
- P13-T02: Forged/replayed/out-of-order payment webhook never double settles.
- P13-T03: Expired invite/share token cannot expose evidence.
- P13-T04: Supplier upload missing legal fields routes to review, not posting.
- P13-T05: Message provider failure retries without duplicate authorized send.

Also pass CORE-01–18 where applicable, previous-phase regressions, migration/restore/load checks for the new tables and the complete UI/API journey. The exact scoped BRD IDs are in [requirements.json](../contracts/requirements.json).

## Migration and recovery

Introduce scoped external identities separately from internal memberships; never infer portal access from party email. Historical links must be newly authorized, not publicly backfilled.

## Activation and release

Qualify one chosen channel/payment provider, consent/notification policy, terms and support. Without provider evidence, portal-only release may ship with those capabilities disabled; do not mark the provider feature complete. Rollback revokes grants and pauses sends.

## Build order inside this phase

1. Add typed contracts, SQL migrations and permission/capability definitions.
2. Implement deterministic domain/state rules and transaction/repository tests.
3. Implement controllers, imports/jobs/provider adapter and idempotency/failure paths.
4. Implement complete UI journey, reports/evidence and accessible recovery states.
5. Run acceptance/regression/security/migration/recovery tests; record evidence and operator runbook.
6. Release the module with activation gates satisfied for each enabled customer profile. No later phase is reserved merely to harden this module.
