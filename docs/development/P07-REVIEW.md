# P07 implementation review — 20 September 2026

P07 is in progress, not released. Build-order steps 1 (contracts, migration, permission and capability definitions), 2 (domain and state rules), 3 (API, jobs and the transport adapter), 4 (user journeys) and 5 (acceptance and operations) are implemented; no `compliance` capability is activated for a live tenant, no official form artifact or certified e-invoice schema is seeded, and the only transport in this build is the fixture. Nothing has been filed or transmitted to any authority.

## P07-01 contracts and migration

Contracts: the 11 P07 operations (`/returns` create/list/get/edit/prepare/approve/filed, `/transmissions/{id}` get/reconcile/retry, `/registration-packs` create) and their schemas were already in the reviewed OpenAPI; the return, transmission and registration permissions and the `compliance` capability (depends on `treasury`) were seeded by `0009`. Under the phase rule that screens may add read/list operations, three reads were added and the catalog regenerated (356 operations, 207 schemas): `GET /returns/{id}/lines` (`ReturnLinesView`: lines, totals, snapshot hash, tie-out, filing record), `GET /transmissions` (`TransmissionQueue`, filters `state`, `documentId`) and `GET /compliance/readiness` (`ComplianceReadiness`). `validate_specifications` passes.

Migration `0022_p07_compliance_schema.sql`:

- `regulatory_profiles` (jurisdiction, version number, coverage of form codes, validity, source hash, evidence ids; draft → approved → active | superseded, author, approver and activator distinct, approved content immutable, one active version per jurisdiction).
- `schema_artifacts` (per profile: `form_mapping` or `einvoice_schema`, code, version label, hash of the evidence bytes, golden case ids; unique per profile, type, code and version; approved by another principal; one approved artifact per form; superseded artifacts are never re-approved).
- `return_runs` (form code, period, profile version, frozen `data_cutoff`, snapshot hash, tie-out, totals, `supersedes_id`; draft → prepared → approved → filed | superseded, preparer ≠ approver, content frozen once approved) with `return_lines` (line code, basis, amount, `source_query_version`, event count) and `return_source_links` (run, tax event, line code, sign); `lara.return_lines_guard` refuses any line or link change on an approved, filed or superseded run (teardown bypass under `lara.maintenance` for the owner or a superuser only).
- `filing_records` (append-only: run, external reference, filed at, evidence ids, recorder).
- `transmission_jobs` (one per document, destination and payload version; immutable `payload_json` and hash, profile version, deadline, signature, remote id, rejection class and reason, attempt count; queued → sending → accepted | rejected | unknown, queued | unknown | rejected → retry_wait → sending, superseded; accepted is final) and append-only `transmission_attempts` (attempt, request hash, outcome or `status_query`, response).
- `registration_cases` (authority, scope, pack evidence and hash; open → pack_generated → submitted → approved | denied; a decision needs its reference and evidence; decided cases stay decided). The worker may insert and update cases and transmissions but cannot create returns.
- RLS `tenant_scope` policies, `touch_row` triggers, grants to `lara_api`, `lara_worker` and `lara_audit_reader`, tenant-leading indexes on owner, state and period lookups.

Verification: `scripts/test-p07-schema.mjs` (8 groups) in CI on fresh and upgraded databases; teardown and snapshot tooling cover the nine new tables.

## P07-02 domain and state rules

`packages/domain/src/compliance.mjs`:

- Compliance profile (`settings_versions` kind `compliance_profile`): jurisdiction, taxpayer id, transport, destination, `deadlineHours` (the profile sets the deadline, the code never assumes one), `signingKeyRef` and `credentialsRef` (names of deployment secrets, never values), reported document kinds, profile version.
- Regulatory profiles are created from evidence, approved and activated by different principals; the active profile on a date is resolved by validity.
- Mapping artifacts are reviewed CSV evidence (`line_code, description, family, tax_type, recognition, kinds, measure, sign`) imported with their sha-256 and approved by another principal. Official field widths and codes are never guessed: a form is enabled only when its approved mapping exists.
- Return preparation (P07-T02) freezes the data cutoff at creation, re-reads the artifact bytes and refuses if their hash drifted, computes every line from the un-reversed `tax_events` of the period created before the cutoff through the mapping (family sales, purchases or withholding; credit notes negate), writes lines and source links, records the tie-out (source basis and amount, return totals, the ledger movement on the output and input tax control accounts through the recognition entries) and the snapshot hash of the inputs and lines; replay reproduces the hash. An event that no mapping line covers fails preparation (`STATE_CONFLICT` naming the family, tax type, recognition and kind) instead of producing a plausible zero.
- Approval binds to the prepared content version, refuses the preparer, and needs a reason when the return does not tie; a rejected run returns to draft. Filing is recorded only from the acknowledgement evidence with the external reference (P07-T05); a filed run supersedes the run it corrects. Drill-down reaches the tax events and documents behind a line.
- Transmissions (P07-T03, P07-T04): `sales.postDocument` under a `reportingRequired` sales profile queues one immutable signed payload (document, party snapshot, lines, tax events, hash) per document version with the profile deadline. The worker sends only when the signing key and credentials named by the profile exist, the credentials belong to the profile's taxpayer and the regulatory profile is active on the document date; a blocked send parks the job in `retry_wait` with the gate as its reason and nothing leaves. A lost acknowledgement leaves the job `unknown`; a resend is refused until a status query (`reconcile`) recovers the remote outcome, so an acceptance is never duplicated. An envelope rejection is repaired as a new payload version with a re-encoding reason; a financial rejection refuses the retry and points to a correction document. Attempts are append-only; the document's `reporting_state` follows the job.
- Registration (P07-T05): the pack (entity, branches, approved bank accounts masked, active profiles, evidence manifest) is stored as restricted evidence and opens or advances a case to `pack_generated`; submission and the authority's decision are recorded separately with their own reference and evidence — the pack never marks a permit.
- Readiness reports capability, compliance profile, regulatory profile, signing key, credentials, transport, e-invoice schema artifact and each covered form as ready, failed or not tested.
- `FixtureEInvoiceTransport` (outcomes from payload markers, acceptances persisted so a status query after a crash finds the remote record) is the only adapter; `transportFromEnv` refuses it outside local and demo modes and refuses any other adapter name.

Verification: `scripts/test-p07-domain.mjs` (7 groups) covers P07-T01–T05; P04, P05 and P06 suites pass with the transmission hook registered in `sales.postDocument`.

## P07-03 API, jobs and adapter

All 11 operations plus the three reads are served by `apps/api/src/workspace-api.mjs`; return actions carry `If-Match`, `reconcile` and `retry` enqueue `einvoice.reconcile` and `einvoice.transmit` jobs and return the job row, `POST /registration-packs` enqueues `registration.pack`. The worker builds the transport from `EINVOICE_ADAPTER` at start-up (`fixture` only) and runs `einvoice.transmit` (rechecking that the queuing principal is still active), `einvoice.reconcile` (`transmission.reconcile`) and `registration.pack` (`registration.prepare`).

Verification: `scripts/test-p07-api.mjs` (5 groups, API and worker as processes, in CI): reporting-required issuance transmitted by the worker, lost acknowledgement reconciled to accepted with one attempt, envelope rejection re-encoded as payload version 2, financial rejection refusing the retry, return run over HTTP with the lines read and tie-out, `SELF_APPROVAL`, filing only with evidence, registration pack as restricted evidence, 404 and isolation, later-phase gates.

## P07-04 user journeys

`apps/web/src/app/_components/workspace-compliance.tsx` at `/compliance`: readiness gates and the form table with ready, failed and not-tested states; new return runs; the runs table with prepare, approve, reject and record-filing (evidence required); the lines panel with the return-to-ledger tie-out and the filing record; the reporting queue with deadline, attempts, remote id, plain-language rejection view (financial correction versus envelope repair), reconcile and retry; the registration pack job with the resulting evidence link. The capabilities screen offers compliance activation; the navigation gained Inventory as the next placeholder.

Verification: `tests/browser/workspace.spec.mjs` compliance journey on the production composition — two-principal activation, mapping CSV uploaded as evidence, profiles seeded through the runtime role (no reviewed operations exist for them), readiness shown ready, a 2550Q run for October prepared with the tie-out, approved by the controller, filed with evidence, a reporting-required invoice issued and shown accepted in the queue after the worker's fixture send, the registration pack job succeeding, WCAG checks (also in CI).

## P07-05 acceptance and operations

Acceptance: P07-T01–T05 in `scripts/test-p07-domain.mjs` and `scripts/test-p07-api.mjs`; CORE regressions unchanged; migration, restore and fresh/upgrade paths in `scripts/ci-database.mjs`. `P07-RUNBOOK.md` covers activation gates, artifact review, preparation and filing, the transmission queue, unknown outcomes, rejections, key custody and the rollback rule (pause transmission, preserve the queue, reconcile remote status).

## Open items for the owner

- No reviewed operations exist for the compliance profile, regulatory profiles, schema artifacts, registration case submission or decisions; the domain implements them and the journey seeds them through the runtime role.
- The seeded `tax` role template holds the preparation, filing, reconciliation, retry and registration permissions, but `scripts/provision-workspace-tenant.mjs` provisions no tax principal; the tests and the journey grant an equivalent tenant role to the preparer.
- Only the 2550Q-style VAT mapping has a golden fixture; the other forms in the registry (SLSP, 0619-E/1601-EQ/QAP, 1601-FQ/2306, 2307/SAWT, 1604-E, 2316, annual income tax/eAFS) stay not tested until the tax lead supplies their official artifacts and golden cases (P07-T01 per enabled form).
- The transport is a fixture; a provider adapter, provider and taxpayer sandbox certification, key custody and credentials are external activation gates. `EINVOICE_ADAPTER` other than `fixture` stops the worker.
- Backfilling documents issued before activation into the reporting queue needs a signed applicability and cutoff plan; the code queues only documents issued after the sales profile requires reporting.
- Output exports of return lines as CSV/PDF with scope, cutoff and checksum are not yet offered on the screen; the snapshot hash and lines read are available for a P03 report.
- `ADR 001` still names NestJS/Vitest; the codebase remains plain Node + `node:test` (see `P02-REVIEW.md`).
