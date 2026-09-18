# P01 facilitator guide and release evidence

This guide describes a synthetic prototype, not production accounting. No usability sessions are claimed by this document.

## Participants and method

Coordinator: product owner or nominated finance operations lead. Recruit eight representatives: two billing/clerk users, two reviewers, one treasury user, one tax user, one controller and one auditor. At least two must be unfamiliar with LARA. Use participant codes, not names or credentials, in results.

Give five minutes of orientation to navigation, the Demo label, scenario reset and the dedicated identity switch. Then let each participant attempt all six task cards without step-by-step assistance. Role switching represents distinct fictional actors, not additional permissions on the real Supabase account. Record a rescue as assisted completion. Stop and record any control bypass or role-blocking defect.

Capture task success, unassisted/assisted outcome, active seconds, rework count, help requests and participant comments. Target at least 90% unassisted completion across 48 attempts. Recruit actual users; automated browser runs cannot replace these observations.

## Six task cards

1. **Invoice and retry.** Create a PHP 10,000 invoice with test VAT, submit it, obtain independent approval and simulate posting. Repeat a request after a simulated interruption. Record collection as Treasury. Expected total: PHP 11,200; one posting; separate settlement/reporting/delivery states.
2. **Bill and payment.** Reset DEMO-02. Inspect evidence, correct the uncertain TIN field, submit, independently approve and post. Approve payment authority, change beneficiary and check that authority must be approved again before simulated release.
3. **Reconciliation.** Reset DEMO-05. Allocate PHP 5,000 and PHP 6,200 to the receipt. Record the PHP 50 bank fee explicitly. Explain why no difference was silently written off.
4. **Reporting and close.** Reset DEMO-04. Repair the rejected and unknown acknowledgement fixtures while preserving the original. Then reset DEMO-06, complete each task as its owner with evidence and lock as Reviewer. Explain the late-post restriction.
5. **Audit.** Reset DEMO-07. Follow Accounts receivable from the trial balance through a journal to its evidence. Download a watermarked simulated export. Explain why another tenant's evidence is unavailable.
6. **Recovery and feedback.** Reset DEMO-08. Edit a draft, interrupt the connection and attempt a save. Change the version in a second tab, reconnect, and resolve the conflict explicitly. Record feedback with scenario, route and severity.

## Fifteen-minute demonstration

- 0–1: sign in, identify synthetic scope, show branch context.
- 1–4: invoice creation, independent approval, posting and collection.
- 4–7: evidence-linked bill correction and separate payment authority.
- 7–10: partial allocation and explicit fee.
- 10–13: reporting repair, close blockers and period lock.
- 13–15: audit drill-through, simulated export and feedback.

Use scenario resets to prepare later sections. Each reset affects only the current authenticated browser session. Never reset another user's records to keep to the schedule.

## Results and release decision

Copy p01-usability-template.json to a new evidence file. Fill it only with actual observations. Run:
`node scripts/check-p01-usability.mjs path/to/results.json`

A passing calculation is necessary evidence, not deployment approval. Record the hosted HTTPS URL, exact source commit, container image digest, schema version, real hosted OIDC callback result, automated checks, participant observations, unresolved defects, tester/date and accountable reviewer in the release report. P01 remains unshipped until the hosted demo and applicable gates are verified.
