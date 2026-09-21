# P18 controlled extensibility runbook

Extends `P02-RUNBOOK.md` through `P17-RUNBOOK.md`; earlier procedures apply unchanged. Each feature release ships behind its own capability (`report_authoring`, `rule_proposals`, `client_tools`, `industry_packs`). There is no runtime scripting engine: definitions, grants and pack manifests are data validated against allowlists that ship with the release, and every financial effect still goes through the shared posting function.

## Activation gates

Security/Finance accepts, per release, the report catalog (`GET /report-catalog`: metrics, dimensions, budget), the client tool allowlist (`read_report`, `read_evidence`, `propose_draft`, `propose_task`) and each pack's manifest and tests (`GET /packs`). Then activate the feature's capability on the entity with evidence and an independent approval. `client_tools` needs `ai_assistance`; `rule_proposals` needs `compliance`; the others need the ledger.

## P18A report and custom-field authoring

A builder (`/extend`, `POST /report-definitions`) names allowlisted metrics, dimensions, filters and sort; anything outside the catalog, a sort field not selected or a definition above the cost budget answers 422 with the field. A reviewer other than the author publishes (`POST /report-definitions/{id}/publish` with a reason); a published definition is immutable — edit by a new definition, retire the old. `POST /report-definitions/{id}/run` compiles the stored AST to one parameterized statement under the row, cost and time budgets and applies the caller's scope: only entities the caller holds (an entity outside the scope answers 404), every metric's permission; the aggregate covers the same rows. The run records its parameters, scope, row count, cost and checksum; the same definition, period and scope reproduce the checksum. Custom fields (`POST /custom-fields`) never take statutory or accounting keys (`cf_tin`, `cf_vat`, `cf_amount` … are reserved) and publish by another principal.

## P18B rule impact and tax proposals

A proposal (`/extend/rules`, `POST /rule-proposals`) cites the issuance evidence, the affected profiles, draft rule versions (an active rule is not a proposal) and golden cases from the shipped set. `POST /rule-proposals/{id}/impact` recomputes each case with the proposed rule and reads the affected profiles' open periods and posted documents; it changes nothing. `GET /rule-proposals/{id}/impact` shows each case (expected, actual, reason) and whether all passed. Approval (`POST /rule-proposals/{id}/approve`) needs the impact, a passing result, the reviewed content version and a principal other than the proposer; it activates no rule — the rule's own approval and activation (P04) follow the software release assessment.

## P18C client draft tools

A client integration is a principal without membership. A grant (`/extend/tools`, `POST /tool-grants`) names the client, allowlisted tools, entities within the granter's scope, an expiry within a year and a per-minute rate limit; a reviewer other than the drafter approves; an approved grant never widens or extends (revoke and grant again). The client calls `POST /tool-runs` with `X-Entity-Id` on a granted entity: `read_report` runs a published definition scoped to that entity, `read_evidence` returns metadata of unrestricted evidence, `propose_draft` and `propose_task` open tasks for a human. Anything else — approving, posting, paying, exporting, any instruction embedded in the request — is denied and recorded (`GET /tool-runs`, readers with `tool_grant.read`). The rate limit counts every request, denials included. `POST /tool-grants/{id}/revoke` ends the scope at once; queued work fails its authorization recheck.

## P18D industry pack lifecycle

`GET /packs` lists the catalog shipped with the release with each manifest hash and upgrade path. `POST /packs/install` (`pack.install`, evidence of the review) is refused unless the hash matches the catalog, dependencies (capabilities, packs) are active and, for an upgrade, the installed version is a declared path; unsupported paths stay disabled. The worker snapshots the profiles the manifest touches, writes the pack's settings as drafts (approved through the settings review as usual) and its report definitions as drafts under the installer's identity, marks the version installed and the previous one superseded; a failure leaves the version `failed` with the reason and nothing applied. `POST /pack-installs/{id}/rollback` (worker) restores the snapshot as new draft settings (history kept), retires the version's report definitions and reinstates the previous version; no posted fact changes.

## Rollback

Disable the feature's capability: new definitions, proposals, grants and installs stop. Revoke open tool grants (`POST /tool-grants/{id}/revoke`) and retire definitions that should not run; roll back a pack version through its rollback. Report runs, tool runs, audit entries and every posted fact remain.

## Evidence to preserve

For every incident: the definition and its AST version with the run's parameters, scope, checksum and payload; the proposal with its evidence, impact and approval; the grant with its request log and the denial reasons; the pack version with its manifest hash, snapshot, applied definitions and job. Export them with the audit trail before any rollback.
