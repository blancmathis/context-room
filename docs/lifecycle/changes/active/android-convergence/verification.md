# Android convergence verification

## Summary

Incremental, synthetic evidence for the working convergence branch. This is not a claim that the complete Android/tablet product is delivered.

## Defines

The verification state of added notebook gesture, rendering and cache behavior. The existing refactor requirements remain the regression contract.

## Does not define

Human acceptance of real documents, installation on a device, provider authentication, physical stylus measurements, or publication approval.

## Continuous gestures and exact undo

On Node 22.16.0 / Linux, with `umask 022`:

```
node --test test/notebook*.test.mjs test/local_proposals.test.mjs test/document_assets.test.mjs
```

Result: 48 tests passed, zero failures or skips. Added cases cover samples persisted before pen-up, segmented strokes, disk-failure recovery suffixes, restart-safe grouped undo/redo, independent agent objects, exact stale-object refusal, explicit lock undo, simultaneous browser identity initialization, and pressure geometry/origin in inert SVG export.

`npm run package:privacy`: passed (104 packaged files at this checkpoint). `git diff --check`: passed.

The browser editor, device transport and Android application are not proved by these model tests. Full-suite, rendered-interface, native build, authenticated agent/audio and physical-device evidence must be recorded separately.

## Folder and review surfaces

The continuation includes a folder-scoped notebook chooser, a retained drawing
canvas, persisted pressure samples, selection/lasso, shapes, connectors, text,
embedded raster images, locking, targeted undo/redo, exports and a frozen
notebook correction surface in the existing human file review. The normal
proposal reader and per-file decision endpoints remain the owners of acceptance.
The working scene is explicitly labelled as unaccepted. No separate notes
catalogue, Inbox, hosted profile or agent review authority was added.

Node 22.16.0 with umask 022: `node --test test/notebook*.test.mjs
test/local_proposals.test.mjs test/document_assets.test.mjs` passes 53 tests.
`npm run package:privacy` passes with 111 package files. `git diff --check` passes.
Portable canvas tests use synthetic event/graphics contracts; they are not a
browser rendering, stylus latency or physical palm-rejection result.

Three real-server Chromium scenarios are in `test/e2e/notebooks.spec.mjs`.
Their attempted execution was blocked at navigation with
`net::ERR_BLOCKED_BY_ADMINISTRATOR`. No browser policy was changed, assertion
relaxed, or alternate route used to evade that restriction. Their visual,
accessibility and end-to-end assertions therefore remain unverified in this
session. Run them in the repository's authorized browser matrix before treating
these surfaces as finished. The existing CI browser and Node matrix is retained.
