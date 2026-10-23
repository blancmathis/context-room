import { qrSvg } from '../qr_code.mjs';
import { notebookDownload } from './notebook-download.mjs';

const TOO_LONG = 'Too long for a QR code. Save the pairing file or copy the code.';
const toBase64Url = text => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** QR text: a browser link whose fragment carries the ticket (a fragment never reaches a server), or the raw ticket. */
export function pairingQrText(ticket) {
  const json = JSON.stringify(ticket);
  return ticket.browserUrl ? String(ticket.browserUrl).replace(/\/+$/, '') + '/#pair=' + toBase64Url(json) : json;
}
/** Ticket JSON text from a `#pair=` fragment, or null when the fragment carries none or is malformed. */
export function pairingTicketFromFragment(hash) {
  const match = /^#pair=([A-Za-z0-9_-]{1,12000})$/.exec(hash || '');
  if (!match) return null;
  try {
    const bytes = Uint8Array.from(atob(match[1].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? text : null;
  } catch { return null; }
}
/** QR code and "Save pairing file" button for a fresh ticket. */
export function pairingShareNodes(ticket, label) {
  const holder = document.createElement('div'); holder.className = 'pairing-qr'; holder.style.cssText = 'width:min(300px,100%);margin-block:12px;background:#fff';
  try { holder.innerHTML = qrSvg(pairingQrText(ticket), { label: 'QR code for ' + label }); holder.firstChild.style.cssText = 'display:block;width:100%;height:auto'; }
  catch (error) { if (error.code !== 'qr_too_long') throw error; const note = document.createElement('p'); note.textContent = TOO_LONG; holder.append(note); }
  const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Save pairing file';
  save.addEventListener('click', () => notebookDownload(JSON.stringify(ticket), 'context-room-pairing.json', 'application/json'));
  return [holder, save];
}
