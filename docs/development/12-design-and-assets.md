# UI design and asset implementation contract

Applies to Phase 0, the Phase 1 prototype and every subsequent module. These are acceptance requirements, not optional inspiration.

## Authority and source files

1. [DCP UI Style Guide](../DCP_UI_STYLE_GUIDE.md) governs layout, interaction, typography roles, accessibility and component behavior.
2. [Current brand selection](../../images/branding/README.md) and [Ledger-L kit instructions](../../images/branding/ledger-l/README.md) govern LARA's identity, logo, palette and asset usage. The kit's petrol teal replaces the style guide's sample indigo. Older concepts have been removed; `images/branding/ledger-l/` is the only approved asset source.
3. [Asset catalogue](../../images/branding/ledger-l/index.html), [asset manifest](../../images/branding/ledger-l/asset-manifest.json) and [theme CSS](../../images/branding/ledger-l/web/lara-theme.css) are the implementation inputs. The catalogue and campaign images are references, not application screens or functional components.
4. Financial controls, truthful simulation labels and permission rules in the implementation specs remain mandatory. A visual asset cannot override a control or imply completed functionality.

## Theme contract

Implement shared tokens in `packages/ui/src/theme.css`; import them once in the application root. Map `--color-accent` to `#125D66`, `--color-accent-hover` to `#0D4850`, `--color-page` to `#F6F8F5`, `--color-surface` to `#FFFFFF`, `--color-text` to `#202E3A`, `--color-text-muted` to `#52636E`, `--color-border` to `#C7DEDA`, and `--color-navigation` to `#202E3A`. Keep semantic success/warning/danger tokens separate from brand colors. Mint `#69D5C4` is decorative emphasis, never body text on white. Focus uses a visible teal outline with sufficient offset; do not remove the browser outline without an equivalent.

Use `Manrope, system-ui, sans-serif`; no font binary is included in the kit, so system fallback is the initial baseline. Self-host a licensed font only if separately added and reviewed; no runtime third-party font dependency. IDs use a system monospace stack. Follow the guide's type scale, 10–12px panel radii and 18–24px panel padding. Desktop navigation is 250–265px; below 760px use a keyboard-accessible menu or a documented equivalent for small utilities. All screens support 200% zoom and 320px reflow except genuinely two-dimensional data tables.

## Asset mapping and packaging

Copy approved `images/branding/ledger-l/web/` assets to `apps/web/public/assets/lara/` during the build with a deterministic script; preserve folder structure and relative CSS background paths. Record source paths and SHA-256 checksums in the build manifest; CI detects missing assets and drift. Keep the originals unchanged. Do not copy generator scripts or marketing artwork from `images/branding/ledger-l/brand/` into the application bundle by default.

| Purpose | Source under `images/branding/ledger-l/web/` | Runtime URL |
| --- | --- | --- |
| Light-header wordmark | `logos/lara-logo-primary.svg` | `/assets/lara/logos/lara-logo-primary.svg` |
| Dark navigation wordmark | `logos/lara-logo-reverse.svg` | `/assets/lara/logos/lara-logo-reverse.svg` |
| Compact identity | `logos/lara-symbol-primary.svg` | `/assets/lara/logos/lara-symbol-primary.svg` |
| Browser / touch icons | `logos/favicon.svg`, `logos/favicon.ico`, `logos/lara-icon-180.png` | Corresponding `/assets/lara/logos/` URLs |
| Module / action icons | `icons/*.svg`, `icons/sprite.svg` | Inline reviewed SVG or same-origin sprite |
| Empty and completion states | `illustrations/empty-records.svg`, `empty-search.svg`, `review-complete.svg` | Corresponding `/assets/lara/illustrations/` URLs |
| Optional help illustration | `illustrations/lara-mascot-transparent.png` | `/assets/lara/illustrations/lara-mascot-transparent.png` |

Use explicit image dimensions, preserve aspect ratio and wordmark clear space, and prefer the supplied favicon at 16–32px. Wordmarks need no font download. Decorative assets use empty alternative text; the main logo uses `alt="LARA"`. Icons accompany visible labels or accessible names. Completion illustrations appear only for actual completed states. Keep marketing art and large mascot images out of dense transaction workspaces. The starter manifest requires actual `start_url`, scope and icon URL validation before registration; it does not establish offline financial processing.

## Phase obligations and acceptance

- P00-01 adds deterministic asset copying and provenance checks; P00-05 includes asset and accessibility checks in CI. Shared theme/component scaffolding is delivered with the baseline, not a redesign after the prototype.
- P01-01 shell and all P01 UI tickets use the approved theme and assets. Build reusable navigation, buttons, forms, validation, status labels, tables, dialogs and evidence panels with loading, empty, error, disabled and permission-limited states.
- P01-T05 and every subsequent UI acceptance gate include keyboard-only flows, visible focus, screen-reader names, 390px mobile and desktop screenshots, 200% zoom and measured WCAG AA contrast. Test all token/background combinations actually used. Verify no retired logo, broken image, clipped primary action or invented completion state.
- Each module's UI ticket reuses `packages/ui`; record deliberate departures with reason and visual evidence in the release record. Brand compliance never substitutes for usability testing.

The repository [build status page](../../build-status.html) follows these sources and is a delivery utility, not the Phase 1 application. Its update contract is in [Build tracking](13-build-tracking.md).
