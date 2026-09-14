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
