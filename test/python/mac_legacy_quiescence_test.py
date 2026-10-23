"""Local adapter contracts with explicit subprocess results; never stops a service."""
from pathlib import Path
import os
import plistlib
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src'))
from mac_legacy_quiescence import original_agent, profile, stop_agent, verify_agent, no_open_files

NO_WAIT = lambda seconds: None


class QuiescenceContracts(unittest.TestCase):
    def test_macos_open_files_and_incomplete_visibility_are_distinct_and_both_refused(self):
        with tempfile.TemporaryDirectory() as base, patch('mac_legacy_quiescence.sys.platform', 'darwin'):
            def command(code, out='', err=''):
                return lambda argv: SimpleNamespace(returncode=code, stdout=out, stderr=err)
            self.assertTrue(no_open_files(base, command(1))['closedFilesVerified'])
            with self.assertRaisesRegex(ValueError, 'file is open'):
                no_open_files(base, command(0, 'p123\n'))
            for code, out, err in [(1, '', 'Permission denied'), (0, 'p123\n', 'Warning'), (2, '', '')]:
                with self.assertRaisesRegex(ValueError, 'incomplete process visibility'):
                    no_open_files(base, command(code, out, err))

    def test_linux_scan_skips_a_process_only_when_every_thread_has_exited(self):
        # The kernel makes an exited process's fd table root-owned. Its main thread can exit while another thread keeps files open.
        if os.getuid() == 0:
            self.skipTest('root reads a directory without permissions')
        pid = str(os.getpid() + 1)
        with tempfile.TemporaryDirectory() as base, patch('mac_legacy_quiescence.sys.platform', 'linux'):
            data = Path(base, 'data'); data.mkdir()
            def scan(name, states, open_file=False):
                proc = Path(base, name)
                for tid, state in enumerate(states, int(pid)):
                    stat = proc / pid / 'task' / str(tid) / 'stat'
                    stat.parent.mkdir(parents=True)
                    stat.write_bytes(f'{tid} (odd) name) {state} 1 1'.encode())
                fd = proc / pid / 'fd'; fd.mkdir()
                if open_file:
                    (fd / '3').symlink_to(data.resolve() / 'legacy.sqlite3')
                else:
                    fd.chmod(0)
                try:
                    return no_open_files(data, proc=proc)
                finally:
                    fd.chmod(0o700)
            self.assertTrue(scan('exited', 'Z')['closedFilesVerified'])
            with self.assertRaisesRegex(ValueError, f'Cannot inspect PID {pid}'):
                scan('main-thread-exited', 'ZS')
            with self.assertRaisesRegex(ValueError, 'file is open'):
                scan('running', 'S', open_file=True)

    def test_only_original_owned_plist_is_accepted(self):
        with tempfile.TemporaryDirectory() as base:
            home = Path(base).resolve(); source = home / '.local/share/lisiere/workspace'
            file = home / 'Library/LaunchAgents/fr.lisiere.companion.plist'; file.parent.mkdir(parents=True)
            body = {'Label': 'fr.lisiere.companion', 'ProgramArguments': ['/synthetic/python', '-m', 'lisiere.server']}
            file.write_bytes(plistlib.dumps(body)); file.chmod(0o600)
            with patch('mac_legacy_quiescence.account_home', return_value=home):
                identity = original_agent(file, source, home, {})
            self.assertEqual(len(identity['plistSha256']), 64)
            self.assertEqual((identity['label'], identity['module'], identity['synthetic']), ('fr.lisiere.companion', 'lisiere.server', False))
            with self.assertRaisesRegex(ValueError, 'account home'):
                original_agent(file, source, home, {})
            for changed in [{'Label': 'another.service'}, {'ProgramArguments': ['/bin/sh', '-c', 'anything']},
                            {'EnvironmentVariables': {'HOME': '/another-account'}}]:
                file.write_bytes(plistlib.dumps({**body, **changed}))
                with self.assertRaises(ValueError), patch('mac_legacy_quiescence.account_home', return_value=home):
                    original_agent(file, source, home, {})

    def test_stop_is_targeted_requires_durable_disable_and_checks_manual_processes(self):
        calls = []
        identity = {'label': 'fr.lisiere.companion', 'module': 'lisiere.server', 'plistSha256': 'a' * 64, 'uid': os.getuid()}
        state = {'loaded': True, 'disabled': False, 'manual': False}
        def command(argv):
            calls.append(argv)
            out, err, code = '', '', 0
            if argv[1] == 'disable': state['disabled'] = True
            elif argv[1] == 'bootout': state['loaded'] = False
            elif argv[1] == 'print' and not state['loaded']:
                code, err = 113, 'Could not find service "fr.lisiere.companion"'
            elif argv[1] == 'print-disabled': out = '"fr.lisiere.companion" => ' + str(state['disabled']).lower()
            elif argv[0] == '/bin/ps' and state['manual']: out = str(os.getuid()) + ' 444 python -m lisiere.server'
            return SimpleNamespace(returncode=code, stdout=out, stderr=err)
        with self.assertRaisesRegex(ValueError, 'changed after'):
            stop_agent(identity, 'b' * 64, command)
        self.assertEqual(calls, [])
        self.assertTrue(stop_agent(identity, 'a' * 64, command)['stopped'])
        self.assertFalse(any('kickstart' in call or 'bootstrap' in call or 'kill' in call for call in calls))
        state['manual'] = True
        with self.assertRaisesRegex(ValueError, 'manual'):
            verify_agent(identity, command, NO_WAIT)
        state['manual'], state['disabled'] = False, False
        with self.assertRaisesRegex(ValueError, 'unconfirmed'):
            verify_agent(identity, command, NO_WAIT)

    def test_status_errors_are_never_treated_as_absence(self):
        identity = {'label': 'fr.lisiere.companion', 'module': 'lisiere.server', 'plistSha256': 'a' * 64, 'uid': os.getuid()}
        def unknown(argv):
            return SimpleNamespace(returncode=0 if argv[1] == 'disable' else 1, stdout='', stderr='Permission denied')
        with self.assertRaisesRegex(ValueError, 'unknown'):
            stop_agent(identity, 'a' * 64, unknown)

    @unittest.skipUnless(sys.platform == 'darwin', 'the synthetic agent needs a macOS HOME under /private/tmp')
    def test_synthetic_profile_requires_private_tmp_home_and_strict_nonce(self):
        account = Path('/synthetic/account').resolve()
        with patch('mac_legacy_quiescence.account_home', return_value=account):
            with tempfile.TemporaryDirectory(dir='/private/tmp') as base:
                home = Path(base).resolve() / 'home'
                result = profile(home, {'CONTEXT_ROOM_SYNTHETIC_LEGACY_AGENT': 'abc123def456'})
                self.assertEqual(result, {'label': 'test.contextroom.synthetic-abc123def456',
                                          'module': 'contextroom_synthetic_abc123def456', 'synthetic': True})
                for nonce in ['short', 'UPPERCASE123', 'abc-123-def', 'a' * 33, '']:
                    with self.assertRaisesRegex(ValueError, 'nonce'):
                        profile(home, {'CONTEXT_ROOM_SYNTHETIC_LEGACY_AGENT': nonce})
            for home in [account, Path('/private/tmp'), Path('/Users/synthetic-elsewhere')]:
                with self.assertRaisesRegex(ValueError, 'temporary HOME'):
                    profile(home, {'CONTEXT_ROOM_SYNTHETIC_LEGACY_AGENT': 'abc123def456'})
        with patch.dict(os.environ, {'TMPDIR': '/synthetic/chosen-tmp'}), \
                patch('mac_legacy_quiescence.account_home', return_value=account):
            # $TMPDIR is chosen by the caller: it never widens the accepted roots.
            with self.assertRaisesRegex(ValueError, 'temporary HOME'):
                profile(Path('/synthetic/chosen-tmp/run/home'), {'CONTEXT_ROOM_SYNTHETIC_LEGACY_AGENT': 'abc123def456'})
            darwin = Path(os.confstr(65537)).resolve() if sys.platform == 'darwin' else None
            if darwin:
                self.assertTrue(profile(darwin / 'run/home', {'CONTEXT_ROOM_SYNTHETIC_LEGACY_AGENT': 'abc123def456'})['synthetic'])
        with tempfile.TemporaryDirectory(dir='/private/tmp') as base, \
                patch('mac_legacy_quiescence.account_home', return_value=Path(base).resolve()):
            with self.assertRaisesRegex(ValueError, 'temporary HOME'):
                profile(Path(base), {'CONTEXT_ROOM_SYNTHETIC_LEGACY_AGENT': 'abc123def456'})

    @unittest.skipUnless(sys.platform == 'darwin', 'the synthetic agent needs a macOS HOME under /private/tmp')
    def test_synthetic_profile_never_targets_the_original_label(self):
        with tempfile.TemporaryDirectory(dir='/private/tmp') as base:
            home = Path(base).resolve(); source = home / '.local/share/lisiere/workspace'
            agents = home / 'Library/LaunchAgents'; agents.mkdir(parents=True)
            env = {'CONTEXT_ROOM_SYNTHETIC_LEGACY_AGENT': 'abc123def456'}
            original = agents / 'fr.lisiere.companion.plist'
            original.write_bytes(plistlib.dumps({'Label': 'fr.lisiere.companion', 'ProgramArguments': ['/synthetic/python', '-m', 'lisiere.server']}))
            original.chmod(0o600)
            with self.assertRaisesRegex(ValueError, 'exact original'):
                original_agent(original, source, home, env)
            synthetic = agents / 'test.contextroom.synthetic-abc123def456.plist'
            for label, module in [('fr.lisiere.companion', 'contextroom_synthetic_abc123def456'),
                                  ('test.contextroom.synthetic-abc123def456', 'lisiere.server')]:
                synthetic.write_bytes(plistlib.dumps({'Label': label, 'ProgramArguments': ['/synthetic/python', '-m', module]}))
                synthetic.chmod(0o600)
                with self.assertRaisesRegex(ValueError, 'does not match'):
                    original_agent(synthetic, source, home, env)
            synthetic.write_bytes(plistlib.dumps({'Label': 'test.contextroom.synthetic-abc123def456',
                                                   'ProgramArguments': ['/synthetic/python', '-m', 'contextroom_synthetic_abc123def456']}))
            identity = original_agent(synthetic, source, home, env)
            self.assertEqual((identity['label'], identity['synthetic']), ('test.contextroom.synthetic-abc123def456', True))
            calls = []
            def command(argv):
                calls.append(argv)
                return SimpleNamespace(returncode=1, stdout='', stderr='Permission denied')
            with self.assertRaises(ValueError):
                stop_agent(identity, identity['plistSha256'], command)
            self.assertEqual(calls[0], ['/bin/launchctl', 'disable', 'gui/' + str(os.getuid()) + '/test.contextroom.synthetic-abc123def456'])
            self.assertFalse(any('fr.lisiere' in part for call in calls for part in call))

    def test_print_disabled_accepts_true_and_disabled_only(self):
        identity = {'label': 'fr.lisiere.companion', 'module': 'lisiere.server', 'plistSha256': 'a' * 64, 'uid': os.getuid()}
        for shown, accepted in [('true', True), ('disabled', True), ('false', False), ('enabled', False), ('disabledx', False)]:
            def command(argv, shown=shown):
                if argv[1] == 'print-disabled':
                    return SimpleNamespace(returncode=0, stdout='disabled services = {\n\t"fr.lisiere.companion" => ' + shown + '\n}', stderr='')
                if argv[1] == 'print':
                    return SimpleNamespace(returncode=113, stdout='', stderr='Could not find service "fr.lisiere.companion"')
                return SimpleNamespace(returncode=0, stdout='', stderr='')
            if accepted:
                self.assertTrue(verify_agent(identity, command, NO_WAIT)['disabled'])
            else:
                with self.assertRaisesRegex(ValueError, 'unconfirmed'):
                    verify_agent(identity, command, NO_WAIT)

    def test_verify_waits_boundedly_for_a_stopping_process(self):
        identity = {'label': 'fr.lisiere.companion', 'module': 'lisiere.server', 'plistSha256': 'a' * 64, 'uid': os.getuid()}
        state = {'ps': 0, 'stopsAfter': 3}
        def command(argv):
            if argv[1] == 'print-disabled':
                return SimpleNamespace(returncode=0, stdout='"fr.lisiere.companion" => disabled', stderr='')
            if argv[1] == 'print':
                return SimpleNamespace(returncode=113, stdout='', stderr='Could not find service')
            state['ps'] += 1
            out = str(os.getuid()) + ' 444 python -m lisiere.server' if state['ps'] <= state['stopsAfter'] else ''
            return SimpleNamespace(returncode=0, stdout=out, stderr='')
        sleeps = []
        self.assertTrue(verify_agent(identity, command, sleeps.append)['stopped'])
        self.assertEqual(sleeps, [0.5] * 3)
        state['ps'], state['stopsAfter'], sleeps[:] = 0, 1000, []
        with self.assertRaisesRegex(ValueError, 'still-stopping'):
            verify_agent(identity, command, sleeps.append)
        self.assertEqual(len(sleeps), 19)

    def test_verify_without_plist_reports_uninstalled_only_when_disabled_and_absent(self):
        with tempfile.TemporaryDirectory() as base:
            home = Path(base).resolve(); source = home / '.local/share/lisiere/workspace'
            plist = home / 'Library/LaunchAgents/fr.lisiere.companion.plist'
            with patch('mac_legacy_quiescence.account_home', return_value=home):
                with self.assertRaises(OSError):
                    original_agent(plist, source, home, {})
                identity = original_agent(plist, source, home, {}, allow_missing=True)
                with self.assertRaisesRegex(ValueError, 'custom legacy'):
                    original_agent(plist, home / 'elsewhere', home, {}, allow_missing=True)
            self.assertEqual((identity['uninstalled'], identity['plistSha256']), (True, None))
            with self.assertRaisesRegex(ValueError, 'changed after'):
                stop_agent(identity, None, lambda argv: self.fail('no launchctl call'))
            state = {'disabled': 'disabled', 'loaded': False}
            def command(argv):
                if argv[1] == 'print-disabled':
                    return SimpleNamespace(returncode=0, stdout='"fr.lisiere.companion" => ' + state['disabled'], stderr='')
                if argv[1] == 'print':
                    return SimpleNamespace(returncode=0, stdout='state = running', stderr='') if state['loaded'] \
                        else SimpleNamespace(returncode=113, stdout='', stderr='Could not find service')
                return SimpleNamespace(returncode=0, stdout='', stderr='')
            self.assertTrue(verify_agent(identity, command, NO_WAIT)['uninstalled'])
            state['disabled'] = 'enabled'
            with self.assertRaisesRegex(ValueError, 'unconfirmed'):
                verify_agent(identity, command, NO_WAIT)
            state['disabled'], state['loaded'] = 'disabled', True
            with self.assertRaisesRegex(ValueError, 'still loaded'):
                verify_agent(identity, command, NO_WAIT)


if __name__ == '__main__':
    unittest.main()
