# Security operations and release procedure

## Security baseline

Every production mutation passes authentication, active membership, capability entitlement, entity/book/branch access, field permissions, resource version and workflow authorization. Do not rely on hidden buttons. Require MFA for administrators, approvers, payment releasers and auditors exporting sensitive data. Default session idle timeout 30 minutes and absolute lifetime 12 hours; approved registration profile may impose stricter session/password rules. Reauthentication is required for beneficiary changes, bulk exports and payment release after 10 minutes since the last strong authentication.

Use TLS for network paths, encryption at rest and managed keys for storage/database. Secrets come from the deployment secret manager; rotate through dual-key verification periods and audit events. Browser sessions use CSRF protection plus Origin checks on mutations; enforce CSP, secure headers and narrow CORS. Redact authorization tokens, bank details, TINs and document text from normal logs. Masked/synthetic data only in nonproduction. Support access is approved, time-bound, scoped and audited, never a standing superuser UI.

Identity provider locks an account after five failed attempts by default with approved recovery/rate-limit handling; registration-profile settings may be stricter. Commission an independent penetration test before first live financial activation and at least annually thereafter, with material changes triggering focused retest. Vulnerability scans run on every release. ISO/IEC 27001 remains a separately owned assurance program, not an automatic product certification. Privacy owner records applicable NPC registration, processor agreements and approved breach/data-request procedures before customer activation.

Per-principal API limit defaults to 120 reads/minute and 30 writes/minute with bounded bursts; integration clients get explicit profiles. Upload size 20 MB; normal JSON request 1 MB; journal import default 10,000 lines/batch; exports async above 10,000 rows. Limits are versioned configuration and can be raised only with capacity evidence. Return 429 with Retry-After, not silent dropped work.

## Tenant and approval negative test matrix

Try wrong tenant/entity/branch IDs in URLs, bodies, filters, cursor tokens, attachment links, export jobs, webhooks, background jobs and AI tools. Try owner-role RLS bypass, stale membership, expired delegation, creator switching roles to approve, modified document after approval and job execution after revocation. All must fail without leaking names, counts, previews or row existence beyond approved scope. Include timing/search result leakage review for firm and AI aggregate surfaces.

## Operational profile

Initial load benchmark profile, a design target to be replaced by stricter signed customer requirements: 10 entities, 20 branches/entity, 100 concurrent active users/deployment, sustained 20 postings/sec with 10 lines/post, 100 postings/sec burst for 60 seconds, and 1 million ledger lines per active entity/year. p95 server request under 2 seconds, local post under 1 second; async export of 1 million lines under 60 seconds on the documented benchmark environment. User-perceived time measured separately at 100 ms network latency/10 Mbps; mobile recovery tested at 400 ms/1 Mbps with disconnect. No bank-scale marketing beyond measured capacity.

Planning availability 99.5% monthly for authenticated application operations, measured every minute from an independent probe; customer SLA must explicitly define maintenance and dependency exclusions. Record BIR/provider outages and queue-deadline risk separately, never hide them in availability exclusions. RPO ≤15 minutes, RTO ≤4 hours for the complete enabled product. Do not claim either target before a timed restore drill.

## Telemetry and alerts

Propagate trace ID API→transaction→outbox→worker→adapter. Metrics: error/latency per route, active DB connections, deadlocks, oldest outbox/job age, retry/dead-letter counts, posting/number conflicts, reconciliation differences, export time, evidence scan age, AI latency/cost/abstention and external deadline remaining. No high-cardinality party IDs or personal data in metric labels.

| Alert | Default trigger | Owner and response |
| --- | --- | --- |
| Posting/integrity violation | Any committed imbalance, duplicate financial effect or unexplained number reuse | Sev1; stop affected posting capability, preserve evidence, Controller + Engineering incident |
| Tenant disclosure/credential compromise | Any confirmed event | Sev1; contain sessions/keys, Security incident and approved notification process |
| Error-rate/latency | >2% 5xx for 5 min or p95 >2s for 10 min | Operations; inspect dependency/DB and roll back application if safe |
| Outbox stalled | Oldest pending >5 min | Operations/integration; check leases, capacity and adapter health |
| External deadline at risk | Remaining time below max(4h, configured escalation window) | Tax/integration; owned incident and contingency procedure |
| Reconciliation imbalance | Any unexplained mandatory control difference | Controller task; block affected close/activation |
| Backup/restore failure | Missed backup or failed verification | Operations; repair immediately, block release until evidence restored |

## Backup retention and recovery

Continuous database WAL archival supports PITR; daily encrypted snapshots; independent storage location with access controls. Object versions/checksums, approved rules, key references, job state and report manifests must be included in recovery design. Backups have an approved operational rotation policy; they are not the statutory archive. Record-class retention and legal hold govern original records and all copies. Never invent a single universal legal retention duration in infrastructure defaults.

Quarterly drill and before first live release: restore into isolated network, restore correct key access, verify row counts and journal/control totals, check sample document hashes and legal holds, invalidate old sessions, recover outbox leases and reconcile external accepted/released transactions before resuming sends. Measure actual loss window and recovery time. A restored database older than an externally accepted invoice/payment must reconcile remote effects before any new release.

## Release and rollback procedure

1. Record RG-01–08 evidence, schema compatibility range, regulatory change classification and profile activation decisions.
2. Take recovery checkpoint; apply additive migration; deploy compatible workers/API/web with sending paused only where required by migration safety. Verify readiness and read/write smoke on synthetic staging data.
3. Activate one eligible pilot tenant/capability, watch integrity/latency/queue metrics, then widen rollout. Existing tenants retain previous approved rule/template versions until explicit migration.
4. If application behavior fails, disable affected commands, keep read/evidence access, roll back images only within compatible schema range. Do not delete issued documents or down-migrate financial data. Repair with reviewed forward migration/compensating records.
5. Resume sends only after pending/unknown external outcomes reconcile. Document incident, affected records, controller sign-off and user communication.

Schema contraction occurs in a later release after old image support ends, backfill validation passes and backup retention is assessed. Failed backfill is retryable/idempotent with progress and quarantine, never a hidden startup loop.

## Regulatory and AI change controls

Rule changes require primary evidence, applicability/date interval, reviewer independent of preparer, golden tests, impact preview and versioned activation. Existing postings retain their snapshots. Provider schema/signing changes require adapter certification evidence when applicable. Model/prompt/tool changes require replay of permission/adversarial/accounting evaluation sets and a rollback version; an AI feature can be disabled independently while manual finance remains usable.

## Required runbooks in every phase

Document start/stop/readiness, deploy/rollback, failed migration, queue replay/dead-letter, restore, scope revocation, evidence scan failure, export failure, provider outage and module-specific correction. Each runbook identifies evidence to preserve, permitted operator actions, prohibited direct DB edits, escalation owner and recovery validation. P01 runbooks additionally include demo reset and fixture-provider isolation.
