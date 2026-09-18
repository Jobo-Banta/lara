# LARA 0.0.1 engineering baseline

Synthetic development environment: Supabase roles/migrations, verified provider login, scoped BFF identity and RLS, local web/API/worker launcher, safe health/telemetry and rollback-only backup restoration.

Contains CI-tested engineering artifacts and web/API/worker Docker archives, image IDs and CycloneDX SBOMs. Source provenance and migration checksums accompany the artifacts. The workflow verifies the signed source tag before publication.

See README.md and infra/deployment/README.md for setup. Demo scenario reset and production accounting remain later-phase work. No production/cloud activation is implied. The public repository is an owner-approved exception. Supabase PostgreSQL 17.6 and CI PostgreSQL 18 are verified separately.
