# P07 tax compliance and e-invoicing runbook

Extends `P02-RUNBOOK.md` through `P06-RUNBOOK.md`; earlier procedures apply unchanged. Direct edits to approved `lara.regulatory_profiles` and `lara.schema_artifacts`, lines and source links of approved or filed `lara.return_runs`, `lara.filing_records`, `lara.transmission_jobs` payloads, `lara.transmission_attempts` or decided `lara.registration_cases` are prohibited; the database refuses them for every application role, and a privileged edit is a Sev1 posting-integrity incident handled as in the P03 runbook. Nothing in this module files a return or grants a permit: preparation, filing evidence, transmission outcomes and authority decisions are recorded as separate facts.

## Activation gates

Compliance work on an entity needs, in order: the `treasury` capability active, the `compliance` capability activated with evidence and an independent approval (`/settings/capabilities`), an approved `compliance_profile` settings version (jurisdiction, taxpayer id, transport, destination, `deadlineHours`, `signingKeyRef`, `credentialsRef`, reported kinds, profile version), a regulatory profile created from the authority's evidence, approved and activated by different principals, and, per form, a mapping artifact imported from reviewed CSV evidence and approved by another principal. Until the reviewed contract gains operations for them, an operator seeds the profile rows and the artifact through the runtime role with the tenant set, exactly as `tests/browser/workspace.spec.mjs` does. Before activation for a live customer the tax lead attests the official artifact versions, taxpayer coverage, correction and retention profiles and the golden cases; the provider and taxpayer sandbox certification, the signing key and credentials are external gates. Working fixtures are not evidence of activation.

## Key and credential custody

The profile names the deployment secrets (`signingKeyRef`, `credentialsRef`); their values live only in the worker's environment, never in the database, settings or evidence. Credentials are `taxpayerId:secret`; the worker refuses to send when the credentials belong to another taxpayer, the key is missing or the regulatory profile is not active on the document date, and parks the job in `retry_wait` with the gate as its reason. Rotate keys by changing the environment and retrying parked jobs; never edit a queued payload.

## Return preparation and filing

Create a run for the form and period; creation freezes the data cutoff. Preparation reads the approved mapping artifact (refusing if its bytes no longer match the reviewed hash), computes every line from the tax events of the period recorded before the cutoff and records the tie-out against the ledger's tax control movement and the snapshot hash. A preparation that names unmapped events is a mapping gap: extend the artifact as a new reviewed version — never approve a return with a silent zero. Approval by a principal other than the preparer binds to the content version; when the return does not tie, the approval reason records the reviewed difference. File through the authority's own channel, then record the filing with its reference, date and acknowledgement evidence (`POST /returns/{id}/filed`). A correction is a new run linked through `supersedesId`; filing it supersedes the earlier run. Replaying a filed run's period, cutoff and artifact must reproduce its snapshot hash; a different hash means source data changed after the cutoff and is investigated before any amended filing.

## Reporting queue

Documents issued under a sales profile with `reportingRequired` queue one immutable signed payload each; the queue (`/compliance`, `GET /transmissions`) shows the state, deadline, attempts, remote id and rejection. The worker sends queued and retry-wait jobs once. `unknown` means the response was lost after the request left: never resend — request a reconcile (`POST /transmissions/{id}/reconcile`), which queries the remote status by request hash and records the outcome with no second submission. `rejected` with class `envelope` is repaired by a retry, which re-encodes the same financial data as a new payload version with the reason; class `financial` means the issued data is wrong and only a correction document (credit note or replacement invoice) clears it — the retry is refused. Deadlines come from the profile; monitor `retry_wait` and `unknown` jobs against `deadlineAt` and assign an accountable owner per entity. `superseded` payload versions are kept with their attempts.

## Worker crash recovery

If the worker dies after the remote acceptance, the job stays `sending`; the next reconcile records `accepted` from the status query with the original remote id (P07-T03). Job retries by the queue never resend a transmission whose state is `sending` or `unknown`.

## Registration

The pack (`POST /registration-packs`) assembles the entity, branches, approved bank accounts (masked), active regulatory profiles and the evidence manifest as restricted evidence and opens the case as `pack_generated`. Record the submission with its evidence, then the authority's decision only from its own reference and evidence; the pack and the submission never mark a permit as granted.

## Rollback

Pause transmission by stopping the worker or unsetting the profile's key reference (jobs park with their reason); the queue and attempts are preserved. Reconcile every `sending` and `unknown` job by status query before resuming. Prepared and approved returns stay as they are; filed runs are never reopened.

## Evidence to preserve

For every compliance incident: trace ids, the `audit_events` range for the entity, the regulatory profile and artifact ids with their hashes, the return run ids with snapshot hashes and tie-outs, filing record ids, transmission job ids with payload hashes, request hashes and remote ids, attempt rows, and registration case ids with pack hashes. Export them with `POST /exports` before any operator action.
