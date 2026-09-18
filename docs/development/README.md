# LARA implementation specification

Version 1.1 · 18 September 2026 · Engineering handoff

This package defines what to implement, where it belongs, its data and API contracts, and the evidence required to ship it. It translates the [revised BRD](../DCP_BRD_LARA_v1_1.md) and [roundtable review](../LARA_BRD_Roundtable_Review_2026-09-18.md) into a new delivery sequence requested by the product owner: Phase 0 setup, Phase 1 demonstrable experience, then complete module releases.

## Read in this order

1. [Delivery phases and release policy](01-delivery-plan.md)
2. [Architecture and decisions](02-architecture.md)
3. [Phase 0 setup specification](03-phase-00-setup.md)
4. [Phase 1 prototype and UX specification](04-phase-01-prototype.md)
5. [Data model and accounting contract](05-data-and-accounting.md)
6. [API and workflow contract](06-api-and-workflows.md)
7. [Security, operations and release procedure](07-security-and-operations.md)
8. [Acceptance tests and accounting examples](08-verification.md)
9. [Phase specifications](phases/README.md)
10. [Requirement traceability](contracts/requirements.json), [OpenAPI contract](contracts/openapi.json), [state machines](contracts/state-machines.json), [accounting examples](contracts/accounting-cases.json), [delivery backlog](contracts/backlog.json)
11. [Coverage summary and composite requirements](09-requirement-coverage.md)
12. [Rule and provider qualification contracts](10-regulatory-and-provider-profiles.md)
13. [Feature details and edge cases](11-feature-details-and-edge-cases.md)
14. [UI design and approved asset contract](12-design-and-assets.md)
15. [Build tracking and update procedure](13-build-tracking.md) · [Open status page](../../build-status.html)

Machine-readable [release dependencies](contracts/release-plan.json), [permission registry](contracts/permissions.json), [event contracts](contracts/event-contracts.json), [request examples](contracts/request-examples.json) and [demo fixtures](contracts/demo-fixtures.json) accompany the specifications. The contract files contain design requirements, not production credentials or certified government schemas.

## Authority and readiness

The user's new phase instruction supersedes **release numbers** in BRD v1.1, including section 23. Business requirements and financial controls remain. A BRD “Phase 1” requirement is not automatically part of the new demo prototype. `requirements.json` assigns the production delivery phase; prototype coverage is recorded separately. This package is the implementation release authority; no renumbering of the original BRD is implied.

All `MUST` statements are acceptance requirements. Cross-cutting specifications apply to every module even when not repeated. Phase documents define the complete supported feature boundary, explicit exclusions and activation conditions. A dependency on a later phase must be removed, brought forward, or represented by a tested import/interface; a dead button is not a shipped capability.

Phase 0 ships a repeatable engineering environment. Phase 1 ships a hosted, persistent UX prototype for synthetic data, with production-quality authentication, deployment and tests for that purpose. Phase 2 onward ships progressively useful production modules. **Production-grade module does not mean every taxpayer may replace its CAS immediately.** Production activation is allowed only for the customer's complete supported scope and verified obligations. For example, a reporting-obligated taxpayer cannot activate live invoices before the certified reporting adapter is enabled.

Implementation defaults are deliberately selected here: TypeScript monorepo, Next.js UI, NestJS API, PostgreSQL ledger, OIDC identity, private object storage and durable database jobs. This is a design decision for the build, not a claim that the product exists or that a stakeholder signed an architecture record. Replacing these choices requires an ADR and contract-compatible tests.

## Decisions that need external evidence

| Gate | Engineering can build now | Activation evidence still required |
| --- | --- | --- |
| Repository and deployment accounts | Local layout, container build, CI template, configurable deployment | DCP remote owner, secrets, domain, hosting region and operators |
| BIR rules and e-invoicing | Versioned rule/profile engine, fixtures, adapters, replay/reconciliation | Reviewed legal profile, current authoritative schemas, taxpayer credentials and certification |
| Bank coexistence | Canonical journal/balance importer and explicit source ownership | Design-partner feed layout, required books/currencies/taxes and signed reconciliation boundary |
| AI | Permissioned draft tools, evaluation runner and deterministic demo provider | Provider contract, data region, approved model revision and passing evaluations |
| Internal DCP reuse | Stable adapter interfaces and local implementations | Fit-gap and operating evidence for SyncTax, JANUS, GAIA and Daedalus |

Unknown external values never become invented credentials, rates, guarantees or dummy production data. Their absence blocks the affected integration's activation, not unrelated development. There are no unresolved choices about the core database, repository layout, transaction contract or prototype scope.

The [DCP UI guide](../DCP_UI_STYLE_GUIDE.md) and current [Ledger-L web kit](../../images/branding/ledger-l/README.md) are mandatory implementation inputs through the [design contract](12-design-and-assets.md). Its approved petrol teal replaces earlier generic blue/teal guidance. Every work session updates the [build tracker](13-build-tracking.md); specification readiness is separate from implementation and release status.

## Implementation entry point

Start with backlog P00-01 through P00-08, then P01-01 through P01-10. Do not build the whole roadmap before releasing the prototype. Once P01 passes its demo gate, release each phase behind server-enforced entitlements, keeping the stable product deployable throughout. Each phase follows schema → domain transaction → API → UI → jobs/integrations → tests → operations → release, all inside that phase.

This package contains specifications and machine-readable contracts, not a completed application. Documentation checks are recorded in [validation results](VALIDATION.md); application, migration, security and load tests must be executed during implementation.
