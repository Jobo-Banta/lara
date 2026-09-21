# P14 accounting firm multi-client workspace runbook

Extends `P02-RUNBOOK.md` through `P13-RUNBOOK.md`; earlier procedures apply unchanged. A firm identity never reaches a client by itself: every client access rests on a mandate the client granted and approved inside its own organization and on an assignment the firm made under that mandate. Cross-client reads go only through the restricted authorization functions (`lara.firm_scopes`, `lara.firm_aggregate`); never join client tables from a firm context, and never build a global cache of client figures.

## Activation gates

The firm registers its record in its own organization (`/firm`, `POST /firms`) and enrols staff there; this grants nothing. A client activates the `firm_workspace` capability on its entity with evidence and an independent approval, then grants a mandate (`/firm/mandates`): the firm id, the entities, the permissions (never role, membership, activation, mandate or tool-grant authorities), an expiry within one year and the signed engagement letter as evidence; a second client principal approves. Approval seats the firm owner as the first delegate with the full mandate. Before a live client signs, security's adversarial tests cover the aggregate counts and cross-client jobs (`scripts/test-p14-domain.mjs` is the template).

## Working in a client

A delegate opens a client from the assigned-client list (`/firm`, "Open client"); the choice sets an explicit client context (`X-Tenant-Id`) on every call until "Leave client". Inside the client the delegate is one principal with the assigned subset of the mandate and nothing else: maker-checker applies exactly as to a direct member, and an identity that is also a direct member keeps its membership and remains the same principal. Assignments (`/firm/mandates`, delegate view) hand a subset of the mandate to firm staff by their principal id in the firm; a subset never widens the mandate, and staff not assigned to a client hold no identity there.

## Roll-up and bulk actions

The roll-up (`/firm`, "Refresh roll-up") shows one row per client scope with its own task, obligation and period counts and its open items per currency; nothing is summed across clients or currencies, and each row is snapshotted under its mandate. Bulk reminders draft one reminder per selected client under the delegate's identity there, each in its own command; the outcome per client is independent and the client's own authorizer still sends.

## Revocation

The client revokes the mandate (`/firm/mandates`, reason required): every assignment ends, the delegates' sessions and queued jobs fail their recheck, the firm's snapshots for that mandate are deleted across tenants and the client disappears from every scope list at once. The firm cannot revoke or edit a client's mandate. Expiry works the same way at the mandate's `validUntil`; renew by granting a new mandate.

## Rollback

Revoking mandates disables all firm access to a client while its direct memberships stay untouched. Disabling the firm record (archive) removes the firm from lookups; existing mandates stop resolving because the firm is no longer active.

## Evidence to preserve

For every firm incident: trace ids, the mandate ids with their evidence and approvals, the assignment ids and delegated principal ids, the snapshot ids and scope hashes, the bulk-action outcomes and the client-side audit ranges. Export them with `POST /exports` inside each client before any operator action.
