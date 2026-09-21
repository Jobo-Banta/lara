# P09 multiple currencies and separate books runbook

Extends `P02-RUNBOOK.md` through `P08-RUNBOOK.md`; earlier procedures apply unchanged. Direct edits to approved `lara.fx_rates`, `lara.fx_open_item_layers`, approved or posted `lara.revaluation_runs`, `lara.currency_metadata` or the `fx_rate` of posted `lara.journal_entries` are prohibited; the database refuses them for every application role, and a privileged edit is a Sev1 posting-integrity incident handled as in the P03 runbook. Posted values never change: a wrong rate on a posted document is corrected by a reversal and a new document, never by editing the rate.

## Activation gates

Multi-currency work on an entity needs, in order: the `fi_coexistence` capability active, the `multi_currency` capability activated with evidence and an independent approval (`/settings/capabilities`), and an approved `fx_profile` settings version naming the realized and unrealized gain and loss accounts and the monetary accounts eligible for revaluation. Until the reviewed contract gains an operation for the profile, an operator seeds `lara.settings_versions` (kind `fx_profile`, status `approved`, author and approver different) through the runtime role with the tenant set, exactly as `tests/browser/workspace.spec.mjs` does. Before activation for a live entity the controller approves the monetary classification, the FX rate sources, each book's functional currency and boundaries and the tax and report interactions; the required separate-book reports are tested on the parallel month.

## Rates

A rate is quoted in the functional currency per one unit of the foreign currency (USD/PHP 56 means 1 USD = 56 PHP) for one date, drafted by the FX desk from the published source as evidence and approved by another principal (`/fx/rates`). The screen and the domain refuse an inverted pair (quote not a functional currency of the entity) and a value off the recent approved rate by more than a factor of ten. Approved rates are immutable; a correction is a new rate for the same date after the wrong one is rejected. Documents post at the rate dated on the document date, settlements at the value date, revaluations at the period end: with no approved rate for that exact date the posting blocks — it never uses 1 or the nearest date.

## Documents and settlements

A foreign-currency invoice or bill posts both amounts at its document-date rate and opens an FX layer (remaining transaction amount, functional carrying value) on its open item; the invoice detail shows both sides. A receipt or payment in the document currency allocates its full amount at posting: the transaction entry moves cash and the control at the value-date rate, the layers are consumed proportionally (the allocation that clears an item absorbs the rounding) and the realized difference posts as a functional adjustment with explicit purpose (`settlement_fx`). Reversals keep the original rate and amounts and restore the layers. Cross-currency settlements, unapplied foreign-currency receipts and withholding on foreign-currency settlements are refused; handle them as PHP transactions or wait for a reviewed treatment.

## Revaluation

At period end approve the closing rate dated on the period end, then create a revaluation run (`/fx/revaluations`) for the book, the period, that rate set and the monetary accounts; the preview lists per account the foreign balance, the functional carrying value, the revalued amount and the difference. Approval by another principal re-checks the preview against current balances (a posting since the preview means preview again). Posting writes one functional adjustment entry (unrealized gain or loss); a retry returns the same entry; the optional reversal posts on the first day of the next period, which must exist and be open. A second run for the same rate set is refused; a later rate set for the same period links to the earlier run and posts only the delta. Never revalue accounts outside the monetary classification.

## Partitions and the combined view

RBU, FCDU and trust books are created as drafts by the controller and activated by another principal (`/books`); each keeps its own accounts, periods and postings in its functional currency. Access grants (read or post, granted by someone other than the holder) close a partition to everyone else, including for reading and for postings from the owning modules. A management view never posts; link source books into it (`as_is` for the same currency, `closing_rate` to translate, `exclude`) and read the combined view at a cutoff: each source book is counted once, the basis and exclusions are labelled, a missing closing rate blocks the translated book, and there are no eliminations — this is a management combination, not group consolidation (P15).

## Rollback

Disable new FX activity by deactivating the capability for the entity: new foreign-currency documents, rates, revaluations and separate books are refused while every posted entry keeps its transaction and functional amounts and the native-currency reports stay readable. Do not edit rates or reverse revaluations in bulk; reverse what must be reversed through the normal linked reversals with reasons.

## Evidence to preserve

For every FX incident: trace ids, the `audit_events` range for the entity, the rate ids with their evidence, the document, settlement and revaluation ids, the journal entry ids with their `fx_rate`, the layer rows of the affected open items, the book ids with their grants and links, and the combined-view checksum. Export them with `POST /exports` before any operator action.
