# Additional feature details and edge cases

These details complete compound BRD requirements that share a module rather than introducing separate systems. Their production phases follow the requirement map.

## P02 access reviews and control monitoring

Quarterly access-review campaign snapshots active memberships, owner, permission scope and last-login time. Owners attest retain/revoke with reason; unreviewed high-risk access escalates and prevents campaign completion. Default dormant threshold 90 days, configurable by approved policy. Shared human accounts are prohibited; service clients have named owners, scoped credentials and expiry. Rule-based monitoring flags self-approval attempts, out-of-hours postings, privileged changes and split-approval threshold patterns with evidence, separately from AI. Forward safe events in structured JSON over authenticated transport to client SIEM, with retry/alert and no financial payload disclosure. SCIM provisioning, where supported by the chosen IdP, maps subject/group to approved membership templates; it never creates accounting authority from an unrecognized group. IdP disable triggers immediate revocation; reconcile provisioning state daily.

## P04 catalog pricing and documents

Service catalog has code, description, unit, default revenue/expense account and default tax category; it is usable before stock tracking. Price rule fields: customer/segment, item, currency, minimum quantity, date interval, unit price/discount and approved priority. Resolve most specific customer+item before segment/item before default; equally ranked overlap is blocked at publication. Do not stack discounts unless explicitly allowed. Tax rules apply after the approved discount base. Snapshot applied rule/version on each line.

Supplementary document types use the document engine with required wording and series profile; cash/charge describes payment condition rather than duplicate screens. Down-payment terms produce installment rows summing to total. Aging is as-of date from posted open items and active allocations, buckets current/1–30/31–60/61–90/91+, configurable labels with fixed query version; credits/advances shown separately. Customer statement includes opening, documents, allocations and closing balance with sources.

## P05 counter receipts and supplier timing

Counter receipt records supplier, original bill reference, received date, due-policy date, sequence and evidence; it is not itself a duplicate bill. AP aging can show contractual due date and counter-receipt-policy date as distinct views, never overwriting the invoice date. Supplier release calendar computes next permitted check-release date from approved schedule/holidays; treasury can override only with reason and authority. Invoice submission email/API/portal converges on one staged bill record with source hash/deduplication; structured input uses the same typed DocumentCreate fields and retains the original signed/file source. Unknown fields are quarantined for mapping, not silently discarded.

## P06 petty cash and signer rules

Petty-cash fund has custodian, bank/cash ledger, authorized float and currency. Voucher approval posts expense/advance versus fund cash; replenishment clears approved unreplenished vouchers and restores float without reposting expense. Replenishment cannot select a voucher twice. Check signer policy is bank/currency/amount-band and required distinct signer count; record release recipient/authority and delivery evidence with restricted identity fields. Stale/void/replacement instruments retain original numbers; released/settled checks require controlled reversal/replacement, not deletion.

## P07 statements audit workspace and templates

Provide report definitions for general journal/ledger, sales/purchases/cash journals, trial balance, balance sheet, income statement, cash flow, equity movement and applicable year-end attachments. Statement mapping version assigns account/line/sign and required disclosure input. Cash flow distinguishes transaction flow classification and noncash adjustments; unexplained reconciliation between beginning/ending cash blocks completion. Equity movement reconciles opening, profit, distributions/contributions and approved adjustments. Framework-specific notes requiring off-ledger facts use owned evidence-backed inputs and clear incomplete status, never generated claims. Book-to-tax schedule classifies permanent/temporary differences per approved mapping; temporary difference × approved applicable rate produces a proposed deferred-tax balance, with recognition/recoverability separately reviewed. AI is not a tax authority.

Auditor workspace: scoped request list, owner, due date, evidence and immutable export manifest. Full-population exports include declared filters, counts, debit/credit totals, cutoff and checksums. Journal testing filters include actor, source, date/time, round amounts and unusual account pairs; flags are observations, not fraud findings. Balance confirmations are reviewed templates, recipient and delivery/reply evidence via P13 messaging; an auditor's process independence remains their responsibility.

Template editor permits logo, margins, approved font size, header/footer and optional fields inside predefined slots. Statutory required fields/wording cannot be hidden, moved outside printable bounds or changed without profile review. Publish template version only after rendering sample one-page/multi-page/mixed-tax outputs and scanning required-field presence. Reprints retain issued template snapshot; new template applies prospectively. Books exports follow the exact enabled authority format, counts and transmission package, not an invented universal SAF schema.

Uncollected-VAT relief/reversal is a separately enabled tax adjustment workflow: identify eligible source items under approved rules, show previously claimed/relieved amounts, validate age/payment evidence, review and post linked tax event, and reverse/reinstate on later collection where required. No blanket adjustment based only on unpaid age. Penalty estimates use the approved calculator/profile and show assumptions, not a legal assessment.

## P11 asset maintenance

Maintenance obligations attach schedule, custodian and completion evidence to an asset; no new ledger effect unless an approved expense/capitalization document exists. Asset transfer changes custody/location prospectively and preserves historical responsibility. Impairment/revaluation require approved valuation evidence, account mapping and recognition policy; calculation engine proposes entries, independent reviewer authorizes.

## P13 offline capture and filing partner

Offline mode is opt-in for draft text/receipt capture on an approved device. Store drafts in IndexedDB encrypted with a session/device-bound key, with explicit pending-sync status, 24-hour expiry and purge on logout/revocation; never store access tokens, bank credentials or posted-record caches offline. If secure key/device handling is unavailable, disable offline capture. Reconnect uploads with a stable client-generated draft key, reconciles version conflicts and creates one server draft. Offline drafts cannot receive official numbers, approve, post, send or execute payments. Test lost key, expired session, duplicate sync and changed server draft.

An eTSP hand-off packages an approved return snapshot, evidence manifest and explicit filing/payment instruction; customer authorizes submission and any payment separately. Validate provider accreditation/contract, credentials, idempotency and acknowledgements before activation. Partner accepted/queued is not filed/paid; reconcile actual confirmation into the obligation record. Failed/unknown submission follows manual reconciliation, not blind resubmit. LARA does not embed eFPS credentials in general browser automation.

## P12 and P18 AI behavior allocation

P12 includes handwritten/PDF bank/manual-book reading only after each reader's evaluation passes; extracted opening data always goes through P03 reconciliation. Cash suggestions distinguish cleared cash from held PDCs and show forecast assumptions. Registration/examination assistance assembles sources and gaps, never signs attestations. Fraud indicators require human investigation and record false-positive disposition. P18 natural-language report creation compiles to the same allowlisted report definition as the visual builder. Rule-change watch fetches reviewed sources into proposals with dates and impact cases; no automatic legal activation. Peer benchmarks remain deferred and absent from production UI/API.

## P17 feature-release boundaries

P17A lessor lease operations, P17B statutory discounts, P17C marketplace/POS, P17D payroll data/remittances and P17E local obligations each have their own entitlement, migration, fixtures, operator runbook and release tag. Each is useful without unbuilt siblings. Lessee right-of-use accounting is not specified as a new required native engine; use reviewed external schedules through P03/P11 until a separate scope/measurement design is approved. Do not silently enlarge a lease-billing requirement into a full lease accounting product.

## P18 feature-release boundaries

P18A report/custom-field authoring, P18B rule/impact/tax-comparison proposals, P18C client draft tools and P18D industry packs ship independently. Each API is versioned and permission-limited. Industry packs for retail/services/construction/leasing/nonprofit are manifests of already completed modules plus reviewed mappings/templates; any genuinely new accounting behavior requires its own specified/tested module before the pack advertises it. A configuration manifest is not evidence that unsupported accounting exists.
