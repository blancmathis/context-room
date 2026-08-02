# Quiet Native Workbench

## Direction Contract

**THESIS:** Context Room is a continuous documentation-review workbench, not a
dashboard of floating cards. It keeps navigation, scope, and the current human
decision spatially stable.

**OWN WORLD:** Native split panes, calm neutral surfaces, one cyan accent,
hairline separators, compact controls, system typography, and dense lists with
clear selected states. Themes own color only; geometry is shared.

**STORY:** The user finds the right project or document in Explorer, sees the
review work that matters, understands its consequence, and accepts or rejects
the file without losing place.

**FIRST VIEWPORT:** A persistent Explorer sits left, a 46-pixel title bar spans
the work area, and Home opens directly on the review queue. Secondary health,
startup, and technical detail remain available through disclosures or an
optional inspector.

**FORM:** Operate-first native desktop workbench, anchored in Codex and Claude
Desktop, with Linear density and Creed-style document review.

## Foundations

### Typography

- UI: `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, sans-serif.
- Code and paths: `ui-monospace`, `SFMono-Regular`, Menlo, monospace.
- Shell text: 12–14 px. Body text: 15–17 px. Document line-height: 1.68–1.72.
- Use 500, 600, and 700 weights. Avoid decorative uppercase and weights above
  750.
- Reading measure is 65–76 characters per line.

### Geometry

- Title bar: 46 px.
- Base spacing unit: 4 px. Use the shared 8, 12, 16, 20, and 24 px steps
  instead of introducing one-off offsets.
- Workbench surface gutter: 20 px on desktop and drawer layouts, 12 px at
  639 px and below. Headers, toolbars, list rows, section bodies, and sticky
  footers on the same surface share this horizontal edge.
- Explorer gutter: 8 px. The open Explorer header and its controls align to
  this edge; the collapsed 48 px rail centers its single control geometrically.
- Inspector gutter: 16 px on wide layouts and 12 px on mobile.
- Dialog gutter: 20 px on desktop and 12 px on mobile. Dialog headers, bodies,
  and confirmation footers keep the same horizontal edge.
- Component-internal spacing may use 8–16 px when it expresses grouping, but
  it must not move a surface's primary content edge.
- Compact, default, and prominent controls: 28, 32, and 36 px.
- Interactive rows: 36–44 px.
- Radii: 6 px for controls, 8 px for groups, 10 px for dialogs.
- Use one 1 px separator or one subtle shadow, never both for routine surfaces.
- Pills are reserved for statuses, filters, and compact segmented controls.

#### Executable layout contract

The canonical geometry is mirrored by `test/e2e/layout-contract.mjs` and
enforced by `npm run test:layout`.

| Surface | Desktop and drawer | Mobile (≤639 px) |
|---|---:|---:|
| Workbench | 20 px | 12 px |
| Explorer | 8 px | 8 px |
| Inspector | 16 px | 12 px |
| Dialog | 20 px | 12 px |

- Structural rhythm uses only 4, 8, 12, 16, 20, and 24 px.
- A surface header, toolbar, rows, body, and footer share the same semantic
  horizontal edge. Nested components may add internal spacing, but may not add
  a second surface gutter.
- Scroll containers reserve their sticky or fixed footer space. Intentional
  horizontal scrollers must remain keyboard reachable and must expose their
  complete first and last items.
- Optical exceptions are limited to the search glyph, the two-pixel active tab
  indicator, and the collapsed Explorer control. The executable manifest owns
  the reason for each exception and tests its computed geometry.
- Geometry is authored once inside the `LAYOUT CONTRACT` section of the product
  stylesheet. Responsive changes use only 639/980/981/1280 boundaries; older
  640, 680, and 900 px geometry tiers are rejected by the static audit.

### Spatial Model

- Explorer: 272 px initially, resizable from 220 to 360 px.
- Collapsed Explorer: 48 px rail on wide screens.
- Main content: flexible and never wrapped in an outer floating card.
- Optional inspector: 320 px initially, resizable from 300 to 380 px.
- At 981–1279 px the inspector becomes a drawer. From 640–980 px the Explorer
  is a side drawer. At 639 px and below it becomes a full-screen surface. These
  same boundaries are used by CSS and browser state logic.

### Motion

- Use 120–180 ms exponential ease-out for selection, disclosure, and pane
  transitions.
- No hover lift, pulsing backgrounds, decorative drift, or repeated entrances.
- Honor `prefers-reduced-motion` by removing nonessential animation.

## Color Model

Structure uses semantic variables: canvas, sidebar, surface, elevated surface,
separator, primary text, secondary text, accent, selection, success, warning,
danger, and review. Components never bind directly to a theme hex value.

The Context Room palette supports `system`, `light`, and `dark` modes. Existing
VS Code Dark, GitHub Dark, Dracula, Solarized Dark, and Light Plus palettes stay
explicit. Every palette inherits the same spacing, shapes, states, and motion.

Color communicates selection or status only when paired with text, an icon, or
another non-color signal. Primary actions use a solid accent fill; gradients are
not part of the product chrome.

## Components

- **Title bar:** brand/Home, history, context title, then current actions.
- **Explorer rows:** icon, label, optional trailing state; selected rows use a
  quiet filled surface rather than an outlined card.
- **Buttons:** solid primary, quiet secondary, icon-only, and destructive.
- **Fields:** 32–36 px, subtle surface, clear focus ring, no heavy inset shadow.
- **Lists:** hairline-separated rows with one selected state and no hover motion.
- **Disclosures:** a compact, unframed 16 px leading chevron aligns with the
  summary title so the expandable behavior is visible without resembling a
  separate button; the body is bordered only while open and follows the title's
  leading edge rather than restarting beneath the chevron.
- **Concept help:** uncommon product concepts use a compact labeled help button
  that opens a focused accessible dialog; explanatory content does not occupy a
  settings disclosure row or compete with editable controls.
- **Dialogs and menus:** 10 px radius, compact searchable rows, footer only when
  confirmation is required.
- **Settings:** flat horizontal tab strip, grouped rows, sticky integrated Save
  bar, and progressive disclosure.

## Surface Rules

- Home begins with the combined local/shared Review queue. User sections remain
  below it, including empty sections.
- Explorer remains available on every product surface and preserves project,
  worktree, folder, collapse, and selection state.
- Documents are calm centered reading canvases; editing and review actions stay
  in the contextual title bar or file header.
- Proposal identity, purpose, progress, and next action share one header. The
  file list remains visible beside the selected review when width permits.
- Startup environment and Context health open in place and never replace Home
  with a legacy page.

## States and Accessibility

Every interactive component must define default, hover, focus, active,
disabled, loading, empty, warning, conflict, and error behavior when relevant.
Focus indicators use at least a 2 px outline with sufficient contrast. Touch
targets remain at least 40 px on narrow layouts even when desktop controls are
more compact.
