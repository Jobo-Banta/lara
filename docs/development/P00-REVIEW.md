# P00 implementation review — 18 September 2026

The owner approved retaining the public repository Jobo-Banta/lara and using Supabase for development. Credentials and the automation signing private key remain in ignored local files. The source contains only public certificate/signing verification material.

## Acceptance evidence

CI https://github.com/Jobo-Banta/lara/actions/runs/35357486680 passed all four jobs for 854bfb63c08a8cdd8aef54bf73a5a3d4ae676529: verify, image (web), image (api), image (worker). It delivered the engineering artifact plus three scanned image archives, CycloneDX SBOMs and immutable image IDs.

| Case | Verified outcome |
| --- | --- |
| P00-T01 | Clean CI checkout builds web, runs isolated authenticated seeded browser workspace, starts API and worker with non-owner roles. Local pnpm setup checks Node/Python, Supabase runtime DB and OIDC discovery; pnpm dev runs all services. Web and API readiness return 200; worker emits ready heartbeat. |
| P00-T02 | Ten foundation/security tests pass: missing/invalid configuration fails safely; mounted/env secret references work; explicit previous-key overlap preserves sessions and API signatures until expiry; tampered cookies/tokens fail. |
| P00-T03 | Seven migrations replay as no-op on Supabase. Changed content is rejected; failed versions leave no metadata. Line-ending normalization is portable. One exact historical mixed-ending checksum is mapped without editing SQL or stored migration metadata. |
| P00-T04 | The owner confirmed successful real Supabase login/consent and return to LARA. PKCE, encrypted HttpOnly sessions and scoped signed BFF identity pass. Nine tables force RLS; missing/cross-subject read/write/insert and RLS alteration are denied. |
| P00-T05 | PostgreSQL 18 clean and previous-version databases migrate in CI; Supabase PostgreSQL 17.6 separately passes live rehearsals. Dedicated migrator owns LARA objects; runtime cannot alter schemas. |
| P00-T06 | Seeding requires explicit demo mode, confirmation and the dedicated demo marker. Two runs preserve fixture counts; production mode is rejected before connection. Unassigned subjects cannot access shared fixtures. |
| P00-T07 | GitHub main protection requires verify plus all three image jobs, strict up-to-date checks and pull requests, including admins. Force-push/deletion are disabled. Release-source verification rejects failed/mismatched CI. Contract/schema, deterministic assets, tracker, dependency/secret/image scans pass. |
| P00-T08 | Rollback-only snapshot restoration verifies hashes for 12 tables with nonempty tasks, invoices and other fixtures; corruption is rejected. Signed v0.0.1 and all ten engineering assets were delivered by workflow 35358571786. |

## Operational evidence

The isolated dependency test proves live=200/ready=503 with an unavailable DB, safe stderr alert routing and a trace received by a local OTLP/HTTP collector. A healthy replacement recovers ready=200. The test never stops Supabase. The API exposes random request/trace IDs, bounded dependency timeouts and authenticated version/schema metadata. Worker non-owner readiness passes.

SESSION-KEY-ROTATION.md describes coordinated overlap across web/API replicas. Existing real login keys were not rotated. Mounted secret-manager values are supported; no cloud vault or external pager is claimed deployed.

README.md and infra/deployment/README.md document setup, release-image loading, health checks and rollback boundaries. infra/toolchain.json records versions and a measured local development observation. Development output is isolated from production builds.

## Release boundary

P00 is an engineering baseline, not production finance. The signed-tag workflow verifies tag signature and exact successful CI source, retrieves already-built/scanned images and publishes their archives/SBOMs/provenance. P00 is shipped as v0.0.1. Delivery, signed source and gate evidence are recorded in releases/0.0.1.md.

Full session scenario seeding/reset remains P01 work; reset is disabled. No production accounting, tax compliance activation or cloud deployment is attested.
