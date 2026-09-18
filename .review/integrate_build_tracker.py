from pathlib import Path
import json
root=Path(__file__).resolve().parents[1]
dev=root/'docs/development'
def replace(file,old,new):
    p=dev/file
    s=p.read_text(encoding='utf-8')
    assert old in s, (file,old)
    p.write_text(s.replace(old,new),encoding='utf-8')
replace('README.md','Version 1.0 ·','Version 1.1 ·')
replace('README.md','13. [Feature details and edge cases](11-feature-details-and-edge-cases.md)','13. [Feature details and edge cases](11-feature-details-and-edge-cases.md)\n14. [UI design and approved asset contract](12-design-and-assets.md)\n15. [Build tracking and update procedure](13-build-tracking.md) · [Open status page](../../build-status.html)')
replace('README.md','## Implementation entry point','The [DCP UI guide](../DCP_UI_STYLE_GUIDE.md) and current [Ledger-L web kit](../../images/branding/ledger-l/README.md) are mandatory implementation inputs through the [design contract](12-design-and-assets.md). Its approved petrol teal replaces earlier generic blue/teal guidance. Every work session updates the [build tracker](13-build-tracking.md); specification readiness is separate from implementation and release status.\n\n## Implementation entry point')
replace('04-phase-01-prototype.md','Use a neutral finance-workbench visual style and a restrained blue/teal action accent; no dashboard decorations without actionable information.','Implement the [DCP UI guide](../DCP_UI_STYLE_GUIDE.md) and approved [Ledger-L assets](../../images/branding/ledger-l/README.md) through the mandatory [design and asset contract](12-design-and-assets.md). Use petrol teal actions, warm-white analytical surfaces and shared components. P01-T05 includes asset, responsive, keyboard and contrast checks; no dashboard decorations without actionable information.')
replace('03-phase-00-setup.md','## Environments and configuration','## Design assets and build visibility\n\nImplement [UI design and asset packaging](12-design-and-assets.md) in the baseline: shared theme scaffolding, deterministic copy from the approved Ledger-L kit to `apps/web/public/assets/lara/`, provenance checks and asset validation in CI. Preserve the supplied guide and branding sources. Register [build tracking](13-build-tracking.md) in the contributor workflow and run `python scripts/build_status.py check` in CI. Phase 0 may wrap the independent tracker utility in documented `pnpm status:*` commands. P00-01 owns packaging and P00-05 owns CI enforcement. The existing tracker is a delivery utility and does not satisfy the application baseline gate.\n\n## Environments and configuration')
replace('02-architecture.md','## ADR 002 Deployment shape','Shared components in `packages/ui` implement the [design and asset contract](12-design-and-assets.md): DCP interaction patterns with the approved Ledger-L theme. Copy source web assets deterministically to the application public directory; do not recreate logos or use retired concepts.\n\n## ADR 002 Deployment shape')
replace('08-verification.md','## Test layers','## Test layers') if False else None
with (dev/'08-verification.md').open('a',encoding='utf-8') as f:
    f.write('\n## Design and tracker checks\n\nEvery UI release verifies the [design and asset contract](12-design-and-assets.md): current logo, asset integrity, theme, keyboard operation, responsive layouts and contrast. At handoff, update build tickets and evidence following [build tracking](13-build-tracking.md); run `python scripts/build_status.py check` to verify generated data matches the plan. This check is tracker validation, not application acceptance.\n')
with (dev/'01-delivery-plan.md').open('a',encoding='utf-8') as f:
    f.write('\n## Delivery visibility\n\nThe [build status page](../../build-status.html) tracks every release increment and backlog ticket. Follow the [update contract](13-build-tracking.md) at each work-session handoff and release. All module UI work follows the [approved design and asset contract](12-design-and-assets.md).\n')
with (root/'docs/README.md').open('a',encoding='utf-8') as f:
    f.write('\n- [Build status page](../build-status.html): phases, modules, tickets, dependencies and release evidence.\n- [Design and asset contract](development/12-design-and-assets.md): DCP style guide and approved Ledger-L integration.\n- [Tracker update instructions](development/13-build-tracking.md): live preview and progress maintenance.\n')
replace('12-design-and-assets.md','P00-07 includes','P00-05 includes')
p=dev/'contracts/backlog.json'
b=json.loads(p.read_text(encoding='utf-8'))
add={'P00-01':' Include shared theme scaffolding and deterministic approved Ledger-L asset packaging per 12-design-and-assets.md.',
     'P00-05':' Include asset provenance, design checks and scripts/build_status.py check in CI.',
     'P01-01':' Apply docs/DCP_UI_STYLE_GUIDE.md and images/branding/ledger-l/web through 12-design-and-assets.md; verify approved branding, contrast and responsive states.'}
for t in b['tickets']:
    if t['id'] in add:t['implementation']+=add[t['id']]
b['notes']+=' Every work-session handoff updates the build tracker per 13-build-tracking.md. Every UI ticket follows 12-design-and-assets.md.'
p.write_text(json.dumps(b,indent=2)+'\n',encoding='utf-8')
