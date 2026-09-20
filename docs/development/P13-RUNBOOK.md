# P13 customer and supplier portals and messaging runbook

Extends `P02-RUNBOOK.md` through `P12-RUNBOOK.md`; earlier procedures apply unchanged. Direct edits to `lara.delivery_receipts`, `lara.webhook_receipts`, authorized `lara.message_requests`, live `lara.provider_payment_intents` or accepted `lara.portal_invites` are refused for every application role; a privileged edit is a Sev1 incident handled as in the P03 runbook. Nothing in this module posts: a provider-settled payment becomes a collection draft that finance reviews and posts through the normal flow.

## Activation gates

Portals on an entity need, in order: the `sales`, `purchasing`, `treasury` and `compliance` capabilities active, the `portals` capability activated with evidence and an independent approval (`/settings/capabilities`), and an approved `portal_profile` settings version naming the qualified messaging channel, the payment provider, the settlement bank account for provider receipts, the share validity in days, the terms version, the support address and the portal base URL. Until the reviewed contract gains an operation for the profile, an operator records it through the runtime role with the tenant set, exactly as `tests/browser/workspace.spec.mjs` does. Only the local mail adapter and the fixture payment provider exist in this release: a hosted channel or provider needs its own adapter, the consent and notification policy, the terms and the support arrangement before the feature is marked complete; without them the portal ships with messaging and payment links disabled (switch the profile's provider names to `none`).

## Invites and members

The relations officer drafts an invite (`/portal`): one party, one role, one address, at most 30 days. The invite reaches its recipient only through an authorized message: draft the invite message, and a principal other than the drafter authorizes the send; the worker delivers it once through the qualified channel and rotates the invite token at every send. The invitee accepts on `/portal/accept` with the address on the invite; a different address, a wrong token, an expired or already accepted invite is refused. Acceptance creates an external identity with a portal membership scoped to that party and entity; the same address at two companies is two memberships with no cross-access. Revoke an invite (`/portal`, reason required) to end the member's hosted access at once — copies already downloaded are not recalled.

## Messages

Every outbound message is drafted (source, recipient, channel, approved template), authorized by another principal and sent exactly once under a fixed send key; the provider deduplicates on that key, so a relay failure retries without a second delivery and each attempt has a receipt. Content carries a subject and an authenticated link only — no amounts, identifiers or attachments. A message that fails every retry dead-letters into a task; cancel it and draft another if the recipient or channel was wrong.

## Supplier submissions

A supplier member uploads an invoice on `/portal`; the upload is quarantined and scanned like every evidence file and opens a `supplier_submission` task for finance naming any missing legal field (supplier TIN, invoice number, invoice date, total). Draft the bill through purchasing from the reviewed evidence; an upload never becomes a bill by itself.

## Payment links and provider events

Issue a payment link on a posted invoice for at most the outstanding amount (`/portal`); the provider intent is keyed once and one live intent exists per invoice. The customer's "I have paid" is recorded as a claim and shown apart from the provider-settled receipt. The provider's webhook (`POST /webhooks/{provider}` with the tenant header) must carry a valid signature and a timestamp within five minutes; events are deduplicated per provider event id, the intent is verified server to server for amount, currency and payee, and only then is the collection drafted for review and the intent settled. Replays, repeated paid events and out-of-order events settle nothing twice; every event and its verdict is in the provider event log. Reconcile the settlement bank account against provider payouts monthly.

## Verification links

A share grant exposes minimal fields of a posted document (kind, number, date, gross, currency, state, a masked party display) behind a non-enumerable token until it expires; no TIN, address, full document or tax-authority acceptance assertion. Revoking an invite revokes the party's grants.

## Rollback

Revoke the invites (memberships end), switch the profile's messaging and payment providers to `none` (sends pause; new links are refused) and leave the tables in place: receipts, intents and the event log stay readable. Never delete or edit posted records; settlements already drafted from provider events are reviewed or rejected through collections.

## Evidence to preserve

For every portal incident: trace ids, the invite and membership ids, the message ids with their send keys and delivery receipts, the share grant ids, the intent ids with provider keys, the webhook receipts (event ids, signature verdicts, outcomes) and the settlement ids. Export them with `POST /exports` before any operator action.
