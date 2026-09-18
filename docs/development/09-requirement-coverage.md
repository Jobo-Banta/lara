# Requirement coverage and release mapping

The [JSON register](contracts/requirements.json) contains every BRD requirement and acceptance-overlay ID, exact source text, production completion phase, owning specification and evidence requirement. Prototype demonstrations do not satisfy production requirements.

| Phase | Requirements completed in this phase | Specification |
| --- | --- | --- |
| P00 | 17 | [P00](03-phase-00-setup.md) |
| P01 | 4 | [P01](04-phase-01-prototype.md) |
| P02 | 37 | [P02](phases\p02-finance-workspace.md) |
| P03 | 24 | [P03](phases\p03-general-ledger-and-close.md) |
| P04 | 38 | [P04](phases\p04-sales-invoicing-and-receivables.md) |
| P05 | 14 | [P05](phases\p05-purchasing-payables-and-expenses.md) |
| P06 | 17 | [P06](phases\p06-treasury-cash-and-bank-reconciliation.md) |
| P07 | 73 | [P07](phases\p07-tax-compliance-and-e-invoicing.md) |
| P08 | 15 | [P08](phases\p08-financial-institution-coexistence.md) |
| P09 | 4 | [P09](phases\p09-multiple-currencies-and-separate-books.md) |
| P10 | 10 | [P10](phases\p10-inventory-costing-and-three-way-matching.md) |
| P11 | 14 | [P11](phases\p11-assets-recurring-work-and-recognition-schedules.md) |
| P12 | 36 | [P12](phases\p12-evidence-backed-ai-assistance.md) |
| P13 | 10 | [P13](phases\p13-customer-supplier-portals-and-messaging.md) |
| P14 | 2 | [P14](phases\p14-accounting-firm-multi-client-workspace.md) |
| P15 | 3 | [P15](phases\p15-intercompany-and-consolidation.md) |
| P16 | 5 | [P16](phases\p16-budgets-cost-allocation-and-project-accounting.md) |
| P17 | 11 | [P17](phases\p17-local-operations-feature-releases.md) |
| P18 | 9 | [P18](phases\p18-controlled-extensibility-and-advanced-assistance.md) |
| DEFERRED | 2 | Explicit non-enabled scope |
| REMOVED | 1 | Explicit non-enabled scope |

## Scope decisions

FR-PL-011 remains removed. FR-AR-019 remains deferred. AI-032 peer benchmarking is intentionally deferred beyond the build baseline because no privacy-preserving cohort design or consented dataset exists. This is a documented change from the optional future BRD item, not a silently omitted requirement. No other source ID is dropped.

## Composite requirements

- **FR-GL-004:** P03 basic manual templates; P11 completes recurring/scheduled execution.
- **FR-GL-009:** P02 separates legal entities; P15 completes intercompany/consolidation.
- **FR-SH-011:** P03 approved reports; P07 statutory outputs; P18A designer.
- **FR-AP-003:** P05 tax recognition; P07 completes all enabled certificate outputs.
- **FR-PL-002:** P02 establishes secured API; each module extends it in its own release.
- **FR-PL-006:** P07 supports minimum validated payroll-tax input for enabled 2316; P17D completes dedicated payroll integration/remittances.
- **FR-PH-029:** P03 reviewed spreadsheet migration; P12 completes manual-book OCR assistance.
- **FR-PH-030:** P13 optional eTSP hand-off; cannot activate without accredited partner contract and reconciliation.
- **RPT-006:** P07 delivers applicable 2306/2316 from validated external data; P17D completes payroll source integration.
- **RPT-007:** P03 management TB/BS/IS; P07 completes approved statement pack/disclosures for selected profile.
- **RPT-009:** P01 synthetic overview; P04/P06 live cash/sales; P16 complete margin/project/budget views.
- **RPT-012:** Party detail P05, schedule P11, budget P16; whole combined requirement complete at P16.
- **AI-013:** Deterministic readiness P07; optional AI explanation P12.
- **AI-015:** Deterministic withholding screening P07; optional AI explanation P12.
- **AI-016:** Deterministic input-tax rules P07; document OCR assistance P12.
- **AI-029:** P02 human task service; P12 adds AI producers, not a new inbox.
- **AI-030:** P14 deterministic multi-client prioritization; uses already released P12 AI when enabled.
- **REV-012:** P04/P06 live overview; P12 natural-language answers; prototype only in P01.
- **REV-013:** P01 initial user tests; repeat for every production module/cohort.
- **FR-AR-019:** Deferred in original BRD; no government-withholding implementation or activation promised.
- **FR-PL-011:** Removed corporate-secretarial work; keep tombstone, do not build.
- **AI-032:** Explicit scope decision: peer benchmarks deferred beyond this implementation baseline pending privacy/cohort design.
