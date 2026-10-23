"""Explicit local migration adapter. Never called by doctor or normal startup.

Inspect is read-only. Stop disables and unloads ONLY the validated original
companion launch agent. It never touches Codex, Desktop, pairings or Tailscale.

CONTEXT_ROOM_SYNTHETIC_LEGACY_AGENT=<nonce> only narrows the target to a
throwaway test.contextroom.synthetic-<nonce> agent under a temporary HOME. It can
never select the original label, plist or data directory.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import pwd
import re
import subprocess
import sys
import tempfile
import time

LABEL = 'fr.lisiere.companion'
MODULE = 'lisiere.server'
SYNTHETIC = 'CONTEXT_ROOM_SYNTHETIC_LEGACY_AGENT'


def account_home():
    return Path(pwd.getpwuid(os.getuid()).pw_dir).resolve()


def profile(home=None, environ=None):
    """The original profile needs the account HOME; the synthetic one refuses it."""
    home = (Path.home() if home is None else Path(home)).resolve()
    nonce = (os.environ if environ is None else environ).get(SYNTHETIC)
    if nonce is None:
        if home != account_home():
            raise ValueError('The original companion is supported only in this account home directory.')
        return {'label': LABEL, 'module': MODULE, 'synthetic': False}
    if not re.fullmatch(r'[a-z0-9]{8,32}', nonce):
        raise ValueError('The synthetic legacy agent nonce must be 8 to 32 lowercase letters or digits.')
    temporary = {Path('/private/tmp').resolve(), Path(tempfile.gettempdir()).resolve()}
    if home == account_home() or not any(home != base and home.is_relative_to(base) for base in temporary):
        raise ValueError('A synthetic legacy agent needs a temporary HOME, never the account home directory.')
    return {'label': 'test.contextroom.synthetic-' + nonce, 'module': 'contextroom_synthetic_' + nonce, 'synthetic': True}


def original_agent(plist, source, home=None, environ=None, allow_missing=False):
    target = profile(home, environ)
    home = Path.home() if home is None else Path(home)
    plist, source = Path(plist), Path(source)
    expected = home / 'Library/LaunchAgents' / (target['label'] + '.plist')
    if allow_missing and plist == expected and not os.path.lexists(plist) and source == home / '.local/share/lisiere/workspace':
        # After the launch agent definition is retired, verification still
        # requires a disabled, unloaded label and no companion process.
        return {**target, 'plistSha256': None, 'source': str(source), 'uid': os.getuid(), 'uninstalled': True}
    if plist != expected or plist.resolve() != plist or plist.is_symlink():
        raise ValueError('Select the exact original companion launch-agent plist in this account.')
    if source != home / '.local/share/lisiere/workspace':
        raise ValueError('This adapter does not guess a custom legacy data directory.')
    stat = plist.stat()
    if stat.st_uid != os.getuid() or stat.st_mode & 0o022 or stat.st_size > 65536:
        raise ValueError('The original launch agent is not a bounded owner-controlled file.')
    raw = plist.read_bytes()
    body = plistlib.loads(raw)
    arguments = body.get('ProgramArguments')
    if body.get('Label') != target['label'] or not isinstance(arguments, list) or len(arguments) != 3 or arguments[1:] != ['-m', target['module']]:
        raise ValueError('The original launch-agent program does not match the supported companion.')
    if not isinstance(arguments[0], str) or not Path(arguments[0]).is_absolute():
        raise ValueError('The original companion executable must be absolute.')
    environment = body.get('EnvironmentVariables', {})
    if any(key in environment for key in ('LISIERE_HOME', 'LISIERE_WORKSPACE', 'HOME')):
        raise ValueError('Custom legacy workspace overrides need explicit local inspection.')
    return {**target, 'plistSha256': hashlib.sha256(raw).hexdigest(), 'source': str(source), 'uid': os.getuid()}


def run(arguments):
    # launchd waits for ExitTimeOut (20 s by default) before SIGKILL on bootout.
    timeout = 30 if arguments[1:2] == ['bootout'] else 10
    return subprocess.run(arguments, capture_output=True, text=True, timeout=timeout)


def absent_service(result):
    return result.returncode != 0 and not result.stdout.strip() and 'Could not find service' in result.stderr


def stop_agent(identity, expected, command=run):
    if identity['plistSha256'] is None or identity['plistSha256'] != expected:
        raise ValueError('The original launch-agent definition changed after preview.')
    domain = 'gui/' + str(identity['uid'])
    target = domain + '/' + identity['label']
    disabled = command(['/bin/launchctl', 'disable', target])
    if disabled.returncode:
        raise ValueError('The original companion could not be disabled. No data was retired.')
    status = command(['/bin/launchctl', 'print', target])
    if status.returncode == 0:
        stopped = command(['/bin/launchctl', 'bootout', target])
        if stopped.returncode:
            raise ValueError('The original companion did not stop. No data was retired.')
    elif not absent_service(status):
        raise ValueError('The original companion status is unknown. No data was retired.')
    return verify_agent(identity, command)


def verify_agent(identity, command=run, sleep=time.sleep, attempts=20):
    """A stopping process gets a bounded wait (attempts x 0.5 s); then refusal."""
    domain = 'gui/' + str(identity['uid'])
    disabled = command(['/bin/launchctl', 'print-disabled', domain])
    # macOS 13+ prints "=> disabled"; older releases print "=> true".
    pattern = r'"' + re.escape(identity['label']) + r'"\s*=>\s*(?:true|disabled)\b'
    if disabled.returncode or not re.search(pattern, disabled.stdout):
        raise ValueError('Durable disabling of the original companion is unconfirmed.')
    module = re.escape(identity['module'])
    for attempt in range(attempts):
        status = command(['/bin/launchctl', 'print', domain + '/' + identity['label']])
        loaded = not absent_service(status)
        if loaded and status.returncode != 0:
            raise ValueError('The original companion is still loaded or its state is unknown.')
        processes = command(['/bin/ps', '-axo', 'uid=,pid=,command='])
        if processes.returncode:
            raise ValueError('The original companion process inventory is unavailable.')
        running = any(len(fields) == 3 and fields[0] == str(identity['uid']) and re.search(r'(?:^|\s)-m\s+' + module + r'(?:\s|$)', fields[2])
                      for fields in (line.strip().split(None, 2) for line in processes.stdout.splitlines()))
        if not loaded and not running:
            return {**identity, 'disabled': True, 'stopped': True, 'manualCompanionAbsent': True}
        if attempt + 1 < attempts:
            sleep(0.5)
    if loaded:
        raise ValueError('The original companion is still loaded or its state is unknown.')
    raise ValueError('A manual or still-stopping companion remains. No data was retired.')


def no_open_files(directory, command=run):
    """Require closed files, not merely the absence of an active SQL transaction."""
    directory = str(Path(directory).resolve(strict=True))
    if sys.platform == 'darwin':
        result = command(['/usr/sbin/lsof', '-F', 'p', '+D', directory])
        if result.returncode in (0, 1) and result.stdout.strip() and not result.stderr.strip():
            raise ValueError('An original file is open. Stop its writer before retiring the workspace.')
        if result.returncode not in (0, 1) or result.stdout.strip() or result.stderr.strip():
            raise ValueError('Open legacy files or incomplete process visibility prevent retirement.')
    elif sys.platform == 'linux':
        for process in Path('/proc').iterdir():
            if not process.name.isdigit() or int(process.name) == os.getpid():
                continue
            try:
                if process.stat().st_uid != os.getuid():
                    continue
                for descriptor in (process / 'fd').iterdir():
                    try:
                        target = os.readlink(descriptor)
                    except FileNotFoundError:
                        continue
                    if target == directory or target.startswith(directory + '/'):
                        raise ValueError('An original file is open. Stop its writer before retiring the workspace.')
            except FileNotFoundError:
                continue
            except PermissionError as error:
                raise ValueError('Process visibility is incomplete; retirement is refused. '
                                 f'Cannot inspect PID {process.name}: {error.filename} ({error.strerror}).') from error
    else:
        raise ValueError('This platform has no supported closed-file verification.')
    return {'closedFilesVerified': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('inspect', 'stop', 'verify', 'closed-files'))
    parser.add_argument('--source', required=True)
    parser.add_argument('--plist')
    parser.add_argument('--revision')
    args = parser.parse_args()
    try:
        if args.action == 'closed-files':
            result = no_open_files(args.source)
        else:
            if sys.platform != 'darwin':
                raise ValueError('Launch-agent inspection and shutdown require macOS; no fallback is attempted.')
            identity = original_agent(args.plist, args.source, allow_missing=args.action == 'verify')
            result = stop_agent(identity, args.revision) if args.action == 'stop' else verify_agent(identity) if args.action == 'verify' else identity
        print(json.dumps(result, sort_keys=True))
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
