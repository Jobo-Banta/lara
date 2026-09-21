# P13 implementation review — 21 September 2026

P13 is in progress, not released. Build-order steps 1 (contracts, migration, permission and capability definitions), 2 (domain and state rules), 3 (API, jobs and the provider adapters), 4 (user journeys) and 5 (acceptance and operations) are implemented; no `portals` capability is activated for a live entity, and only the local mail adapter and the fixture payment provider exist — no hosted channel or provider is qualified.

## P13-01 contracts and migration

Contracts: the 15 P13 operations (`/portal-invites` create/list/get/edit/revoke, `/message-requests` create/list/get/edit/send, `/payment-links` create/list/get/edit/cancel) and their schemas were already in the reviewed OpenAPI; the `portal_invite.*`, `message_request.*` and `payment_link.*` permissions and the `portals` capability (depends on `sales`, `purchasing`, `treasury`, `compliance`) were seeded by `0009`. Under the phase rule that screens may add read/list and versioned-mutation operations, nine were added and the catalog regenerated (394 operations): `GET /portal-memberships`, `GET /portal/me` (the member's scope), `GET /certificates`, `GET /message-requests/{id}/receipts`, `GET /webhook-receipts`, `GET /verify/{token}` (public, non-enumerable token, minimal fields), `POST /portal-invites/{id}/accept` (the invited identity, tenant header and token), `POST /payment-links/{id}/claim` (the customer's browser return, a claim only) and `POST /webhooks/{provider}` (public, signed). `validate_specifications` passes.

Migration `0028_p13_portals_and_messaging.sql`:

- `portal_invites` (one party, one role, hashed and masked address, unique token hash, expiry, pending → accepted | revoked | expired with final states, scope changes bump the content version) and `portal_memberships` (one per principal and party: entity, role, allowed kinds, expiry, active | revoked | expired).
- `share_grants` (resource, recipient party, unique token hash, scope, expiry, access count, active | revoked | expired).
- `message_requests` (source, recipient, channel, template; draft → authorized → sending → sent | failed → sending, or cancelled; authorized only by a principal other than the drafter with a unique send key; frozen once authorized; a provider reference to be sent; final once sent) and append-only `delivery_receipts` (one per attempt, a reference when sent).
- `provider_payment_intents` (invoice, amount, currency, provider and unique provider key, expiry, created → pending → paid → settled, or expired | cancelled | failed; one live intent per invoice; amount, currency, invoice and key fixed once live; paid needs a time, settled needs the settlement) and append-only `webhook_receipts` (unique per provider event, signature verdict valid | invalid | stale | replayed, outcome applied | ignored | rejected).
- RLS `tenant_scope` policies, `touch_row` triggers, grants to `lara_api`; the worker updates message requests and inserts receipts.

Verification: `scripts/test-p13-schema.mjs` (4 groups) in CI on fresh and upgraded databases; teardown and snapshot tooling cover the seven new tables.

## P13-02 domain and state rules

`packages/domain/src/portals.mjs` with `portal-providers.mjs`, a portal scope in `identity.actorContext` and a party fence in `core.mjs`:

- Portal profile (`settings_versions` kind `portal_profile`: channel, payment provider, settlement bank account, share days, terms, support, base URL). Invites bound to an active party of the invited role, at most 30 days, the address stored hashed and masked; editing rotates the token; revocation ends every membership and share grant of the party and bumps the principals' revocation version. The token lives only in the delivered message (rotated at every send, P13-T03). Acceptance verifies the token, the pending unexpired state and the invited address, refuses an identity with an internal membership, creates the external principal and the membership scoped to that party and entity, once.
- `identity.actorContext` gives a principal without internal memberships the portal scope of its active membership: the portal permissions of its role (customer: invoice, open item, payment link, evidence, party reads and uploads; supplier: bill, evidence, party reads and uploads) and that entity only. The API allows portal principals the portal allowlist only; `sales`, `purchasing` and `evidence` reads fence to the member's party (another party's record is not found, a party filter cannot widen, uploads are the member's own) (P13-T01).
- Share grants over non-enumerable tokens (tenant-prefixed) expose kind, number, date, gross, currency, state and a masked party display for posted documents until expiry — no TIN, address, full document or acceptance assertion. The token exists only when minted: the worker rotates it at each delivery and the link opens the public `/portal/verify` page (no session; the web forwards to the API's anonymous verify route).
- Messages: drafted against a posted document, a statement, a certificate request, an invite, a reminder or a balance confirmation of the recipient party with an approved template; authorized and sent (`POST .../send`) by a principal other than the drafter, which fixes the send key, mints the share grant and queues the `message.send` job; the worker delivers once (subject and authenticated link only), records a receipt per attempt and, on a relay failure, a failed receipt in its own transaction before retrying with the same key — the provider deduplicates on it, so no authorized message sends twice (P13-T05).
- Supplier submissions: an upload from a supplier member opens a `supplier_submission` task naming the missing legal fields (TIN, number, date, total); the evidence stays quarantined until scanned and no bill exists until finance drafts it (P13-T04).
- Payment links: a provider intent keyed once on a posted invoice for at most the outstanding amount, one live per invoice; the browser return records a claim and changes nothing; the webhook verifies the signature and the five-minute timestamp window, deduplicates per provider event, refuses unknown, already paid or final intents, verifies amount, currency and payee server to server, marks the intent paid and drafts the normal collection (allocated to the open item, bank account from the profile, under the issuer's current authority — or a task when that authority is gone) — once, whatever the order or number of events (P13-T02).
- Local adapters: `local-mail` writes each message as a JSON file into the object bucket (idempotent per key; `fail-once` addresses fail the first attempt), `fixture-pay` keeps intents in the bucket, signs and verifies HMAC webhooks and answers server-to-server verification.

Verification: `scripts/test-p13-domain.mjs` (5 groups) covers P13-T01–T05.

## P13-03 API, jobs and adapters

All 15 operations plus the nine additions are served by `apps/api/src/workspace-api.mjs`; the public verification and webhook routes bypass the session (rate limited per address), the accept route authenticates the invited identity without a membership; the worker gains the `message.send` handler. Adapters come from `MAIL_ADAPTER` / `MESSAGING_ADAPTER` (local) and `PAYMENT_ADAPTER` (fixture) with `PAYMENT_WEBHOOK_SECRET`.

Verification: `scripts/test-p13-api.mjs` (4 groups, API and worker as processes, in CI): the invite, its message authorized and delivered into the local mailbox, acceptance through the public route, the member's fenced reads and 403s, a payment link claimed and settled once by the signed event with replays ignored, the verification link, revocation, 404s and later-phase gates.

## P13-04 user journeys

`apps/web/src/app/_components/workspace-portal.tsx`: the internal `/portal` (invites and members, the communication timeline with delivery receipts, payment links and the provider event log), the member's `/portal` (own invoices or bills, statement, certificates, payment links with the claim apart from the provider-settled receipt, the submission inbox with upload) and `/portal/accept` outside the shell. Portal members see the portal navigation only. The capabilities screen offers the activation; the navigation gained the Firm placeholder (P14).

Verification: `tests/browser/workspace.spec.mjs` portal journey on the production composition — two-principal activation, profile and roles seeded through the runtime role, an invite and its message drafted by relations, authorized by the controller and delivered by the worker into the local mailbox, the link accepted by the invited identity, the member's fenced portal (own invoice, no internal screen), revocation, WCAG checks (also in CI).

## P13-05 acceptance and operations

Acceptance: P13-T01–T05 in `scripts/test-p13-domain.mjs` and `scripts/test-p13-api.mjs`; CORE regressions unchanged; migration, restore and fresh/upgrade paths in `scripts/ci-database.mjs`. `P13-RUNBOOK.md` covers activation gates, invites and members, messages, supplier submissions, payment links and provider events, verification links and the rollback rule (revoke grants, pause sends).

## Open items for the owner

- No reviewed operation exists for the portal profile; the journey seeds it through the runtime role. No seeded role template holds the portal, messaging or payment-link authorities; tenants create the relations and authorizer roles.
- Only the local mail adapter and the fixture payment provider exist; qualifying a channel (identity binding, minimal content, consent and notification policy, terms, support) and a payment provider (region, settlement, payout reconciliation) is release work outside this branch. Without them the portal ships with messaging and links disabled.
- The customer statement and certificate views reuse the open-item and certificate reads; PDF outputs arrive with the reporting module. Dunning levels and late charges (FR-AR-016) remain collections work.
- `ADR 001` still names NestJS/Vitest; the codebase remains plain Node + `node:test` (see `P02-REVIEW.md`).
