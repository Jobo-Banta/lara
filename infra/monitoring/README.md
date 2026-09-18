# Engineering monitoring

The local operator receives P00 alerts on stderr (.local/stack-error.log for hidden launch). Inspect request_completed status >=500, worker dependency_unavailable and telemetry_unavailable events. Worker emits a ready heartbeat every 30 seconds.

Logs/traces include random IDs, service, timing and status. They exclude payloads, URLs, headers, cookies, credentials and subjects. Set OTEL_EXPORTER_OTLP_ENDPOINT to an operator-controlled collector base URL for OTLP/HTTP JSON POST /v1/traces. Export has a two-second timeout and safe failure logging. Protocol: https://opentelemetry.io/docs/specs/otlp/. No external paging or cloud collector is claimed configured.

node scripts/test-readiness-recovery.mjs runs an isolated API against an unavailable DB: live=200, ready=503, safe stderr and local OTLP receiver evidence. A healthy replacement recovers ready=200. The Supabase service is never stopped. Connection/query timeouts bound failures.
