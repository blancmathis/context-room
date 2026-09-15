import { deviceError } from './device_authority.mjs';

const LEASE_MS = 5_000;
const exact = (a, b) => a && b && ['projectId', 'resourceId', 'path', 'locationRevision'].every(key => a[key] === b[key]);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
function bounds(value) {
  if (!Array.isArray(value) || value.length !== 4 || value.some((n, i) => !Number.isFinite(n) || (i < 2 ? Math.abs(n) > 1e7 : n < 1 || n > 1e6))) {
    throw deviceError('device_view_bounds', 'The visible notebook area is invalid.', 400);
  }
  return [...value];
}
function contains(actual, wanted) {
  const tolerance = Math.max(1, wanted[2], wanted[3]) * .001;
  return actual[0] <= wanted[0] + tolerance && actual[1] <= wanted[1] + tolerance
    && actual[0] + actual[2] >= wanted[0] + wanted[2] - tolerance
    && actual[1] + actual[3] >= wanted[1] + wanted[3] - tolerance;
}

/** Short-lived view exchange; never persisted as edits, review or navigation authority. */
export function createDeviceViews({ resolveTarget, now = Date.now }) {
  const channels = new Map();
  function exchange(device, nativeSessionId, role, input, projectId = '') {
    const mode = input?.mode || 'independent', sessionId = role === 'device' ? nativeSessionId : input?.sessionId;
    if (!identifier(sessionId) || !['independent', 'share', 'follow'].includes(mode) || !Number.isSafeInteger(input.sequence) || input.sequence < 0) {
      throw deviceError('device_view_request', 'A valid view session and sequence are required.', 400);
    }
    let channel = channels.get(device.id);
    if (!channel || channel.nativeSessionId !== nativeSessionId) {
      channel = { nativeSessionId, owner: null, device: null, retiredOwners: [] }; channels.set(device.id, channel);
    }
    if (role === 'owner' && input.nativeSessionId && input.nativeSessionId !== nativeSessionId) throw deviceError('device_view_session', 'The tablet session changed. Choose view sharing again.', 409);
    const previous = channel[role], peer = channel[role === 'owner' ? 'device' : 'owner'];
    if (role === 'owner' && previous?.sessionId !== sessionId) {
      if (channel.retiredOwners.includes(sessionId) || previous && previous.mode !== 'independent' && previous.at + LEASE_MS > now()) {
        throw deviceError('device_view_busy', 'Another notebook window controls this view session.', 409);
      }
      if (previous) channel.retiredOwners = [...channel.retiredOwners, previous.sessionId].slice(-64);
    }
    let target = null, viewport = null;
    if (mode !== 'independent') {
      const requested = input.target;
      if (!requested || projectId && requested.projectId !== projectId) throw deviceError('device_view_scope', 'The view belongs to another project.');
      target = resolveTarget(device, requested.projectId, requested.resourceId);
      if (!exact(target, requested)) throw deviceError('device_view_scope', 'The original notebook location changed.', 409);
      target = Object.fromEntries(['projectId', 'resourceId', 'path', 'locationRevision'].map(key => [key, target[key]]));
      if (mode === 'share') viewport = bounds(input.viewport);
    }
    const signature = JSON.stringify({ mode, target, viewport });
    if (previous?.sessionId === sessionId && (input.sequence < previous.sequence || input.sequence === previous.sequence && signature !== previous.signature)) {
      throw deviceError('device_view_replay', 'An older view cannot replace the current view.', 409);
    }
    const current = { sessionId, sequence: input.sequence, mode, target, viewport, signature, at: now(),
      receipt: previous?.sessionId === sessionId && previous.sequence === input.sequence ? previous.receipt : null };
    channel[role] = current;
    let frame = null;
    if (mode === 'follow' && peer?.mode === 'share' && peer.at + LEASE_MS > now() && exact(target, peer.target)) {
      const receipt = input.receipt;
      if (receipt && receipt.sessionId === peer.sessionId && receipt.sequence === peer.sequence && exact(receipt.target, peer.target)) {
        const displayed = bounds(receipt.viewport);
        if (!contains(displayed, peer.viewport)) throw deviceError('device_view_receipt', 'The rendered view does not contain the requested area.', 409);
        peer.receipt = { sessionId: peer.sessionId, sequence: peer.sequence, receiverSessionId: sessionId, receiverSequence: input.sequence,
          target: peer.target, viewport: displayed, displayedAt: now(), accepted: false };
      }
      frame = { sessionId: peer.sessionId, sequence: peer.sequence, target: peer.target, viewport: peer.viewport, expiresAt: peer.at + LEASE_MS };
    }
    return { nativeSessionId, serverTime: now(), frame,
      receipt: mode === 'share' && peer?.mode === 'follow' && peer.at + LEASE_MS > now() && exact(target, peer.target)
        && current.receipt?.receiverSessionId === peer.sessionId && current.receipt.receiverSequence === peer.sequence ? current.receipt : null };
  }
  return { exchange };
}
