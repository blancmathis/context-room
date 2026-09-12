---
context_room:
  id: assurance.hosted.isolation
  depends_on:
    - system.runtime-profiles
---

# Retired hosted isolation

## Summary

The hosted runtime was retired by the local-first refactor. The remote executable, image and deployment workflow are no longer part of the active package. Older deployment instructions must not be used for this branch.

## Defines

This page preserves inbound links to the retired surface.

## Does not define

It provides no current hosting or release procedure. See [Runtime profiles](../system/runtime-profiles.md), [Release verification](../operations/release-verification.md), and the [refactor dossier](../lifecycle/changes/active/refactor/index.md).

The previous implementation remains recoverable from Git history at the pre-refactor base `5a2bcab`.
