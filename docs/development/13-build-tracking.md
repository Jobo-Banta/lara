# Build status and update contract

Open [LARA build status](../../build-status.html). This working repository utility lists all 19 phases as 26 separate release increments and all 162 implementation tickets from the approved contracts. P17 and P18 features ship independently. The tracker is not the Phase 1 prototype and does not make any application phase complete.

## Open and keep current

Double-click `build-status.html` for an offline snapshot; use its Refresh button after updating the data. The tracker starts automatically with `pnpm dev`. To start it separately, run from the repository root:

```powershell
pnpm status:serve
```

Open `http://127.0.0.1:8765/build-status.html`. The page reads generated status JSON every five seconds; connection failures retain the last good snapshot and display a warning. It does not infer progress from time, documentation readiness or files appearing. Progress becomes visible after a developer or automation records an update. This server binds only to loopback and serves an explicit allowlist of tracker files, specifications and branding assets; credentials and other workspace files return 404. Stop a standalone server with Ctrl+C. If the address refuses a connection, start it with `pnpm status:serve` or `pnpm dev`. For shared hosting, publish only the tracker, generated read-only data, linked specs and approved web assets to an authenticated internal host. Never expose the whole repository or secrets through a public directory server.

## Record actual work

Run one updater at a time from the repository root. The updater uses only the Python standard library, independent of the future application toolchain. Phase 0 may wrap these commands in `pnpm status:*` without changing their data contract.

```powershell
python scripts/build_status.py sync
python scripts/build_status.py ticket P00-01 in_progress --owner "Developer name" --note "Repository setup underway"
python scripts/build_status.py ticket P00-01 blocked --note "Awaiting repository owner details"
python scripts/build_status.py ticket P00-01 in_review --note "Ready for implementation review"
python scripts/build_status.py ticket P00-01 done --evidence "Commit SHA; verification report path and result"
python scripts/build_status.py release P00 --evidence "Release tag; RG-01..08 report; applicable conditional dependency decisions"
python scripts/build_status.py check
```

These are usage examples, not completed updates. Owners are initially unassigned and all implementation tickets start `not_started`. Allowed ticket states: `not_started`, `in_progress`, `blocked`, `in_review`, `done`. `done` requires evidence; `blocked` requires a reason. Update owners, notes and evidence as work changes. Do not include credentials, customer records or sensitive test output. Evidence is displayed as text, not executable markup.

All tickets done makes a module **Ready for release**, not Shipped. Recording a release requires all its tickets done, required dependency releases shipped and a nonempty release evidence reference. The release owner must first verify the actual [release gates](08-verification.md), conditional dependencies, scoped activation decisions and deployment outcome. The utility checks presence and consistency, not whether an evidence statement is true; it does not execute tests, deploy, certify accounting or approve production activation. For P00 the shipped artifact is an engineering baseline; for P01 it is the hosted synthetic demo.

To correct a released increment, first use `python scripts/build_status.py reopen P00 --note "Reason for correction"`; dependent shipped releases must be reopened first. This withdraws tracker attestation only and does not roll back a deployment. Update the affected tickets and supply new evidence before recording another release.

## Sources and synchronization

- Plan: [release-plan.json](contracts/release-plan.json); work: [backlog.json](contracts/backlog.json). Their specification-readiness fields never count as build completion.
- Build state: [status/build-status.json](../../status/build-status.json), with per-ticket state, owner, note, evidence, update time, release attestations and the latest 200 history entries. Git history supplies long-term change review once the repository is configured.
- Generated live view: [build-status-view.json](../../status/build-status-view.json). Generated offline snapshot: [build-status-data.js](../../status/build-status-data.js). Do not edit either by hand.
- Run `sync` after changing contracts; it preserves recorded status, initializes new IDs and rejects removed tracked IDs until explicitly migrated. Run `check` in CI to detect invalid state or stale generated snapshots. The updater atomically replaces individual files; avoid concurrent writers. If interrupted between files, rerun `sync`.

Every implementation work session must update affected tickets before handoff, record blockers promptly, and attach verification evidence when marking done. Release work must update the release attestation after deployment and gate review. Commit source status and generated files together with the corresponding work. A future CI integration may invoke this same updater after verified events; automatic CI integration is not installed by this documentation task.

Dashboard progress is an unweighted count of done tickets. It is not effort, schedule, budget, or financial readiness. Module status priority is shipped → blocked → all done/ready → in progress → in review → partially done/in progress → not started. Missing future dependencies are displayed separately from explicit blockers. Search includes release IDs, titles, ticket IDs/titles, owners and notes; filtering uses aggregate module status. Expansion and filters persist during a live refresh.
