# P17 local operations runbook

Extends `P02-RUNBOOK.md` through `P16-RUNBOOK.md`; earlier procedures apply unchanged. Each feature release ships behind its own capability (`leases`, `statutory_discounts`, `marketplace_pos`, `payroll_data`, `local_obligations`) and its own approved profile; a feature without a reviewed profile stays disabled and is not marked done. Every financial effect goes through the shared posting function and the existing document flows; nothing here calculates payroll or files with a government office.

## Activation gates

Activate the feature's capability on the entity with evidence and an independent approval, then approve its profile: `lease_profile` (deposit and advance liability accounts, cash) and `lease_withholding_profile` versions for P17A; `discount_profile_<category>` (rate, basis, eligible accounts, exemption profile, required identity evidence, golden cases) for P17B; channel accounts on each channel and the sales mapping version for P17C; `payroll_profile` (salary expense and the withholding, SSS, PhilHealth, Pag-IBIG and net pay liabilities) for P17D; `local_authority_profile` per authority (kinds and filing requirements) for P17E. Rates are never hard-coded: a category without a profile cannot be recorded.

## P17A leases

A lease (`/local`, `POST /leases`) names the lessee, the term, the deposit and advance the contract provides for, the recurring invoice schedule it bills on (P11), the withholding profile version and optional escalation steps; approval is by another principal and an approved lease keeps its terms (an amendment is a new lease). `GET /leases/{id}/schedule` shows the rent per month with each escalation applied from its boundary. `POST /leases/{id}/bill` drafts the rent invoice for one schedule month (once per month) through the normal invoice review. Deposits and advances (`POST /leases/{id}/events`) are received into the profile's liability accounts on bank or cash evidence, never beyond the contract; application to a posted rent invoice or a refund needs a principal other than the one who recorded the receipt and settles the invoice as a non-cash receipt — revenue is recognized by the invoice alone.

## P17B statutory discounts

Eligibility (`/local/discounts`, `POST /discount-eligibility`) records the customer, category, profile version, expiry, identity evidence and a masked identity reference; approval is by another principal; one live eligibility per customer and category; approved eligibility is immutable (revoke and record again). `POST /invoices/{id}/statutory-discount` applies the customer's approved, unexpired eligibilities to a draft invoice: each line on an eligible account receives the profile's discount on its basis and the exemption tax code, other lines stay; the discount lines are recorded with the golden case. A posted invoice is corrected by a credit note, never re-discounted.

## P17C marketplace and POS

Channels (`/local/channels`, `POST /channels`) carry the receivable, fee, withholding and clearing accounts and the sales mapping version. A payout (`POST /payouts`) is refused unless gross − fees − withholding − other explicit deductions = net, and a statement reference is recorded once per channel. Reconciliation (`POST /payouts/{id}/reconcile`) names the imported sales (posted invoices or journal entries) whose total must equal the gross; a difference is an exception and a sales reference never reconciles to two payouts. Posting (`POST /payouts/{id}/post`) moves the net to clearing, recognizes fees and withholding and settles the channel receivable for the gross, once. POS machines are registered with brand, model, serial, MIN and permit; closings (`POST /pos-closings`) carry the readings (gross = ending − beginning), cash counted and the tape; approval by another principal; matching names the posted deposit and a cash difference is an exception.

## P17D payroll data and remittances

A batch (`/local/payroll`, `POST /payroll-batches`) imports the validated file's totals and records with the source hash; records whose sums do not tie to the totals leave the batch in `exception`; the same file imports once. Individual records are readable only with `payroll_record.read` (a restricted role) and identifiers are stored encrypted and shown masked; every read is audited. Approval by another principal; posting writes the payroll journal per the profile once per source and period. Remittances (`POST /remittances`) per agency and period tie to the batch total, are approved by another principal and recorded as remitted with the agency reference and payment evidence; the payment itself is a treasury settlement.

## P17E local obligations

Obligations (`/local/obligations`, `POST /local-obligations`) follow the reviewed authority profile: kind, period, due date, amount, property reference for real property tax and whether filing evidence is required. Completion (`POST /local-obligations/{id}/complete`) needs payment evidence (a posted payment or bill may be named) and, where the authority requires it, filing evidence; waiving needs a reason. Nothing is filed automatically.

## Rollback

Disable the feature's capability: new leases, eligibilities, payouts, closings, batches and obligations stop; posted entries, documents and the audit trail remain; pending payouts and batches are reconciled or cancelled by their reviewers.

## Evidence to preserve

For every incident: the lease and its events with entries and settlements; the eligibility with its evidence and the discount lines; the payout with its statement, sales references and entry; the closing with its tape and deposit; the batch with its source hash, records access audit and entry; the remittance reference and evidence; the obligation with its payment and filing evidence. Export them with `POST /exports` before any operator action.
