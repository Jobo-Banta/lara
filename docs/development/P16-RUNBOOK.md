# P16 budgets, cost allocation and project accounting runbook

Extends `P02-RUNBOOK.md` through `P15-RUNBOOK.md`; earlier procedures apply unchanged. Budgets, allocations and projects never post outside the shared posting function, never alter a posted document, and never reserve retroactively: a commitment exists only from the moment an order is approved with the planning capability active.

## Activation gates

The entity activates `planning` (after `inventory` and `assets`) with evidence and an independent approval, then approves the `project_profile` settings (the retention receivable account outside the AR control and the progress revenue account). Budget versions are drafted (`/planning`, `POST /budgets`), approved (`budget.approve`) and activated (`budget.activate`) by principals other than the drafter; activation supersedes the active version for the same book and period. Allocation rule versions (`/planning/allocations`, `POST /allocation-rules`) are approved by a second principal (`allocation_run.approve`). Project contract versions are approved (`project.progress_billing`) before any billing.

## Budget control

Availability per bucket = approved budget − posted spend in the period − open commitments (`GET /budgets/{id}/availability`). Approving a purchase order reserves one commitment per line inside a lock on the bucket, so two simultaneous approvals serialize and the second sees the first. Under a `warn` policy an order beyond the balance is approved with the warning recorded on the commitment; under `block` it is refused unless the approver holds `budget.activate` and records a reason on the approval (the override is kept on the commitment and counted on the availability view). A bill posting against the order consumes the commitment line by line and becomes the actual — never counted twice; a bill without an order is actual only; cancelling the order releases its commitments. Commitments never reduce their consumption and are final once consumed or released.

## Allocations

A run (`POST /allocation-runs`) names an approved rule version, a period, a source cutoff and the driver evidence. Preview computes the pool (posted balance of the source accounts in the period as of the cutoff) and the lines: rounded amounts that sum exactly to the pool, the residual on the first driver in stable order. A source posting after the preview changes the pool: approval and posting recompute the lines and refuse a stale preview. Posting moves the pool from the source accounts (pro rata) to the target account per driver dimension set in one journal entry; a rule version posts once per period (`STATE_CONFLICT` on a rerun); posting again replays the committed result.

## Projects

Open the project with the contract evidence; version 1 is the contract and needs approval. Milestones are certified on evidence by a principal other than the project owner, never beyond the milestone amount nor below what is billed. A documented advance is a posted customer collection with an unapplied remainder assigned to the project. Progress billing (`POST /projects/{id}/progress-billing`) drafts the due-now invoice (certified amount less retention) for the milestone — never beyond its certified, unbilled value nor beyond the approved contract — and records the retention and recoupment; when the invoice posts through the entity's own review, the retention moves to the retention receivable with its revenue (`project_billing` entry) and the advance is recouped by allocating the collection to the new open item. Release (`POST /retention-items/{id}/release`) drafts a due-now invoice against the retention receivable on the acceptance evidence; its posting settles the receivable through the AR control and closes the item. A change order (`POST /projects/{id}/change-orders`) is the next contract version, approved by a second principal; past billing is unchanged and the earlier version stays visible. Profitability counts posted revenue and cost tagged to the project (the `project` dimension or the project reference) and excludes uncertified value and unposted drafts.

## Rollback

Disable the capability: no new reservations, runs or billings; open commitments stay readable and are released by cancelling their orders; posted allocation entries and project documents remain. Budget corrections are new versions; allocation corrections are a reversing journal and a new run; billing corrections are credit notes.

## Evidence to preserve

For every planning incident: the budget version and its availability at the time, the commitment ids with warnings and overrides, the allocation run with its lines hash and entry, the project's contract versions, milestone certificates, billing ids with their recognition entries and allocation events, and the retention items. Export them with `POST /exports` before any operator action.
