# DCP UI Style Guide

This guide is a reusable visual reference for DCP digital products and internal tools. It describes a calm, high-trust interface style with clear hierarchy, light analytical surfaces, restrained color, and generous spacing. Each project can apply its own name, logo, and brand color while keeping these shared usability principles.

## Applying the guide to a project

Treat the tokens below as a starting theme, not a fixed brand. Set the product's name, logo, primary accent, and any domain-specific status colors in that product's theme. Keep shared roles such as background, surface, text, border, focus, success, warning, and danger consistent throughout the interface. Check color contrast after changing a token. A product's unique identity should come from its accent and approved assets, not from changing interaction patterns or weakening accessibility.

Use project artwork only when it is supplied and approved. Prefer a wordmark on a light surface and a compact symbol where space is limited. Decorative artwork should sit behind a strong contrast layer and must not compete with controls or content. When no approved artwork is available, use a text-based product name and the shared interface tokens; do not invent a logo.

## Design tokens

The sample theme below uses a restrained indigo accent, cool neutral surfaces, and distinct status colors. Replace the accent with the project's approved brand color and validate all text, focus, and control states against their backgrounds.

```css
:root {
  --color-accent: #5457e5;
  --color-accent-hover: #4245c6;
  --color-navigation: #171b26;
  --color-page: #f1f4f9;
  --color-surface: #ffffff;
  --color-text: #202635;
  --color-text-muted: #64748b;
  --color-border: #e5e9f0;
  --color-success: #0b766e;
  --color-warning: #9a5b00;
  --color-danger: #b42336;
  --color-info: #6250bd;
  --shadow-panel: 0 12px 28px rgba(20, 36, 61, .055);
  --radius-sm: 7px;
  --radius-md: 10px;
  --radius-lg: 12px;
}
```

Use the accent for primary actions, active navigation, and focus. Use status colors only to communicate status. Pair them with a text label or icon, and verify readable contrast for each actual foreground/background combination.

## Typography

Use a clear sans-serif for interface text. Manrope is a suitable default; use the project's approved typeface when one exists, with a system sans-serif fallback. Use a monospaced face such as DM Mono for IDs, dates, evidence identifiers, and compact technical metadata.

- Page title: 28–32px, weight 700–800, tight letter spacing.
- Section title: 16–20px, weight 700.
- Body: 12–14px, line height 1.6–1.8.
- Metadata: 10–11px, muted text color.
- Eyebrow: 10px, uppercase, letter spacing around 1.2px.
- IDs and timestamps: 10–11px, monospaced.

Use sentence case for labels and headings. Keep explanatory copy short and direct. Preserve comfortable reading size and line length on dense data views.

## Layout

For desktop analytical tools, use a persistent 250–265px navigation rail and a flexible content area. Use the page background for the canvas and white or near-white panels with a subtle border and shadow. Apply 18–24px panel padding and 20–24px gaps between major regions.

Place the current location, search, and one primary action in the top bar. Add an environment or connection strip only when it helps users interpret the current data. On screens below 760px, collapse navigation into an off-canvas menu, hide secondary top-bar actions, and arrange panels in one column. Adapt these measurements when a project has a different information architecture; retain clear hierarchy and usable spacing.

## Components

Primary buttons use the project accent with readable text. Hover and pressed states should remain visibly distinct. Secondary buttons use a surface fill and border. Reserve danger styling for destructive actions or genuinely dangerous states.

Cards use a surface background, 1px border, 10–12px corner radius, and a light shadow. Metrics show the label first, the value second, and a muted explanation third. Tables use clear headers, generous row padding, and horizontal scrolling on narrow screens rather than shrinking text until it is hard to read.

Navigation uses simple outline icons, usually 16–18px. Show the active destination with a tinted background and a visible indicator. Keep labels short and group related destinations under clear section labels.

Forms use visible labels, readable input text, clear validation messages beside the relevant field, and a strong focus outline. Dialogs use a clear title and actions that are easy to identify; align actions to the right on desktop and allow them to wrap on mobile.

## Interaction and accessibility

Every interactive element must have a visible keyboard focus state. Include a skip link, semantic headings, labelled form controls, an accessible name for icon-only buttons, and an appropriate current-page indicator for navigation. Do not rely on color alone to communicate status. Respect `prefers-reduced-motion`, support keyboard operation, and verify text and control contrast against WCAG AA targets.

Use feedback where it helps users understand the result of an action: loading, success, validation, empty, partial, and failure states should be distinct and described in plain language. Keep destructive actions clear and provide a recovery path when one is available.

## Product tone

Interfaces should feel precise, accountable, and composed. Explain why a decision or recommendation appears, show relevant evidence, and make human ownership visible when it matters. Avoid decorative gradients, excessive pills, crowded dashboards, and claims of automation that the product cannot substantiate.

## Project implementation

Keep shared design tokens and interaction patterns separate from product-specific content and assets. Define a small theme layer for each project rather than renaming shared roles throughout component styles. Use the approved product logo, typeface, and accent where available; document any deliberate departures from this guide so future projects can distinguish shared conventions from local choices.
