# P00 implementation review — 18 September 2026

## Scope and approved exception

The owner explicitly approved retaining public GitHub repository Jobo-Banta/lara. Credentials remain in ignored .env.local. Supabase is the selected local-development database; the inspected project runs PostgreSQL 17.6. CI independently tests PostgreSQL 18.

## Verified evidence

- Real Supabase Auth login, PKCE and consent succeeded. The owner confirmed return to LARA signed in on 18 September 2026. A verified Auth subject has an isolated empty demo workspace; shared fixtures remain inaccessible.
- Signed, short-lived BFF identities bind subject, audience, method and path. Browser tokens are kept in encrypted HttpOnly cookies. Nine demo tables enforce RLS. Real runtime tests passed missing-scope, cross-run read/write/insert denial, RLS alteration denial and transaction-scope cleanup.
- Dedicated lara_migrator was provisioned and assigned ownership of LARA schemas and migration metadata. Runtime roles remain non-owner, non-superuser and without BYPASSRLS. All seven checked migrations replay as a no-op.
- PostgreSQL 18 CI passed genuine fresh and previous-version database migrations, checksum/rollback checks, role isolation and restore rehearsals.
- Supabase snapshot rehearsal restored and compared content hashes for 12 tables: seven migrations, one environment marker, two seed executions, two demo runs, three tasks, two invoices and other nonempty synthetic fixtures. Corrupted snapshot content was rejected. Restoration is transactionally rolled back.
- Demo seeding checks explicit demo mode, operator confirmation and database marker. Two executions preserved fixture counts. Production mode is rejected before connection.
- Seven foundation tests and four Chromium smoke tests passed. Protected work/overview pages render dynamically, including builds without local secrets. Anonymous BFF and cross-origin command requests are denied.
- CI run https://github.com/Jobo-Banta/lara/actions/runs/35339015868 passed both verify and image jobs for b4e1dfd: build/types, tests, PostgreSQL 18, dependency audit, gitleaks, specification/tracker validation and container vulnerability scan.
- Next 15.5.24, React 19.1.7 and patched transitive dependencies have no reported production dependency audit vulnerabilities. The runtime container excludes package-manager tooling and applies base OS security updates.
- pnpm verify additionally checks deterministic generated OpenAPI operation metadata. Local verification passed; this addition still requires its subsequent CI run.
- README documents Supabase setup; infra/toolchain.json records tool versions. pnpm dev starts API, waits for readiness, then starts worker/web. The restarted local stack returned web 200, API readiness 200 and worker ready heartbeat.
- Structured API logs include request ID, status and duration without payloads. Local worker emits readiness/dependency events. No external alert destination is claimed.
- Release manifest now derives the actual commit, lockfile digest and all migration checksums; it does not attest a release.

## Remaining phase gates

P00 is not yet shipped. Do not conflate successful login or green CI with an engineering release.

| Ticket | Remaining gate |
| --- | --- |
| P00-01 | Complete clean-machine operator bootstrap review against the setup contract; local stack and clean CI web startup pass. |
| P00-02 | Local-file secret baseline passes. Managed secret references and overlapping-key rotation remain unverified; do not claim a production secret-management deployment. |
| P00-03 | Acceptance passed: provisioned roles, real fresh/upgrade databases, repeat/checksum/failure tests. |
| P00-04 | Acceptance passed: real-provider sign-in, scoped BFF identity and runtime RLS negatives. |
| P00-05 | Enforce required main-branch checks and rerun CI with the generated-contract gate. |
| P00-06 | Demo target and runtime entitlement checks pass. Full session scenario seeding/reset is P01 work and remains disabled. |
| P00-07 | Negative dependency readiness/recovery and alert-route verification remain. |
| P00-08 | Signed release tag, release workflow/SBOM/digests and final engineering artifact delivery/attestation remain. Nonempty restore gate now passes. |

No production finance module, external monitoring service or cloud deployment is activated by this review.
