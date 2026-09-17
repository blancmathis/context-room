import { randomUUID } from 'node:crypto';
import { readNotebookJson, writeNotebookJson, withNotebookLock, notebookHash } from './notebook_io.mjs';
import { deviceError, DEVICE_PROTOCOL } from './device_authority.mjs';
import { createDeviceViews } from './device_views.mjs';

const PRESENCE_MS = 15_000, REQUEST_MS = 30_000;
const id = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) throw deviceError('device_navigation_id', 'A valid navigation identifier is required.', 400);
  return value;
};
const terminal = new Set(['applied', 'cancelled', 'superseded', 'expired', 'unavailable']);
const exactTarget = (left, right) => left && right && ['projectId', 'resourceId', 'path', 'locationRevision'].every(key => left[key] === right[key]);

/** Navigation receipts are separate from durable notebook edits and never accept a file. */
export function createDeviceNavigation({ stateRoot, serverId, inspectDevice, resolveTarget, now = Date.now }) {
  const epoch = randomUUID();
  const views = createDeviceViews({ resolveTarget, now });
  const prefix = deviceId => `navigation/${id(deviceId)}`;
  const commandPath = (deviceId, operationId) => `${prefix(deviceId)}/commands/${id(operationId)}.json`;
  function update(deviceId, authenticate, action) {
    return withNotebookLock(stateRoot, `${prefix(deviceId)}/control.lock`, () => {
      const device = authenticate();
      if (device.id !== deviceId) throw deviceError('device_navigation_scope', 'The navigation belongs to another device.');
      const state = readNotebookJson(stateRoot, `${prefix(deviceId)}/control.json`, { version: DEVICE_PROTOCOL, serverId, deviceId, presence: null, retiredSessions: [], currentId: null });
      if (state.version !== DEVICE_PROTOCOL || state.serverId !== serverId || state.deviceId !== deviceId || !Array.isArray(state.retiredSessions)) throw deviceError('device_navigation_storage', 'The retained navigation state requires recovery.', 409);
      let command = state.currentId ? readNotebookJson(stateRoot, commandPath(deviceId, state.currentId)) : null;
      if (state.currentId && !command) throw deviceError('device_navigation_storage', 'A retained navigation request is missing.', 409);
      if (command && !terminal.has(command.status) && (command.expiresAt <= now() || command.serverEpoch !== epoch)) {
        command = { ...command, status: 'expired', completedAt: now() };
        writeNotebookJson(stateRoot, commandPath(deviceId, command.operationId), command);
      }
      const result = action(state, device, command);
      writeNotebookJson(stateRoot, `${prefix(deviceId)}/control.json`, state);
      return result;
    });
  }
  function save(deviceId, command) { writeNotebookJson(stateRoot, commandPath(deviceId, command.operationId), command); return command; }
  function currentTarget(device, target) {
    const current = resolveTarget(device, target.projectId, target.resourceId);
    if (!exactTarget(target, current)) throw deviceError('device_navigation_target', 'The original notebook location changed.', 409);
    return current;
  }
  return {
    request({ deviceId, operationId, projectId, resourceId }) {
      id(operationId);
      return update(deviceId, () => inspectDevice(deviceId), (state, device, previous) => {
        const fingerprint = notebookHash({ deviceId, operationId, projectId, resourceId });
        const retained = readNotebookJson(stateRoot, commandPath(deviceId, operationId));
        if (retained) {
          if (retained.fingerprint !== fingerprint) throw deviceError('device_navigation_replay', 'This request identifier names another navigation.', 409);
          // Recover a completed request-file write followed by a failed control-pointer write.
          if (!terminal.has(retained.status) && state.currentId !== operationId) {
            if (retained.serverEpoch === epoch && retained.expiresAt > now() && retained.clientSessionId === state.presence?.clientSessionId
              && (!previous || terminal.has(previous.status) && previous.requestedAt <= retained.requestedAt)) state.currentId = operationId;
            else return save(deviceId, { ...retained, status: 'expired', completedAt: now() });
          }
          return { ...retained, replayed: true };
        }
        if (!state.presence || state.presence.serverEpoch !== epoch || state.presence.at + PRESENCE_MS <= now()) throw deviceError('device_navigation_offline', 'Open Context Room on the tablet before requesting this notebook.', 409);
        const target = resolveTarget(device, projectId, resourceId);
        if (previous && !terminal.has(previous.status)) save(deviceId, { ...previous, status: 'superseded', completedAt: now() });
        const command = save(deviceId, { protocolVersion: DEVICE_PROTOCOL, serverId, serverEpoch: epoch, deviceId,
          clientSessionId: state.presence.clientSessionId, operationId, fingerprint, action: 'open', target,
          status: 'requested', requestedAt: now(), expiresAt: now() + REQUEST_MS, accepted: false });
        state.currentId = operationId;
        return command;
      });
    },
    poll(deviceId, authenticate, { clientSessionId, busy = false, view } = {}) {
      id(clientSessionId);
      return update(deviceId, authenticate, (state, device, command) => {
        if (state.retiredSessions.includes(clientSessionId)) throw deviceError('device_navigation_session', 'This tablet session has been replaced. Reopen the application.', 409);
        if (state.presence && state.presence.clientSessionId !== clientSessionId) {
          state.retiredSessions = [...state.retiredSessions, state.presence.clientSessionId].slice(-64);
          if (command && !terminal.has(command.status)) command = save(deviceId, { ...command, status: 'cancelled', reason: 'session_changed', completedAt: now() });
        }
        state.presence = { clientSessionId, serverEpoch: epoch, at: now(), busy: Boolean(busy) };
        if (command && !terminal.has(command.status)) {
          try { currentTarget(device, command.target); }
          catch { command = save(deviceId, { ...command, status: 'unavailable', reason: 'target_changed', completedAt: now() }); }
        }
        return { protocolVersion: DEVICE_PROTOCOL, serverId, serverEpoch: epoch, deviceId, clientSessionId, serverTime: now(),
          ...(view ? { view: views.exchange(device, clientSessionId, 'device', view) } : {}),
          command: command && !terminal.has(command.status) ? command : null };
      });
    },
    receipt(deviceId, authenticate, body) {
      id(body.operationId); id(body.clientSessionId);
      if (!['applied', 'deferred', 'cancelled', 'unavailable'].includes(body.status)) throw deviceError('device_navigation_receipt', 'Unsupported navigation receipt.', 400);
      return update(deviceId, authenticate, (state, device, current) => {
        const command = readNotebookJson(stateRoot, commandPath(deviceId, body.operationId));
        if (!command || command.clientSessionId !== body.clientSessionId) throw deviceError('device_navigation_scope', 'The navigation receipt belongs to another request or session.');
        if (terminal.has(command.status)) {
          if (command.status === body.status && (body.status !== 'applied' || exactTarget(command.appliedTarget, body.target) && command.appliedTarget.sceneRevision === body.target?.sceneRevision)) return { ...command, replayed: true };
          throw deviceError('device_navigation_stale', 'This navigation is no longer active.', 409);
        }
        if (state.currentId !== command.operationId || current?.status === 'expired' || command.serverEpoch !== epoch || state.presence?.clientSessionId !== body.clientSessionId) throw deviceError('device_navigation_stale', 'This navigation is no longer active.', 409);
        if (body.status === 'applied') {
          const target = currentTarget(device, command.target);
          if (!exactTarget(command.target, body.target) || !Number.isSafeInteger(body.target.sceneRevision) || body.target.sceneRevision < command.target.sceneRevision || body.target.sceneRevision > target.sceneRevision) {
            throw deviceError('device_navigation_receipt', 'The tablet has not confirmed the requested notebook revision.', 409);
          }
        }
        return save(deviceId, { ...command, status: body.status,
          ...(body.status === 'applied' ? { appliedTarget: { ...command.target, sceneRevision: body.target.sceneRevision } } : {}),
          ...(terminal.has(body.status) ? { completedAt: now() } : { deferredAt: now() }), accepted: false });
      });
    },
    inspect(deviceId, operationId = '') {
      return update(deviceId, () => inspectDevice(deviceId), (state, _device, current) => {
        const command = operationId ? readNotebookJson(stateRoot, commandPath(deviceId, operationId)) : current;
        const online = Boolean(state.presence?.serverEpoch === epoch && state.presence.at + PRESENCE_MS > now());
        return { protocolVersion: DEVICE_PROTOCOL, serverId, deviceId, online, busy: online && state.presence.busy, command };
      });
    },
    view({ deviceId, projectId, ...body }) {
      return update(deviceId, () => inspectDevice(deviceId), (state, device) => {
        if (!state.presence || state.presence.serverEpoch !== epoch || state.presence.at + PRESENCE_MS <= now()) throw deviceError('device_navigation_offline', 'Open Context Room on the tablet before sharing a view.', 409);
        if (!device.grants.some(grant => grant.mode === 'owner' && grant.serverId === serverId || grant.projectId === projectId)) throw deviceError('device_view_scope', 'The view belongs to another project.');
        return views.exchange(device, state.presence.clientSessionId, 'owner', body, projectId);
      });
    },
  };
}
