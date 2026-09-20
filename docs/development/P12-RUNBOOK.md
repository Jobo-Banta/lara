# P12 evidence-backed AI assistance runbook

Extends `P02-RUNBOOK.md` through `P11-RUNBOOK.md`; earlier procedures apply unchanged. The assistant never posts, approves, sends, files or pays; every accounting effect still runs through the owning flow with its independent approval. Direct edits to `lara.ai_runs` once completed, `lara.ai_suggestions` once reviewed, `lara.evaluation_sets` or `lara.evaluation_results` are refused for every application role; a privileged edit is a Sev1 incident handled as in the P03 runbook, though it can never change an accounting record.

## Activation gates

Assistance on an entity needs, in order: the `compliance` chain active, the `ai_assistance` capability activated with evidence and an independent approval (`/settings/capabilities`), privacy and security's written approval of the provider region, retention, training terms and subprocessors recorded as the provider policy (training on tenant data is never configurable), a held-out evaluation set per feature with its consent basis (capture readers need at least 200 local bills including handwriting and poor scans), the evaluation result within Finance's material-field error thresholds with zero unauthorized actions and zero control bypasses, Finance's acceptance by a principal other than the evaluator, and the feature switched on by a principal other than the one who configured it (`PATCH /assistant/features/{feature}`). Until the reviewed contract gains operations for configuration and evaluation, an operator records them through the runtime role with the tenant set, exactly as `tests/browser/workspace.spec.mjs` does. A model or prompt update disables the feature until its own evaluation passes and is accepted; Product measures review time against the baseline before widening the eligible population.

## Requests and review

A requester with `assistant.suggest` chooses the feature, the evidence and the records (`/assistant`); the assistant sees only what the requester can read and refuses anything else as not found. Ask-your-books needs the question and the period; the number comes from the trial balance of that scope and the answer shows the scope banner and the report it came from — model prose never replaces a calculated value, and unsupported questions abstain. The run executes in the worker under the requester's authority, rechecked at the start and before the result is stored. The reviewer with `assistant.review` opens the run, reads the source beside the draft (every field with its evidence, locator and uncertainty marker), and accepts, accepts with edits or rejects with a reason; an uncertain field is never accepted silently. The accepted draft is then entered through the normal flow (a bill draft, a match confirmation, a task) by the reviewer. Abstentions and rejections leave nothing behind.

## Tool gate and injected instructions

Every tool the model asks for is checked against the feature's allowlist and recorded on the run (`GET /assistant/runs/{id}`, tool calls); denied requests such as `send_message`, `run_sql` or `post_journal` are evidence of an injected or malicious document, not an incident of the assistant. Review the run history weekly for denied calls; a document that carries instructions goes to the evidence owner for follow-up. Tax identifiers and long account numbers are masked before any text leaves the domain; a masked value shows as `TIN-MASKED` or `ACCT-MASKED` with unknown uncertainty and is encoded by the reviewer from the paper copy.

## Budgets, timeouts and failures

Each feature carries a monthly budget in cents; completed runs charge their cost and requests beyond the budget are refused with `BUDGET_EXCEEDED` — manual entry continues unchanged. A provider timeout (`AI_PROVIDER_TIMEOUT_MS`) fails the run with `PROVIDER_TIMEOUT` and charges nothing. A failed run is retried only by a new request; never edit the run. If the provider is down, switch the feature off with a reason so requesters see it immediately.

## Revocation

A requester whose membership changes between the request and the execution gets a `revoked` run with no suggestion; a revoked principal can neither read a result nor review one. No further action is needed beyond the membership change itself.

## Opt-out and rollback

Switch a feature off per company through the screen (`PATCH /assistant/features/{feature}`, reason required) or per entity through an approved `ai_profile` settings version (`disabledFeatures`). Rolling back is a feature or model version change only: switch the feature off, reconfigure the previous model and prompt, re-enable behind their accepted evaluation. Accounting records are never rolled back by the assistant; suggestions already accepted were entered through the normal flows and are corrected there.

## Evidence to preserve

For every assistant incident: trace ids, the run ids with their tool calls, model, prompt and tool schema versions and permission context, the suggestion ids with their fields, review decisions and field changes, the evaluation set and result ids, the feature configuration versions, and the evidence ids. Export them with `POST /exports` before any operator action.
