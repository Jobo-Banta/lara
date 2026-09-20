# P12 implementation review — 21 September 2026

P12 is in progress, not released. Build-order steps 1 (contracts, migration, permission and capability definitions), 2 (domain and deterministic rules), 3 (API, jobs and the provider adapter), 4 (user journey) and 5 (acceptance and operations) are implemented; no `ai_assistance` capability is activated for a live entity, no hosted model provider is configured (only the local fixture adapter exists) and no evaluation of a real model has been run.

## P12-01 contracts and migration

Contracts: the 3 P12 operations (`POST /assistant/runs` as a 202 job, `GET /assistant/suggestions/{id}`, `POST /assistant/suggestions/{id}/review`) and their schemas were already in the reviewed OpenAPI; the `assistant.*` permissions and the `ai_assistance` capability (depends on `compliance`) were seeded by `0009`. Under the phase rule that screens may add read/list and versioned-mutation operations, five were added and the catalog regenerated (385 operations): `GET /assistant/runs` (history with tool calls), `GET /assistant/runs/{id}`, `GET /assistant/suggestions`, `GET /assistant/features` (configurations with their evaluations) and `PATCH /assistant/features/{feature}` (the versioned opt-in and opt-out under `assistant.review`). `AiSuggestionResource` gained the feature, overall uncertainty, the answer, the scope banner, the sources and the review fields. `validate_specifications` passes.

Migration `0027_p12_ai_assistance.sql`:

- `evaluation_sets` (feature, version, hash, consent basis, item count; append-only) and `evaluation_results` (model and prompt versions, metrics, thresholds, failures, pass flag; append-only except one Finance acceptance by a principal other than the evaluator).
- `model_feature_configs` (one per tenant and feature: enabled, monthly budget and spend, provider policy, model, prompt and tool schema versions, the bound evaluation, approver and reason). A database gate refuses enabling without a passing, accepted evaluation of the exact model and prompt, refuses fewer than 200 held-out items for capture, refuses an approver equal to the configurer and refuses a model or prompt change while enabled.
- `ai_runs` (feature, versions, minimized input references, scope, permission context, every tool call with its verdict, status queued → running → succeeded | abstained | failed | revoked, error code, cost, requester and revocation version, job) immutable once completed, and `ai_suggestions` (one per run: fields with evidence, locator and uncertainty, source spans, answer, report reference, state proposed → accepted | edited | rejected, or abstained; the proposal frozen, edits recorded as field changes, a reviewer and a reason to reject; reviewed once).
- RLS `tenant_scope` policies, grants to `lara_api`; the worker updates runs and configurations and inserts suggestions.

Verification: `scripts/test-p12-schema.mjs` (4 groups) in CI on fresh and upgraded databases; teardown and snapshot tooling cover the five new tables.

## P12-02 domain and deterministic rules

`packages/domain/src/assistant.mjs` with `ai-provider.mjs`:

- Feature configuration (`configureFeature`, no reviewed operation: the reviewer records model, prompt and tool schema versions, the budget and the provider policy; training on tenant data cannot be configured), evaluations (`recordEvaluation` passes only when every Finance threshold holds with zero unauthorized actions and zero control bypasses; `acceptEvaluation` by a different principal), the opt-in that binds the latest passing accepted evaluation and refuses self-enablement, and the per-entity opt-out (`settings_versions` kind `ai_profile`, `disabledFeatures`).
- Requests under `assistant.suggest` check the capability, the feature switch, the monthly budget and every input against the requester's own read permissions (evidence, documents, tasks, statement lines, periods, registration cases); another tenant's or an unreadable record is not found. Runs store references, never document text.
- Execution (worker job `assistant.run`) rechecks the requester's authority at the start and again before storing the result (P12-T05); reads evidence through `evidence.read`, masks tax identifiers and long account numbers before anything reaches the provider, and gates every tool the model asks for against the feature allowlist (`read_evidence`, `read_source`, `read_report`, `propose_draft`, `propose_task`, `explain_finding`) — `send_message`, `run_sql`, `post_journal` and anything else are denied and logged; no tool executes anything (P12-T01). Fields are validated against the tool schema paths per feature, must cite evidence the run may read, are masked and bounded; none left means abstention (poor or blank evidence).
- Numeric answers (`ask_books`) come from `ledger.trialBalance` of the stated scope under the requester's `report.generate`: totals, an account balance or whether the trial balance balances, with the scope banner (entity, book, period, currency, as-of) and the report and account as sources; anything else abstains (P12-T02). Explanations restate the deterministic finding (task reason, source, audit trail) and abstain without a recorded reason. Coding learns only from the tenant's own posted documents (the account most used by the same party for the same description). Matching proposes only an exact single open item and marks several as ambiguous — never reconciles. Close drafts, audit packs and registration drafts assemble tasks, evidence gaps and a narrative that "is not an attestation and is not signed".
- A provider timeout (`AI_PROVIDER_TIMEOUT_MS`, default 1.5 s) or a spent budget fails the run with `PROVIDER_TIMEOUT` or `BUDGET_EXCEEDED`, no suggestion and no side effect; requests beyond the budget are refused at once (P12-T03). Completed runs charge the configured cost to the month's spend.
- Review under `assistant.review` by a named reviewer: accept (a reason when a field is uncertain), edit (field changes recorded, masked) or reject (reason), once; the accepted draft feeds the normal domain command the reviewer issues next — nothing posts, sends, files or pays.
- The `fixture` provider is deterministic and local (key/value lines, uncertainty from blanks and question marks, tool phrases echoed so the gate is exercised, a timeout for evidence named *slow*, one cent per kilobyte); a hosted provider is a separate adapter behind the same interface and is not configured.

Verification: `scripts/test-p12-domain.mjs` (6 groups) covers P12-T01–T05.

## P12-03 API, jobs and adapter

All 3 operations plus the five additions are served by `apps/api/src/workspace-api.mjs`; the worker gains the `assistant.run` handler with the provider from `AI_PROVIDER` (fixture only).

Verification: `scripts/test-p12-api.mjs` (4 groups, API and worker as processes, in CI): features read and the versioned opt-out/opt-in, a capture run queued and executed with the masked TIN and the uncertain field, review once with an edit, ask-your-books with the exact total and the scope banner, the injected document with denied tool calls and no message, 404s and later-phase gates.

## P12-04 user journey

`apps/web/src/app/_components/workspace-assistant.tsx` at `/assistant`: the feature switches with their evaluations and budgets, the request form over the requester's evidence and records (question and period scope for ask-your-books), the run history with tool calls (allowed and denied) and cost, and the source/draft split view with per-field evidence, locator and uncertainty marker, the scope banner, the abstention notice and accept, accept-with-edits and reject for the reviewer. The capabilities screen offers the activation; the navigation gained the Portal placeholder (P13).

Verification: `tests/browser/workspace.spec.mjs` assistant journey on the production composition — two-principal activation, configurations, evaluations and roles seeded through the runtime role, a capture over the registration scan abstaining on screen, ask-your-books answering total debits with the scope banner, review by the controller, the opt-out, WCAG checks (also in CI).

## P12-05 acceptance and operations

Acceptance: P12-T01–T05 in `scripts/test-p12-domain.mjs` and `scripts/test-p12-api.mjs`; CORE regressions unchanged; migration, restore and fresh/upgrade paths in `scripts/ci-database.mjs`. `P12-RUNBOOK.md` covers activation gates, evaluation and enablement, requests and review, budgets, timeouts and revocation, the tool gate and the rollback rule (feature or model version only, never accounting records).

## Open items for the owner

- No reviewed operations exist for feature configuration, evaluation sets and results or Finance acceptance; the domain implements them and the journey seeds them through the runtime role.
- No seeded role template holds `assistant.suggest` or `assistant.review`; tenants create the requester and reviewer roles (tests and the journey do).
- Only the local fixture provider exists; a hosted provider needs the privacy and security approval of region, retention, training and subprocessors, the provider adapter and a real held-out evaluation (200 local bills including handwriting and poor scans for capture) before any feature enables for a customer.
- Ask-your-books answers totals, account balances and the balanced check from the trial balance; other report types and Filipino phrasing are later increments.
- Capture reads text-like evidence through the fixture; OCR of photos and PDFs is the provider's job in the hosted adapter.
- `ADR 001` still names NestJS/Vitest; the codebase remains plain Node + `node:test` (see `P02-REVIEW.md`).
