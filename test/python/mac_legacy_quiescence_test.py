"""Local adapter contracts with explicit subprocess results; never stops a service."""
from pathlib import Path
import os
import plistlib
import sys
import tempfile
import unittest
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src'))
from mac_legacy_quiescence import original_agent, stop_agent, verify_agent


class QuiescenceContracts(unittest.TestCase):
    def test_only_original_owned_plist_is_accepted(self):
        with tempfile.TemporaryDirectory() as base:
            home = Path(base).resolve(); source = home / '.local/share/lisiere/workspace'
            file = home / 'Library/LaunchAgents/fr.lisiere.companion.plist'; file.parent.mkdir(parents=True)
            body = {'Label': 'fr.lisiere.companion', 'ProgramArguments': ['/synthetic/python', '-m', 'lisiere.server']}
            file.write_bytes(plistlib.dumps(body)); file.chmod(0o600)
            identity = original_agent(file, source, home)
            self.assertEqual(len(identity['plistSha256']), 64)
            for changed in [{'Label': 'another.service'}, {'ProgramArguments': ['/bin/sh', '-c', 'anything']},
                            {'EnvironmentVariables': {'HOME': '/another-account'}}]:
                file.write_bytes(plistlib.dumps({**body, **changed}))
                with self.assertRaises(ValueError):
                    original_agent(file, source, home)

    def test_stop_is_targeted_requires_durable_disable_and_checks_manual_processes(self):
        calls = []
        identity = {'label': 'fr.lisiere.companion', 'plistSha256': 'a' * 64, 'uid': os.getuid()}
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
            verify_agent(identity, command)
        state['manual'], state['disabled'] = False, False
        with self.assertRaisesRegex(ValueError, 'unconfirmed'):
            verify_agent(identity, command)

    def test_status_errors_are_never_treated_as_absence(self):
        identity = {'label': 'fr.lisiere.companion', 'plistSha256': 'a' * 64, 'uid': os.getuid()}
        def unknown(argv):
            return SimpleNamespace(returncode=0 if argv[1] == 'disable' else 1, stdout='', stderr='Permission denied')
        with self.assertRaisesRegex(ValueError, 'unknown'):
            stop_agent(identity, 'a' * 64, unknown)


if __name__ == '__main__':
    unittest.main()
