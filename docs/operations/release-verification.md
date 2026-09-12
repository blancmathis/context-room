---
context_room:
  id: operations.release.verification
  depends_on:
    - system.architecture
    - system.runtime-profiles
    - domains.documentation.truth-model
---

# Release Verification

## Summary

A Context Room release is ready only when its package, deterministic contracts, browser workflows, local authority boundary and documentation graph are verified against one exact commit.

## Defines

This document defines the release evidence required for package publication.

## Does not define

This document does not define feature behavior, CI implementation internals, versioning policy, or external production change approval.

## Release identity

Record:

- package version;
- tag;
- exact commit;
- commit date;
- root tree;
- supported Node versions;
- package archive digest;
- workflow run IDs and conclusions;
- external deployment receipt, when applicable.

A tag resolving to a commit is necessary but does not prove that tests passed.

## Package verification

The release receipt must include:

1. clean dependency installation;
2. package and lockfile version consistency;
3. the applicable dependency-audit result;
4. package privacy scan;
5. `npm pack --dry-run` manifest review;
6. CLI registry and schema consistency;
7. unit and contract tests on every supported Node version;
8. generated artifacts unchanged or deliberately regenerated;
9. exact package digest.

## Browser verification

Run the configured browser profiles and record each conclusion:

- Chromium desktop;
- narrow/mobile Chromium;
- Firefox;
- WebKit;
- accessibility;
- markup accessibility;
- layout contract;
- performance budgets;
- Settings rerender;
- proposal workflows;
- endurance or soak.

A suite present in CI is not a passing receipt. The exact workflow run must have a recorded conclusion.

## Local and optional integration verification

Verify rejected hosted profiles fail before reading or writing user state. Exercise real temporary Git repositories, local proposals without Git, direct-change recovery, exact binary correction, reader isolation and the disabled-by-default cleanup rule. Migration must retain original control bytes and recover interrupted completion.

For Lisière, distinguish an isolated companion contract test, a real local companion round trip and physical tablet drawing. A companion result is not proof of pen, screen or connectivity behavior on the BOOX device. Context Room's principal workflow must run when Lisière is absent.

## Documentation verification

Verify:

- one stable ID per canonical owner;
- no competing canonical responsibility;
- valid temporal layer;
- valid direct `depends_on` edges;
- no dependency cycle;
- required `Summary`, `Defines`, and `Does not define` sections;
- valid links and anchors;
- current owners do not use target or proposal material as current;
- every source/test/workflow reference exists;
- packaged documentation excludes retired stale projections;
- screenshots identify their owning document and captured baseline.

## Failure policy

Do not publish, deploy, or mark documentation verified when required evidence is missing.

Use these states:

- `passed`: the exact check ran successfully for the exact baseline;
- `failed`: the exact check ran and failed;
- `unknown`: no adequate exact-baseline evidence exists;
- `not_applicable`: the release does not include the relevant surface, with a recorded reason.

A configured workflow without a run receipt is `unknown`, never `passed`.

A failed or missing external deployment proof does not invalidate the built artifact, but it prevents claiming that production runs it.
