export async function openOwnerDeviceSettings(request) {
  const state = await request('/api/devices');
  const make = (tag, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
  const button = (label, action) => { const node = make('button', label); node.type = 'button'; node.addEventListener('click', action); return node; };
  const sheet = make('dialog'); sheet.className = 'connected-devices-dialog'; sheet.setAttribute('aria-label', 'Connected devices');
  const message = make('p'); message.setAttribute('role', 'status');
  let ticket = null, closed = false;
  const post = (path, body) => request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  sheet.append(make('h2', 'Use Context Room on another device'));
  sheet.append(make('p', 'The complete owner interface includes your Hub, authorized folders, documents, settings and human reviews. The Mac stays connected and keeps the files.'));
  sheet.append(make('p', 'To connect only a drawing surface, open a notebook and choose Connect tablet.'));
  if (!state.enabled || !state.ownerAvailable) {
    sheet.append(make('p', 'Device connections are disabled. Start Context Room on the Mac with an explicit device address before pairing.'));
  } else if (window.ContextRoomNativeOwner) {
    sheet.append(make('p', 'Create new pairing codes from Context Room on the Mac.'));
  } else {
    const label = make('label', 'Device name'), input = make('input'); input.value = 'Owner tablet'; input.maxLength = 100; label.append(input);
    const choice = make('label'), checkbox = make('input'); checkbox.type = 'checkbox'; choice.append(checkbox, document.createTextNode(' Allow the complete owner interface, including human reviews and settings'));
    const result = make('div');
    const create = button('Create owner pairing code', async () => {
      create.disabled = true; message.textContent = '';
      try {
        if (ticket) await post('/api/devices/cancel-pairing', { pairingId: ticket.pairingId });
        ticket = await post('/api/devices/pair-owner', { mode: 'owner', label: input.value });
        if (closed) { await post('/api/devices/cancel-pairing', { pairingId: ticket.pairingId }); return; }
        const code = make('textarea'); code.readOnly = true; code.value = JSON.stringify(ticket); code.setAttribute('aria-label', 'One-use owner pairing code');
        result.replaceChildren(make('p', 'Paste this code in Context Room on the tablet within two minutes.'), code,
          button('Copy owner pairing code', () => navigator.clipboard.writeText(code.value).then(() => { message.textContent = 'Pairing code copied.'; }).catch(() => { code.select(); message.textContent = 'Select and copy the code.'; })));
      } catch (error) { message.textContent = error.message; }
      finally { create.disabled = !checkbox.checked; }
    });
    create.disabled = true;
    checkbox.addEventListener('change', () => { create.disabled = !checkbox.checked; });
    sheet.append(label, choice, create, result);
  }
  for (const device of (state.devices || []).filter(item => !item.revokedAt && item.grants.some(grant => grant.mode === 'owner'))) {
    const row = make('p', device.label + ' · Complete owner interface ');
    row.append(button('Disconnect ' + device.label, async () => {
      try { await post('/api/devices/revoke', { deviceId: device.id }); row.remove(); message.textContent = 'Device disconnected. Its unsent local work is retained on the tablet.'; }
      catch (error) { message.textContent = error.message; }
    })); sheet.append(row);
  }
  sheet.append(message, button('Close devices', () => sheet.close()));
  sheet.addEventListener('close', () => { closed = true; if (ticket) void post('/api/devices/cancel-pairing', { pairingId: ticket.pairingId }).catch(() => {}); sheet.remove(); }, { once: true });
  document.body.append(sheet); sheet.showModal();
}
