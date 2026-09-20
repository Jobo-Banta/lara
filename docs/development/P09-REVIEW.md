# P09 implementation review — 20 September 2026

P09 is in progress, not released. Build-order steps 1 (contracts, migration, permission and capability definitions), 2 (domain and calculation rules), 3 (API) 4 (user journeys) and 5 (acceptance and operations) are implemented; no `multi_currency` capability is activated for a live entity and no rate source adapter exists — rates enter by review from published evidence. Investment, loan and trust instrument engines are not implemented, as the phase scope says.

## P09-01 contracts and migration

Contracts: the 17 P09 operations (`/books` create/list/get/edit/activate, `/fx-rates` create/list/get/edit/approve, `/revaluations` create/list/get/edit/preview/approve/post) and their schemas were already in the reviewed OpenAPI (`GET /books` was served since P03); the `book.*`, `fx_rate.*` and `revaluation.*` permissions and the `multi_currency` capability (depends on `fi_coexistence`) were seeded by `0009`. Under the phase rule that screens may add read/list operations, four reads were added and the catalog regenerated (369 operations): `GET /currencies`, `GET /fx-layers` (`openItemId`, `partyId`), `GET /revaluations/{id}/lines` (the preview) and `GET /books/{id}/combined` (`asOf`). `validate_specifications` passes.

Migration `0024_p09_fx_and_books.sql`:

- `currency_metadata` (code, name, minor units; read-only reference rows for PHP, USD, EUR, JPY, GBP, SGD, HKD, CNY, AUD, CAD, KRW, AED).
- `books.kind` extended to `primary | separate | rbu | fcdu | trust | management`; one primary per entity stays enforced.
- `book_access` (book, principal, read | post, granted by another principal) and `book_links` (source book → management view, `as_is | closing_rate | exclude`).
- `fx_rates` (base, quote, date, rate > 0, source evidence; draft → approved | rejected → draft; approver ≠ author; one approved per pair and date; approved rates immutable).
- `journal_entries.fx_rate` (default 1, must be 1 when the transaction currency is the functional currency) and `fx_rate_id`; every existing entry is backfilled as transaction = functional at rate 1, posted values unchanged.
- `fx_open_item_layers` (append-only events `open | settle | reverse | revalue` per open item with the consumed transaction and functional amounts, the realized FX, the remaining transaction amount and the functional carrying value, and the rate).
- `revaluation_runs` (book, period, rate set = an approved rate row, currency, method `closing_rate`, account ids, `reverse_next_period`, preview, `adjusts_run_id`, entry and reversal; draft → previewed → approved → posted | rejected; approver ≠ preparer; one run per book, period and rate set; approved content frozen; a posted run keeps its entry).
- `lara.post_journal_entry` now accepts a foreign transaction currency with the approved `rate`: every line carries its functional amount (supplied by the owning module with the residual on the control line, or translated at the rate), functional totals must balance and sides must match, the header totals are functional, the rate and rate id are recorded; a foreign currency without a rate is refused ("rates never default to 1"), a management book never posts, and a partition with access grants admits only its granted posters.
- RLS `tenant_scope` policies, `touch_row` triggers, grants to `lara_api` (rates, runs, grants, links, layers) and read access for `lara_worker` and `lara_audit_reader`.

Verification: `scripts/test-p09-schema.mjs` (5 groups) in CI on fresh and upgraded databases; teardown and snapshot tooling cover the six new tables.

## P09-02 domain and calculation rules

`packages/domain/src/fx.mjs` with hooks in `ledger.mjs`, `sales.mjs` and `purchasing.mjs`:

- FX profile (`settings_versions` kind `fx_profile`): realized and unrealized gain and loss accounts and the controller's classification of monetary accounts.
- Rates are quoted in a functional currency of the entity per one unit of the foreign currency; an inverted pair (quote not a functional currency) and a value off the recent approved rate by more than a factor of ten are refused (P09-T03); approval is independent; `rateFor` returns the approved rate dated exactly on the document, value or period-end date or blocks (`STATE_CONFLICT`, never 1).
- Foreign-currency documents (invoices, credit notes, bills) post both amounts at the approved rate of the document date: each line translates half-up to the quote currency's minor units, the control line carries the rounding residual, the open item gets a layer (remaining transaction amount, functional carrying value).
- Settlements (receipts and payments) in the document currency post the transaction entry at the value-date rate and consume the layers proportionally — the allocation that clears an item absorbs rounding (P09-T01, three-way 33.33 example) — and the realized difference (functional cash equivalent minus consumed carrying value, sign by AR/AP direction) posts as a separate functional adjustment with explicit purpose against the control account, so AC-10 holds exactly: Bank 5,700 / AR 5,600 / FX gain 100. Foreign-currency receipts and payments allocate their full amount at posting so the realized FX is known; later allocations on FX items and withholding on FX settlements are refused.
- Reversals (receipt reversal, payment return, journal reversal) keep the original rate and functional amounts, reverse the realized adjustment at its original amount and restore the layers (P09-T04).
- Revaluation: only accounts classified monetary, at the approved rate dated on the period end; the preview shows per account the transaction-currency balance, the functional carrying value (transaction lines plus earlier revaluation and realized adjustments for the currency), the revalued amount and the difference, with a checksum re-verified at approval; posting is one functional adjustment entry (a retry returns the same entry) with the optional reversal on the first day of the next open period; a second run for the same rate set is refused and a later rate set links to the earlier run and posts only the delta (P09-T02).
- Books: separate kinds and other functional currencies need the capability; a new partition is a draft activated by another principal; a management view never posts; partitions with grants are closed to everyone else for drafting, reading and posting (P09-T03); the combined view reads each linked source book once, translates at the approved closing rate where the policy says so, labels its basis and exclusions, and blocks on a missing rate (P09-T05). Manual foreign-currency journals translate at the accounting-date rate.

Verification: `scripts/test-p09-domain.mjs` (7 groups) covers P09-T01–T05 and AC-10; P03–P08 suites pass with the FX hooks (their currency gates now read "needs the multi-currency capability").

## P09-03 API

All 17 operations plus the four reads are served by `apps/api/src/workspace-api.mjs` (`POST /books` joins `GET /books`; book edit and activation; rate review; revaluation preview, approval and posting with `If-Match`). No new jobs: postings are synchronous inside the command transaction.

Verification: `scripts/test-p09-api.mjs` (5 groups, API as a process, in CI): rates with the inverted pair refused and independent approval, AC-10 through `/invoices`, `/collections` and `/fx-layers`, books created, edited, activated and combined (blocked on a missing rate), a revaluation refused for a non-closing rate and an unclassified account then created, previewed, approved, posted once with its reversal, 404s and later-phase gates.

## P09-04 user journeys

`apps/web/src/app/_components/workspace-fx.tsx`: rate import and review at `/fx/rates`, revaluations at `/fx/revaluations` (period, closing rate set, monetary accounts, preview table with differences, approve, post), books at `/books` (selector with partitions, creation, activation, combined management view labelled with basis, exclusions and blocked books). The invoice and receipt editors offer a currency under the capability; the invoice detail shows the transaction and functional side by side with the layer history and realized FX. The capabilities screen offers the activation.

Verification: `tests/browser/workspace.spec.mjs` multi-currency journey on the production composition — two-principal activation, three rates drafted by the desk with the self-approval refused and approved by the controller, a USD invoice issued with both amounts and its layer shown, a second unpaid one, a receipt at another rate allocated on the workbench and posted with the realized gain shown on the invoice, a revaluation created, previewed, approved and posted, an FCDU book and a management view created and activated by another principal, the combined view, WCAG checks on the three routes (also in CI).

## P09-05 acceptance and operations

Acceptance: P09-T01–T05 and AC-10 in `scripts/test-p09-domain.mjs` and `scripts/test-p09-api.mjs`; CORE regressions unchanged; migration, restore and fresh/upgrade paths in `scripts/ci-database.mjs`. `P09-RUNBOOK.md` covers activation gates, the rate convention, document and settlement posting, revaluation, partitions and access, the combined view and the rollback rule (disable new FX activity, keep native-currency history).

## Open items for the owner

- No reviewed operations exist for the FX profile, book access grants, book links or currency metadata; the domain implements grants and links and the journey seeds them through the runtime role.
- No seeded role template holds `fx_rate.create/edit` or `revaluation.create/edit/preview/approve/post`; tenants create FX desk and approver roles (tests and the journey do).
- Rates are reviewed from published evidence; a rate feed adapter with its own evidence trail is a separate activation gate.
- Foreign-currency settlements allocate in full at posting; unapplied foreign-currency receipts (advances) and withholding on foreign-currency settlements are refused until a reviewed treatment exists. Cross-currency settlements (a USD receipt against a PHP invoice) are refused; the allocation workbench still formats every open item in pesos.
- The functional-currency change of an active book is refused as an edit; the reviewed migration procedure is not yet written.
- Treasury bank accounts, transfers and checks in foreign currencies stay gated ("arrive with P09" messages) and are the next candidates now that the posting function translates.
- `ADR 001` still names NestJS/Vitest; the codebase remains plain Node + `node:test` (see `P02-REVIEW.md`).
