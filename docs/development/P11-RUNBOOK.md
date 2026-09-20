# P11 assets, recurring work and recognition schedules runbook

Extends `P02-RUNBOOK.md` through `P10-RUNBOOK.md`; earlier procedures apply unchanged. Direct edits to approved `lara.assets` facts, `lara.asset_events`, `lara.asset_components`, reviewed `lara.schedule_versions`, executed `lara.schedule_lines` or `lara.book_tax_layers` are prohibited; the database refuses them for every application role, and a privileged edit is a Sev1 posting-integrity incident handled as in the P03 runbook. A posted period is never rewritten: every change is a linked event or a prospective schedule version.

## Activation gates

Asset work on an entity needs, in order: the `general_ledger` and `purchasing` capabilities active, the `assets` capability activated with evidence and an independent approval (`/settings/capabilities`), an approved `asset_profile` settings version naming the asset clearing and disposal clearing accounts, the asset classes approved by the controller (each with its asset, accumulated depreciation, depreciation expense, disposal gain and loss accounts, an optional CIP account and the tax rule), and the recognition policies approved as settings versions of kind `recognition_policy_<code>` (proration, declining-balance rate, method override, account mapping for prepayments, deferred revenue and deductions). Until the reviewed contract gains operations for them, an operator seeds the profile, the policies and — where the class approver is unavailable — the classes through the runtime role with the tenant set, exactly as `tests/browser/workspace.spec.mjs` does. Before activation for a live customer the controller signs the classes, the recognition methods, the opening register (cost, accumulated depreciation and remaining life per asset reconciled to the ledger), the impairment and revaluation journals and the disclosure boundary, and disables overlapping retained-source schedule ownership. No automatic catch-up posting runs at migration.

## Capitalization

Bills for assets post through purchasing with their lines on the asset clearing account. The clerk drafts the asset (`/assets`) naming the class, cost, residual, in-service date, life, method and the source bill; the assets drawn from one bill cannot exceed its clearing lines. Another principal approves; the approval posts Dr asset / Cr clearing (Dr CIP when the class has a CIP account). Construction in progress depreciates only after the `capitalize_cip` event moves it into service. Additional capitalized costs are further assets from further bills or a revaluation event with evidence.

## Schedules and versions

Create the schedule (`/assets/schedules`): depreciation from an approved asset (start on the in-service date, end after the life, basis = cost less residual), prepayment or deferred revenue from a posted document whose deferral line covers the basis, recurring invoices and journals from a template, employee deductions from an employee. Review the preview through the lines read (every line, the checksum), then another principal approves. A change to an approved schedule (life, method through a policy, dates, basis) is a prospective draft version from the first unexecuted period; approve or reject it before the next run — a pending version holds its periods. Posted lines never change.

## Runs and blocked periods

Depreciation, prepayment and deferred revenue lines post through the run: `POST /schedule-runs` for one period and the chosen schedules under `schedule.execute` (an explicit, revocable authority rechecked by the worker). Recurring invoices, recurring journals and deductions produce drafts for their own review flows and never post from the run. Run the month once its movements and bills are posted and before the soft close; a rerun answers `already_executed` and posts nothing. A locked or soft-closed period blocks the line and opens a `schedule_blocked` task: reopen the period through the P03 workflow and rerun, or record the adjustment in the open period through the close workflow and cancel the line by a prospective version. Paused schedules skip; pause again to resume. The run calendar lists every run with its results and task links.

## Lifecycle events

Events are recorded under `asset.events` with evidence (`/assets`, asset detail): transfer (location only), impairment (loss against accumulated depreciation), revaluation (asset against the surplus account of the class), split (cost and proportional accumulated depreciation to a new child asset), merge (absorbing approved assets of the same class), disposal (cost and accumulated depreciation removed, proceeds through the disposal clearing account, gain or loss recognized), capitalization from CIP. Events are dated in order and never inside a posted depreciation period; the open periods regenerate prospectively. Clear the disposal clearing account against the receipt of the proceeds.

## Book and tax

Every depreciation posting writes the memo layer (`GET /assets/{id}/layers`): book depreciation and carrying amount beside the tax depreciation and carrying amount from the class tax rule. The rule version names the method and life; a change of the class tax rule applies to new layers and is reproducible from the rule. The `asset_register` report renders the register with carrying amounts; reconcile it to the accumulated depreciation balance monthly.

## Rollback

Pause every schedule (`schedule.pause`) — the scheduler stops — and reconcile the last committed period: the run calendar's last completed run, its entries on the ledger and the layers. Deactivating the capability stops new assets, events and schedules; the register, events, versions, lines and layers stay readable. Never delete or edit posted lines; correct through events and prospective versions.

## Evidence to preserve

For every asset or schedule incident: trace ids, the `audit_events` range for the entity, the asset ids with their events and components, the schedule ids with their versions (checksums) and lines, the run ids with their results and job ids, the task ids, the journal entry ids (capitalization, events, schedule lines) and the layer checksums. Export them with `POST /exports` before any operator action.
