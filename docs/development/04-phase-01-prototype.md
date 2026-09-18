# Phase 1 demonstrable experience

**Release:** `0.1.0` hosted prototype. **Purpose:** see and test LARA's end-to-end user experience before implementing every accounting module. **Data:** persistent synthetic records only. **Reuse:** production layout, components, navigation, accessibility, contracts and identity patterns; prototype finance behavior stays in a removable demo adapter. **No live accounting activation.**

## What is real and what is simulated

| Capability | P01 implementation |
| --- | --- |
| Login, sessions, role visibility, navigation | Real OIDC, authorization checks and server-rendered shell |
| Draft editing, task ownership, evidence viewing, comments | Real API/database persistence in demo database |
| Validation, workflow transitions, optimistic versioning | Real deterministic demo service using published contracts |
| Invoice/bill posting and account balances | Synthetic simulation; separate demo tables; never the live ledger |
| BIR queue and acceptance/rejection | Fixture provider selected by scenario; explicit simulated label |
| AI extraction and coding | Fixed evidence-linked fixture output, manual correction supported; labelled simulated AI |
| Email, bank release, filing and payment links | Local sink or simulated status only; no external execution |
| Close and reports | Deterministic synthetic dataset with consistent totals; watermarked exports |
| Reset, scenario selection and feedback | Real server-side actions restricted to demo host/entitlement |

Every visible primary action must work within this boundary. Future features are hidden or clearly described in a roadmap panel, never rendered as enabled nonfunctional buttons. Do not use browser `localStorage` as the system of record.

## Shell and interaction contract

Navigation: My work, Money in, Money out, Close, Compliance. Reports and evidence search are common utilities; Settings is role-restricted. Persistent header contains active company/branch, fiscal period, search, user menu and Demo badge. Switch context only after saving/discarding unsaved edits; clear caches and scoped search results. Selecting a source link preserves originating filters, sorting and row position.

Desktop target 1440×900 and 1024×768; mobile approval/capture at 390×844. Tables show key columns and horizontal scroll on smaller screens; the editor/review remains usable without horizontal scrolling. Support keyboard focus, labelled fields, error summary plus inline errors, status text independent of color, and screen-reader announcements for save/job states. Implement the [DCP UI guide](../DCP_UI_STYLE_GUIDE.md) and approved [Ledger-L assets](../../images/branding/ledger-l/README.md) through the mandatory [design and asset contract](12-design-and-assets.md). Use petrol teal actions, warm-white analytical surfaces and shared components. P01-T05 includes asset, responsive, keyboard and contrast checks; no dashboard decorations without actionable information.

Dates render in Asia/Manila by default, persisted as date-only business dates or UTC timestamps as appropriate. Money displays PHP with two decimals; input permits decimals and shows formatted preview after blur. Empty state gives the next permitted action; loading retains layout; forbidden actions explain missing permission; recoverable errors include retry and preserve draft. Toasts supplement, never replace, persistent error/status text.

## Screens and minimum behavior

| Route | Required content and actions | Error/recovery behavior |
| --- | --- | --- |
| `/work` | My tasks, due/overdue, owner, source, amount, next action; filter and assign | Empty inbox; stale assignment conflict; permission-scoped counts |
| `/overview` | Synthetic cash, AR/AP overdue, next obligations, blockers with as-of labels | Unreconciled badge; all totals drill down |
| `/sales/invoices` | Search/status/date/customer filters; create; saved list position | Empty, no access, network retry |
| `/sales/invoices/new` | Customer, dates, lines, tax fixture, terms; draft/save/submit | Required fields, rounding preview, autosave state |
| `/sales/invoices/:id` | Four independent statuses; source/timeline; approve/post/collect/correct | Self-approval blocked; duplicate command returns original result |
| `/purchases/bills/:id` | Source left, draft right; uncertainty markers; PO/non-PO route | Missing TIN/evidence, duplicate flag, stale-version diff |
| `/payments/:id` | Approved bill, beneficiary, payment authority/release/settlement | Beneficiary change invalidates approval; no real transfer |
| `/bank/reconcile` | Statement lines, proposed matches, difference, allocation detail | Partial/grouped match; invalid amount; unmatched lines |
| `/close/:period` | Owners, dependencies, evidence, required blockers, lock preview | Lock disabled with explanation until required demo tasks complete |
| `/compliance` | Readiness states, obligations and simulated reporting queue | Rejected and unknown-ack states; resolution returns to same source |
| `/evidence/:id` | View authorized synthetic file, metadata and related records | Missing/quarantined file; unauthorized links return 404 |
| `/settings/setup` | Resumable organization/party/role checklist | Invalid field and unsaved-change confirmation |
| `/demo/scenarios` | Select scenario, reset owned demo session, inspect simulation legend | Reset confirms synthetic scope; no production route |

## Synthetic actors and scenarios

Seed one fictional bank-services entity `LARA Demo Finance`, HQ and Cebu branches, a separate unauthorized tenant and roles Clerk, Billing, Reviewer, Treasury, Tax, Controller and Auditor. Users authenticate as distinct synthetic users; the demo host may switch identities through a dedicated demo-only identity flow, not role spoofing in the production guard. Do not seed real people, TINs, account numbers or credentials.

Fixture clock is `2026-09-18T02:00:00Z`; displayed business date 18 September. Fixture entity is explicitly **not** a legal GRT/VAT exemplar. Arithmetic scenarios use tagged test rules so tax calculations can be understood without implying bank tax applicability.

| Scenario | Steps | Observable success |
| --- | --- | --- |
| DEMO-01 direct invoice | Create PHP 10,000 + test 12% VAT; submit; different reviewer approves; simulate post; record collection | PHP 11,200 total, independent delivery/reporting/settlement states, source timeline |
| DEMO-02 uncertain bill | Open fixture extraction; correct one low-confidence field; submit; approve; simulate posting | Corrected source field recorded; no silent AI approval; draft survives refresh |
| DEMO-03 repeated request | Repeat simulated post with same key; retry after dropped response | One synthetic posting/number; same response shown |
| DEMO-04 rejected reporting | Fixture rejects buyer field; explain; create allowed linked correction or transport repair | Original remains unchanged; history and queue resolve coherently |
| DEMO-05 cash match | Import fixture CSV, match grouped/partial amounts, resolve fee via explicit adjustment | Reconciliation ties to synthetic statement; difference is never silently written off |
| DEMO-06 period close | Resolve required tasks and evidence, reviewer locks; attempt late post | Clear denial and correction guidance; original report retained |
| DEMO-07 scoped audit | Auditor follows TB to journal to evidence and requests export | Scope honored; simulated export watermarked; forbidden tenant invisible |
| DEMO-08 interruption | Edit draft, disconnect, reconnect, save against changed version | Draft retained in memory/session recovery; conflict requires merge/reload, no overwrite |

Use accounting examples in `contracts/accounting-cases.json` as deterministic arithmetic fixtures. Demo balances are computed from synthetic events, not independently hard-coded tiles that drift. The reset creates a new demo run namespace; only the requesting demo session's data reset. Global seed reset requires a demo administrator and no active production connection.

## Usability and demo release gate

Run a 15-minute scripted demonstration: login/context (1), direct invoice (3), bill review (3), reconciliation (3), rejection and close (3), audit/feedback (2). Provide a facilitator guide and task cards. Record task success, active time, rework and qualitative feedback per role; capture feedback with scenario, route, severity, text and optional non-sensitive screenshot reference. Avoid analytics containing source documents or credentials.

P01-T01 every screen/action above works against the API after refresh. P01-T02 eight scenarios pass. P01-T03 no live adapter or reset route exists in production registration. P01-T04 cross-tenant, self-approval and stale-version negatives pass. P01-T05 keyboard and mobile critical flows pass. P01-T06 two simultaneous demo sessions cannot change each other's run. P01-T07 all exports/status screens show simulation labels. P01-T08 90% unassisted completion across at least eight representative users is the target; log and fix role-blocking defects. User recruitment is a release activity, not claimed research already performed.

## Transition into production modules

Keep screen/view models stable; swap demo service implementations for finished module services behind production entitlements. Do not migrate synthetic transactions, numbers, approvals or rules into real books. Real customer onboarding starts with a new tenant and approved opening data. Remove simulation labels only on individually activated production capability paths after the relevant module gate passes. CI tests both demo and production compositions to prevent fixture leakage.
