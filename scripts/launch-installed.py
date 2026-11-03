#!/usr/bin/env python3
"""Reference launcher for the installed Context Room Hub (macOS launchd).

Copy to ~/.local/share/context-room/launch-installed.py and set BASE, NODE and
RUNTIME. Only this launcher's child is restarted when the LAN address changes.
Exit code: 0 only when this launcher itself received SIGTERM/SIGINT (an
intended stop, e.g. `launchctl bootout`). Any other end exits non-zero, so
launchd (KeepAlive = true) always restarts the Hub.
"""
import ipaddress, os, signal, subprocess, time
from pathlib import Path
BASE = Path.home() / '.local/share/context-room'
NODE = os.environ.get('CONTEXT_ROOM_LAUNCH_NODE') or '/usr/local/bin/node'
RUNTIME = BASE / 'releases/REVISION-p4319/runtime'
child = None
stopping = False
RESTART_EXIT = 75  # EX_TEMPFAIL: the Hub ended without a stop request

def exit_code(stopped, returncode):
    return 0 if stopped else (returncode or RESTART_EXIT)

def lan_address():
    if os.environ.get('CONTEXT_ROOM_LAUNCH_NO_LAN'):
        return None
    for interface in ('en0', 'en1'):
        try:
            result = subprocess.run(['/usr/sbin/ipconfig', 'getifaddr', interface], capture_output=True, text=True)
        except OSError:
            continue
        if result.returncode == 0:
            try:
                address = ipaddress.ip_address(result.stdout.strip())
                if address.version == 4 and address.is_private and not address.is_loopback and not address.is_link_local:
                    return str(address)
            except ValueError:
                pass
    return None

def stop_child():
    if child is not None and child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()

def stop_signal(signum, frame):
    global stopping
    stopping = True

def main():
    global child
    signal.signal(signal.SIGTERM, stop_signal)
    signal.signal(signal.SIGINT, stop_signal)
    try:
        bound = lan_address()
        while not stopping:
            args = [NODE, str(RUNTIME / 'bin/context-room.mjs'), 'hub', '--no-local', '--port', '4319']
            if bound:
                args += ['--device-host', bound, '--device-port', '4318',
                         '--device-browser-origin', 'https://macbook-pro.local:4320',
                         '--device-browser-cert', str(BASE / 'browser-tls/chain.pem'),
                         '--device-browser-key', str(BASE / 'browser-tls/server.key')]
            print(time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()) + ' Context Room: starting installed shared UI; LAN=' + str(bound), flush=True)
            child = subprocess.Popen(args, cwd=RUNTIME if RUNTIME.is_dir() else None)
            changed = False
            while not stopping and child.poll() is None:
                time.sleep(3)
                current = lan_address()
                if current != bound:
                    time.sleep(2)
                    if lan_address() == current:
                        bound = current
                        changed = True
                        stop_child()
                        break
            if not changed:
                break
    finally:
        stop_child()
    raise SystemExit(exit_code(stopping, child.returncode if child is not None else None))

if __name__ == '__main__':
    main()
