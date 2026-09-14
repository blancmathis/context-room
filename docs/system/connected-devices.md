---
context_room:
  id: system.connected-devices
  depends_on: [system.runtime-profiles, assurance.review.human-authority]
---

# Connected drawing devices

## Summary

Context Room can start an optional TLS listener for a native drawing client.
The Mac keeps the working notebook and its durable operation receipts. A
device receives access only to the exact notebooks chosen in the owner UI.
This implementation is the transport foundation of the Android convergence;
an installable Android client and full remote owner interface remain open.

## Defines

Device service activation, pairing and revocation, the drawing permission,
private identity storage and its relationship to existing notebook authority.

## Does not define

Human file decisions, native pen rendering, voice sessions, personal-device
installation or migration. See [human authority](../features/review-authority.md)
and the [active convergence](../lifecycle/changes/active/android-convergence/index.md).

## Activation and pairing

`context-room hub`, `start` and `setup` accept `--device-host` with an explicit
IP address on the Mac and optional `--device-port` (default 4318). Without the
host option, no device listener or credential directory is created. The owner
Hub continues to listen only on loopback. Wildcard addresses are rejected.
For an isolated local transport check:

```bash
context-room start --root . --device-host 127.0.0.1 --device-port 4318
```

For another physical device, use the Mac's reachable LAN address instead of
loopback. The device options apply to a new Hub process. An already-running
Hub is preserved and reports that these options were not applied.

In a working notebook, **Connect tablet** opens the owner pairing interface.
Choose a device name and create a code. The one-use code expires in two minutes
and includes the server URL, certificate fingerprint and exact notebook grant.
Closing the pairing sheet cancels an unused code. A paired device appears in
the same sheet and can be disconnected there.

The client must verify the SHA-256 fingerprint of the TLS leaf certificate
before sending the code or device credential. Pairing returns a new random
credential valid for 30 days. Revocation is checked on every authenticated
request and again after a body upload, before applying its changes.

## Authority and protocol

[Device protocol version 1](../../src/device_server.mjs) admits notebook
open/read, targeted edits, selective undo, embedded raster assets, receipts and
exports. Existing notebook validation, filesystem safety, object revisions and
idempotent operations remain authoritative. Device authors are assigned by
the server; request bodies cannot impersonate another author.

Grants bind a registered project ID, its physical directory identity and exact
relative notebook paths. Current owner folder permissions are checked again
on use. Moving or replacing the project invalidates the grant. There is no
separate device project catalog and no arbitrary proxy to the local owner API.

This drawing permission does not admit proposal submission, relocation,
freeze, acceptance/rejection, settings changes or agent endpoints. Browser
requests carrying Origin, Referer or Fetch Metadata are refused. The service
returns JSON and never renders a document or exposes a native HTML bridge.
Full remote owner authority requires the remaining, separate convergence work.

## Persistence and limits

[Device authority](../../src/device_authority.mjs) stores its identity below
the private Hub state directory, alongside the host workspace, in `devices/`.
`--device-state` can choose another private directory outside a project.
The directory must be owned by the current account and inaccessible to other
users. Files use mode 0600, atomic publication and cross-process locks.
Linked, replaced, malformed or incompatible storage fails closed.

Only credential hashes are retained. The self-signed TLS identity persists
across restarts, has a one-year certificate lifetime and requires explicit
renewal when expired. Creating it requires OpenSSL. No key, pairing code or
device token belongs in Git, exports, document content or logs.

The service bounds pairing attempts, request rates, connections, upload sizes
and concurrent upload memory. It retains at most 32 active devices and 128
device records. Record cleanup and certificate renewal UI remain follow-up
work; exceeding these limits fails explicitly.

## Verification

[Contract tests](../../test/devices.test.mjs) use real isolated HTTPS services,
verify a mismatched certificate pin is refused, exercise simultaneous Mac and
device edits, and restart the service before replaying a lost receipt. They
also check revocation during upload, expired credentials, replaced directories,
route and scope refusal, and the actual CLI launch.

[Browser tests](../../test/e2e/notebooks.spec.mjs) exercise owner pairing and
revocation in Chromium, Firefox and WebKit. Exact observations and the remaining
Android/physical-device gates are recorded in [convergence verification](../lifecycle/changes/active/android-convergence/verification.md).
