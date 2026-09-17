let registrationPromise, registrationError, installPrompt, currentNotebook, displayStarted = false, displayStarting = false;
export function prepareWebApp() {
  const profile = document.documentElement.dataset.contextRoomRuntimeProfile;
  if (profile && profile !== 'local') return Promise.resolve(null);
  if (!globalThis.isSecureContext || !('serviceWorker' in navigator) || globalThis.ContextRoomNativeOwner) return Promise.resolve(null);
  return registrationPromise ||= navigator.serviceWorker.register('/service-worker.js', { scope: '/', updateViaCache: 'none' })
    .then(async registration => {
      await navigator.serviceWorker.ready;
      return registration;
    }).catch(error => { registrationError = error; registrationPromise = null; throw error; });
}
export async function showWebAppSettings() {
  if (!document.querySelector('link[data-web-app-style]')) {
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = '/assets/ui/web-app.css'; link.dataset.webAppStyle = ''; document.head.append(link);
  }
  const dialog = document.createElement('dialog'); dialog.className = 'web-app-dialog'; dialog.setAttribute('aria-label', 'Install and offline notebooks');
  const add = (tag, text) => { const el = document.createElement(tag); el.textContent = text; dialog.append(el); return el; };
  add('h2', 'Context Room on this device');
  const status = add('p', 'Preparing the application cache…'); status.setAttribute('role', 'status');
  add('p', 'Only the application is cached by the service worker. Working notebooks use the existing local journal. Hub, agent and review require the connected Mac.');
  const install = add('button', 'Install Context Room'); install.type = 'button'; install.disabled = !installPrompt;
  install.addEventListener('click', async () => {
    if (!installPrompt) return;
    await prepareWebApp(); await installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; install.disabled = true;
  });
  add('p', 'The browser’s Install app / Add to Home screen menu is also available when supported.');
  const protect = add('button', 'Request persistent local storage'); protect.type = 'button';
  protect.addEventListener('click', async () => {
    try { status.textContent = await navigator.storage?.persist?.() ? 'Persistent local storage granted. Keep exports as backups.' : 'The browser did not grant persistence. Keep recovery exports; clearing site data removes local-only work.'; }
    catch (error) { status.textContent = error.message; }
  });
  const check = add('button', 'Check application update'); check.type = 'button';
  const show = registration => {
    status.textContent = registration?.waiting ? 'Update ready. Finish saving, close ALL Context Room windows on this origin, then reopen. No forced reload; local gestures are retained.'
      : registration ? 'Application cached for offline reopening. Locally saved ink and confirmation by the Mac are separate states.'
      : 'This native workspace uses its pinned transport. Use a trusted HTTPS browser connection for PWA installation.';
  };
  check.addEventListener('click', async () => { try { const registration = await prepareWebApp(); await registration?.update(); show(registration); } catch (error) { status.textContent = 'Offline application not ready: ' + error.message; } });
  if (globalThis.ContextRoomNativeOwner) {
    for (const [label, action] of [['Connection settings', 'openConnectionSettings'], ['Recover legacy native journals', 'recoverLegacyNotebooks']]) {
      const control = add('button', label); control.type = 'button';
      control.addEventListener('click', async () => {
        const editor = currentNotebook;
        if (editor?.dialog.isConnected) { await editor.close(); if (editor.dialog.isConnected) return; }
        dialog.close(); await ContextRoomNativeOwner[action]?.();
      });
    }
  }
  add('h3', 'Notebooks saved on this device');
  const list = document.createElement('div'); dialog.append(list);
  add('p', 'Updates never clear notebook storage. Revocation blocks Mac requests, not recovery of bytes already saved on this device. Do not clear site data before exporting unsynchronized work.');
  const close = add('button', 'Close offline settings'); close.type = 'button'; close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove(), { once: true }); document.body.append(dialog); dialog.showModal();
  try { const { appendCachedNotebooks } = await import('./notebook-offline.mjs'); await appendCachedNotebooks(list); }
  catch (error) { list.textContent = error.message; }
  prepareWebApp().then(show).catch(error => { status.textContent = 'Offline application not ready: ' + error.message; });
  return dialog;
}
if (typeof window !== 'undefined' && window === window.top) {
  const display = async () => {
    if (displayStarted || displayStarting || !globalThis.ContextRoomNativeOwner?.navigation && !document.querySelector('meta[name="context-room-browser-device"]')?.content && !currentNotebook?.browserDeviceId) return;
    displayStarting = true;
    try { const { startDeviceDisplay } = await import('./device-display.mjs'); displayStarted = await startDeviceDisplay({ currentEditor: () => currentNotebook }); } catch { /* Offline ink remains independent; retry on reconnect. */ }
    finally { displayStarting = false; }
  };
  document.addEventListener('context-room-notebook-opened', event => { currentNotebook = event.detail; void display(); });
  document.addEventListener('context-room-notebook-closed', event => { if (currentNotebook?.dialog === event.detail.dialog) currentNotebook = null; });
  window.addEventListener('online', () => void display());
  void display();
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; });
  document.addEventListener('click', event => { if (event.target.closest('[data-web-app-settings]')) void showWebAppSettings(); });
  const start = () => { void prepareWebApp().catch(() => {}); };
  if (document.readyState === 'complete') start(); else window.addEventListener('load', start, { once: true });
}
