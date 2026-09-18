# LARA branding and web asset kit

Current approved identity: **Ledger-L**, September 18, 2026. Open `index.html` for the visual catalogue. This is the only approved asset set; older concepts have been removed.

**Development:** use `web/`. **Marketing:** use `brand/` for finished artwork and `web/` for reusable elements. The ZIP in the parent folder contains this same kit.

## Contents

| Folder | Files and intended use |
| --- | --- |
| `brand/` | Five refreshed PNGs: avatar sheet, brand overview, website hero, square launch campaign and portrait product infographic. |
| `web/logos/` | Transparent vector symbols and wordmarks in primary, monochrome, reverse and white; app and maskable icons; transparent PNG exports; SVG/ICO favicon; PNG icons at 16, 32, 48, 180, 192 and 512 pixels. |
| `web/icons/` | 32 individual SVG icons and an SVG sprite for accounting and common interface actions. |
| `web/backgrounds/` | Eight backgrounds, each as SVG and PNG: page light/dark, banner light/dark/teal, mobile banner, square social canvas and repeatable ledger tile. |
| `web/illustrations/` | Three editable SVG empty-state illustrations and the transparent LARA mascot. |
| `web/lara-theme.css` | Palette and responsive banner styling. |
| `web/manifest.webmanifest` | Starter app manifest; supply the application's start URL and scope during implementation. |

## Logo rules

Use the Ledger-L mark: a substantial L-shaped ledger spine, two equal horizontal entry bars and a folded-page corner. The same emblem appears on LARA's vest. Do not use the retired upright paired-column mark.

The SVGs are clean geometric production reconstructions of the approved raster concept. Wordmark letters are outlines, so no font download is required. Use SVG wherever possible; PNGs are provided for tools that require them. Raster campaign artwork may have small generative variations; the supplied SVG symbol is the canonical web geometry.

Use primary/mono on light surfaces, reverse/white on dark teal or ink. Give the symbol at least one entry-bar height of clear space and avoid stretching it. At 16–32 pixels use the supplied app icon or favicon. Use the full wordmark at approximately 120px wide or larger; omit taglines at small sizes.

Colors: petrol teal `#125D66`, sea-glass `#69D5C4`, warm white `#F6F8F5`, ink `#202E3A`. Mint is an accent, not body text on light backgrounds. Use Manrope or a system sans-serif for surrounding interface text; retain the original personality: calm, attentive, accountable.

## Web integration

Adjust paths to your deployed public asset directory. These are examples, not application changes.

```html
<link rel="icon" href="/assets/lara/logos/favicon.svg" type="image/svg+xml">
<link rel="alternate icon" href="/assets/lara/logos/favicon.ico">
<link rel="apple-touch-icon" href="/assets/lara/logos/lara-icon-180.png">
<link rel="manifest" href="/assets/lara/manifest.webmanifest">
<link rel="stylesheet" href="/assets/lara/lara-theme.css">
<img src="/assets/lara/logos/lara-logo-primary.svg" width="232" height="56" alt="LARA">
```

Individual icons use a 24 × 24 viewBox, 1.75px strokes and `currentColor`. Inline the SVG markup or use the sprite to inherit the surrounding CSS color; an external `<img>` does not inherit the page's color. Keep icons at 20–32px for normal interface use. Keep stroke widths proportional.

```html
<button type="button">
  <svg class="lara-icon" aria-hidden="true" focusable="false">
    <use href="/assets/lara/icons/sprite.svg#lara-ledger"></use>
  </svg>
  General ledger
</button>
```

Icon-only buttons need an accessible label. Decorative icons should be hidden from assistive technology. A status icon alone must never communicate approval or financial correctness. Use visible text and real application state. Serve external SVG sprites from the same origin; direct file previews may restrict external sprite references.

## Backgrounds and banners

Desktop banners are 1920 × 640. Keep headings/actions in the left 58%, where the background stays quiet. Light banners use ink/teal text; dark and teal banners use white. The 720 × 960 mobile version reserves its upper area for copy; do not crop a desktop banner into a narrow mobile layout.

Page backgrounds are 1920 × 1080. The social background is 1200 × 1200 with space for content in the upper/left area. The 160 × 160 ledger tile is transparent and designed to repeat. These files contain no headline or CTA so website text remains editable, selectable and accessible.

The mascot PNG is decorative supporting artwork. Keep functional copy separate. SVG empty states include descriptive names, but pair them with context-specific text and an actionable next step in the product.

## Brand and factual boundaries

Tagline: **Clear books. Clear next steps.** Promise: bring clarity to finance work, with evidence in view and people in control. LARA's expert visual identity does not imply licensed professional status or autonomous financial authority.

The marketing assets retain their visible product-concept and planned-capability qualifications. Benefits are intended, not measured. Human review remains central. The website hero is an image, not a working website; this package is not an implemented application.

Sources: `docs/DCP_BRD_LARA_v1_1.md` (September 18, 2026), `docs/README.md`, `docs/development/VALIDATION.md`, `docs/development/phases/p12-evidence-backed-ai-assistance.md` and `docs/DCP_UI_STYLE_GUIDE.md`, reviewed September 18, 2026. Product positioning and voice guidance are retained in `PRODUCT-POSITIONING.md`. No measured performance or certification claims were added.

## Production

Brand PNGs and the mascot were edited/generated with the built-in image tool; exact prompts are in `generation-prompts.md`. Web logos, icons and geometric backgrounds are editable SVG artwork rendered to PNG in a browser. `build-web-kit.cjs` rebuilds the vector assets and catalogue; `render-web-kit.cjs` exports browser renders when Google Chrome and Node are available on Windows. Generation is not automatically rerun by these scripts.

Older concepts and obsolete guides were removed at the user's request. Use this kit for all new work. Nothing was published and no application code was changed.
