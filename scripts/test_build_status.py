"""Exercise tracker safeguards in a temporary repository, never real progress."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class TrackerChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'scripts').mkdir()
        (self.root / 'docs/development/contracts').mkdir(parents=True)
        shutil.copy(ROOT / 'scripts/build_status.py', self.root / 'scripts/build_status.py')
        for name in ('release-plan.json', 'backlog.json'):
            shutil.copy(ROOT / 'docs/development/contracts' / name, self.root / 'docs/development/contracts' / name)
        self.run_command('sync')

    def tearDown(self):
        self.temp.cleanup()

    def run_command(self, *args, success=True):
        result = subprocess.run([sys.executable, str(self.root / 'scripts/build_status.py'), *args], capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def test_evidence_and_release_guards(self):
        self.run_command('ticket', 'P00-01', 'done', success=False)
        self.run_command('ticket', 'P00-01', 'blocked', success=False)
        self.run_command('release', 'P00', '--evidence', 'test gate', success=False)
        for i in range(1, 11):
            self.run_command('ticket', f'P01-{i:02}', 'done', '--evidence', 'synthetic test result')
        self.run_command('release', 'P01', '--evidence', 'test gate', success=False)
        for i in range(1, 9):
            self.run_command('ticket', f'P00-{i:02}', 'done', '--evidence', 'synthetic test result')
        self.run_command('release', 'P00', '--evidence', 'synthetic release gate')
        self.run_command('ticket', 'P00-01', 'in_progress', success=False)
        self.run_command('release', 'P01', '--evidence', 'synthetic release gate')
        self.run_command('reopen', 'P00', '--note', 'test correction', success=False)
        self.run_command('reopen', 'P01', '--note', 'test correction')
        self.run_command('reopen', 'P00', '--note', 'test correction')
        self.run_command('ticket', 'P00-01', 'in_progress', '--note', 'correction')
        self.run_command('check')

    def test_sync_retains_work_and_detects_stale_view(self):
        self.run_command('ticket', 'P00-01', 'blocked', '--owner', 'Test owner', '--note', 'Test blocker')
        self.run_command('sync')
        state = json.loads((self.root / 'status/build-status.json').read_text())
        self.assertEqual(state['tickets']['P00-01']['owner'], 'Test owner')
        self.assertEqual(state['tickets']['P00-01']['status'], 'blocked')
        (self.root / 'status/build-status-view.json').write_text('{}')
        self.run_command('check', success=False)
        self.run_command('sync')
        self.run_command('check')


if __name__ == '__main__':
    unittest.main()
