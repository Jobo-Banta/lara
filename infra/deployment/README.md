# Engineering deployment

P00 deploys synthetic local/demo services, not cloud production. pnpm dev runs web/API/worker against Supabase. Dev output uses .next-dev separately from production .next builds.

Release archives contain exact scanned web, api and worker Docker images, immutable image IDs and CycloneDX SBOMs. Load with docker load and use the recorded image IDs. Dockerfile targets allow local rebuilds.

Give API only its runtime connection/configuration, worker only WORKER_DATABASE_URL and web only OIDC/session settings plus API_INTERNAL_URL. Never mount operator/migrator credentials in runtime containers. API_BIND_HOST=0.0.0.0 enables private container networking; publish only web to loopback during engineering development. For hosting, configure HTTPS callbacks in LARA and Supabase.

Run migrations separately before replacing services. Verify /health/ready, web login and worker heartbeat. Keep the previous image/configuration for rollback; never run destructive down-migrations. Later schema evolution uses expand/backfill/contract.

The Engineering release workflow takes a signed tag and successful CI run ID, checks exact source/signature/gate states, then delivers already-built archives. It never activates production.
