# Local engineering health and alert routing

API JSON request logs contain service, request ID, status and duration only. Do not add request bodies, authorization headers, cookies, callback URLs or subject identifiers. Route stderr to the local operator terminal; staging collectors should alert on dependency_unavailable and repeated status >=500. No cloud alert destination is claimed configured.

The engineering worker emits a readiness heartbeat every 30 seconds. It is a worker-process baseline, not a financial job executor. Business handlers are activated by later modules.

Liveness is process-only. Readiness validates configuration and migration compatibility with PostgreSQL. Run node scripts/test-api-readiness.mjs for positive checks; invalid configuration exits before binding a port.
