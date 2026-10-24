import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync as spawnSyncProcess } from 'node:child_process';
import { readContextHubRuntime } from './context_hub.mjs';

const TAILSCALE_PATHS = ['/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const isLoopback = host => host === '::1' || /^127\./.test(host);

function findTailscale(searchPath) {
  const candidates = String(searchPath || '').split(path.delimiter).filter(folder => path.isAbsolute(folder)).map(folder => path.join(folder, 'tailscale'));
  return [...candidates, ...TAILSCALE_PATHS].find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } }) || null;
}

/** Read-only: `status --json` only, never `up`, `set` or a login. */
function inspectTailscale({ spawnSync, searchPath }) {
  const binary = findTailscale(searchPath);
  if (!binary) return { state: 'unavailable', running: false, addresses: [] };
  let result;
  try { result = spawnSync(binary, ['status', '--json'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return { state: 'unknown', running: false, addresses: [] }; }
  if (result?.error || typeof result?.stdout !== 'string') return { state: 'unknown', running: false, addresses: [] };
  try {
    const status = JSON.parse(result.stdout);
    const backend = typeof status.BackendState === 'string' ? status.BackendState : '';
    const addresses = (Array.isArray(status.TailscaleIPs) ? status.TailscaleIPs : []).filter(address => net.isIP(String(address))).slice(0, 8).map(String);
    return { state: backend ? backend.toLowerCase() : 'unknown', running: backend === 'Running', addresses };
  } catch { return { state: 'unknown', running: false, addresses: [] }; }
}

function localConnect({ host, port, timeout }) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = state => { socket.destroy(); resolve(state); };
    socket.setTimeout(timeout, () => done('timeout'));
    socket.once('connect', () => done('listening'));
    socket.once('error', error => done(error.code === 'ECONNREFUSED' ? 'refused' : 'timeout'));
  });
}

/** Read-only network diagnostics for the tablet link. Sends no packet to the tablet and
 * never starts a VPN: reachability from the tablet itself cannot be verified on the Mac. */
export async function inspectLocalNetwork(options = {}) {
  const interfaces = (options.interfaces || os.networkInterfaces)(), searchPath = options.searchPath ?? process.env.PATH;
  const own = new Set(), lan = [];
  for (const entries of Object.values(interfaces || {})) for (const entry of entries || []) {
    own.add(entry.address);
    if (entry.family === 'IPv4' && !entry.internal && PRIVATE_IPV4.test(entry.address)) lan.push(entry.address);
  }
  lan.sort();
  const tailscale = inspectTailscale({ spawnSync: options.spawnSync || spawnSyncProcess, searchPath });
  const runtime = 'runtime' in options ? options.runtime : readContextHubRuntime();
  const alive = options.isAlive || (pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } });
  const issues = [];
  const devices = { state: 'hub-stopped', url: null, listener: null, discovery: null, tabletReachabilityVerified: false };
  if (runtime && (!runtime.pid || alive(runtime.pid))) {
    if (!runtime.devices) devices.state = 'not-configured';
    else {
      const url = new URL(runtime.devices.url), host = url.hostname.replace(/^\[|\]$/g, '');
      devices.url = runtime.devices.url; devices.discovery = runtime.devices.discovery;
      if (isLoopback(host)) devices.state = 'loopback-only';
      else if (!own.has(host)) {
        devices.state = 'bound-address-missing';
        issues.push({ code: 'device-address-missing', action: `The tablet listener is bound to ${host}, which this Mac no longer has. Restart the Hub with the current LAN address (${lan[0] || 'none found'}).` });
      } else devices.state = 'bound';
      if (devices.state === 'bound') {
        devices.listener = await (options.connect || localConnect)({ host, port: Number(url.port), timeout: 1000 });
        if (devices.listener !== 'listening') issues.push({ code: 'device-listener-unreachable', action: `Nothing accepts connections on ${runtime.devices.url} from this Mac (${devices.listener}). Restart the Hub with --device-host.` });
      }
      if (runtime.devices.discovery === 'failed') issues.push({ code: 'device-discovery-failed', action: 'The Bonjour announcement stopped. The tablet keeps its saved address; restart the Hub to announce again.' });
    }
  }
  return { version: 1, localOnly: true, optional: true, lan: { addresses: lan }, tailscale: { ...tailscale, tabletAccessVerified: false },
    devices, remoteAccessVerified: false, issues };
}
