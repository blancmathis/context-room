---
context_room:
  id: assurance.interface-accessibility
  kind: canonical
  scope: context-room
  status: current
  canonical_for: application-shell accessibility and responsive interaction
  last_verified: 2026-08-08
  sources: [src/context_room.mjs, test/e2e/accessibility.spec.mjs, test/e2e/layout-contract.spec.mjs]
---

# Interface Accessibility

## Summary

Every owner action in Context Room must remain understandable and operable by
keyboard, pointer, touch, zoom, and assistive technology. Responsive layouts
may change geometry, but they do not remove meaning, focus order, status, or
access to review and proposal decisions.

## Defines

The semantic, focus, keyboard, touch, contrast, motion, responsive, and
automated accessibility requirements of the Context Room application shell.

## Does not define

The information architecture of Settings, Explorer file behavior, or human
review authority. Those remain owned by [Settings](../features/settings.md),
[File Explorer and Editor](../features/file-explorer-and-editor.md), and
[Review authority](../features/review-authority.md).

## Semantic And Keyboard Invariants

- Every visible form field and interactive control has one programmatic name.
  A glyph, disclosure marker, status badge, placeholder, or tooltip is never
  the only accessible name.
- Settings categories expose tab, selected-tab, and tabpanel relationships.
  Search results, counts, validation, loading, errors, and terminal outcomes
  use an appropriate live status without stealing focus.
- Explorer folders expose whether they are expanded and use names that explain
  both the folder and the available action. Menus expose menu semantics and
  support arrow keys, Enter, and Escape as well as pointer input.
- Every pointer action has a keyboard path with visible focus. Focus order
  follows the visual and reading order.

## Dialog And Drawer Invariants

- A dialog has a programmatic name, receives focus when it opens, contains Tab
  and Shift+Tab while open, closes with Escape when the action is not pending,
  and restores focus to its launcher.
- The application behind a modal dialog is inert until that dialog closes.
- On narrow layouts, the Explorer becomes a temporary drawer. Opening it moves
  interaction into the drawer, closing it restores the launcher, and hidden
  document content is not exposed as an active parallel surface.

## Visual And Responsive Invariants

- Normal text meets WCAG AA contrast; large text and meaningful component
  boundaries meet the applicable WCAG AA threshold in every theme.
- On touch layouts, primary controls, search actions, tree rows, review actions,
  and modal controls provide at least a 40-by-40 CSS-pixel hit area. Compact
  inline text links may use their natural text area when surrounding spacing
  prevents accidental activation.
- At 320, 375, and 390 CSS pixels, and at 200% browser zoom, the page has no
  unintended horizontal overflow and every terminal review action remains
  reachable.
- Themes may change palette but not component geometry, semantics, focus
  visibility, or interaction order.
- Reduced-motion preferences remove nonessential movement. Pending work still
  remains visible through text, state, and live status rather than relying on a
  spinner or animation alone.

## Verification

Automated WCAG checks cover Home, Settings, the responsive Explorer, and Shared
dialogs. The geometry suite covers the supported responsive tiers, touch
targets, themes, modal focus, and 200% zoom. Automated checks do not replace
manual keyboard, screen-reader, contrast, and physical-device verification.

```bash
npm run test:a11y
npm run test:layout
```
