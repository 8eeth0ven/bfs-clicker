"""Local executable ADB protocol tests; no device, network, or OCR.

APK_INVENTORY_FIXTURE enables the existing signed-APK corpus branch. Other
cases use self-owned synthetic bytes and must not be read as install evidence.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch

from apk_inventory.mobile_ui import Budget, DeviceLease, MobileError, MobileSession
from apk_inventory.mobile_visual import capture_locked

APP = 'com.example.capture'
REMOTE = '/data/app/~~fixture/com.example.capture-fixture/base.apk'
PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7hoAAAAASUVORK5CYII='
TRIPLET = ['pm path', 'sha256sum', 'pm path']
EXPECTED = ['devices', *TRIPLET, 'foreground', 'screencap', 'foreground', *TRIPLET]

RUNNER = r'''#!_PYTHON_
import base64,hashlib,json,os,shlex,sys,time
from pathlib import Path
p=Path(_STATE_);s=json.loads(p.read_text());args=sys.argv[1:]
s['commands'].append(args);s['pids'].append(os.getpid())
def save():p.write_text(json.dumps(s))
if args==['devices','-l']:
 save();print('List of devices attached\n'+s['device']+'\t'+('offline' if s.get('offline') else 'device')+' product:fixture');sys.exit(0)
if args[:3]==['-s',s['device'],'exec-out']:
 assert args[3:]==['screencap','-p'];s['captured']+=1
 if s.get('postHashMismatch'):s['corrupt']=True
 if s.get('postUninstall'):s['paths']=[]
 if s.get('postForegroundChange'):s['app']='other.application'
 if s.get('postCancel'):s['cancelled']=True
 save();sys.stdout.buffer.write(base64.b64decode(s['png']));sys.exit(0)
assert args[:3]==['-s',s['device'],'shell'] and len(args)==4
a=shlex.split(args[3]);result=''
if a[:2]==['pm','path']:
 result='\n'.join('package:'+x for x in s['paths'])
elif a and a[0]=='sha256sum':
 if s.get('hashUnavailable'):save();sys.exit(127)
 save()
 if s.get('sleepHash'):time.sleep(1)
 data=Path(s['apk']).read_bytes()+(b'changed' if s.get('corrupt') else b'')
 result=hashlib.sha256(data).hexdigest()+'  '+a[1]
 if s.get('replaceDuringHash'):s['paths']=['/data/app/~~changed/com.example.capture-fixture/base.apk']
elif a[:2]==['dumpsys','activity']:
 result='mResumedActivity: ActivityRecord{abc u0 '+s['app']+'/.Main t1}'
else:raise RuntimeError('Unexpected local protocol command')
save();print(result)
'''

def categories(rows):
    import shlex
    out = []
    for args in rows:
        if args == ['devices', '-l']:
            out.append('devices')
        elif args[2] == 'exec-out':
            out.append('screencap')
        else:
            command = shlex.split(args[3])
            out.append('pm path' if command[:2] == ['pm', 'path'] else
                       'sha256sum' if command[0] == 'sha256sum' else 'foreground')
    return out


class CaptureFixture:
    def __init__(self, directory, **changes):
        self.root = Path(directory).resolve()
        self.path = self.root / 'state.json'
        provided = os.environ.get('APK_INVENTORY_FIXTURE')
        self.apk = Path(provided).resolve() if provided else self.root / 'synthetic-apk-bytes'
        if not provided:
            self.apk.write_bytes(b'self-owned protocol fixture, not a signed APK')
        self.sha = hashlib.sha256(self.apk.read_bytes()).hexdigest()
        self.executable = self.root / 'adb-runner'
        self.executable.write_text(RUNNER.replace('_PYTHON_', sys.executable).replace('_STATE_', repr(str(self.path))))
        self.executable.chmod(0o700)
        state = {'commands': [], 'pids': [], 'device': 'owned-capture-' + self.root.name,
                 'app': APP, 'paths': [REMOTE], 'apk': str(self.apk), 'png': PNG, 'captured': 0}
        state.update(changes)
        self.path.write_text(json.dumps(state))
        self.config = {'source': {'id': 'capture_fixture', 'kind': 'apk'},
                       'backend': {'type': 'adb', 'adb': str(self.executable), 'deviceId': state['device'], 'appId': APP},
                       'expectedArtifact': {'kind': 'apk', 'sha256': self.sha},
                       'limits': {'maxDurationMs': 10000}, 'actionAllowlist': []}
        self.session = MobileSession(self.config, self.root / 'session')

    def state(self):
        return json.loads(self.path.read_text())

    def update(self, **changes):
        state = self.state(); state.update(changes); self.path.write_text(json.dumps(state))

    def capture(self, name='capture', function=capture_locked):
        with DeviceLease(self.session.backend) as lease:
            return function(self.session, self.root / name, lease)

    def assert_reaped(self, test):
        for pid in self.state()['pids']:
            with test.assertRaises(ChildProcessError):
                os.waitpid(pid, os.WNOHANG)


class AdbCaptureIdentityTests(unittest.TestCase):
    def test_capture_keeps_final_pre_and_post_hash_proofs_without_older_duplicate(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = CaptureFixture(tmp)
            result = fixture.capture()
            self.assertEqual(categories(fixture.state()['commands']), EXPECTED)
            self.assertTrue(result['appArtifactVerified'])
            self.assertEqual(result['artifactVerification']['actualSha256'], fixture.sha)
            self.assertEqual(result['imageSha256'], hashlib.sha256(Path(result['imagePath']).read_bytes()).hexdigest())
            self.assertNotIn('/data/app/', json.dumps(result))
            self.assertEqual(fixture.session.budget.count, 0)
            fixture.assert_reaped(self)

    def test_identity_helper_makes_no_artifact_claim_and_does_not_preflight_ime(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = CaptureFixture(tmp)
            with patch('apk_inventory.android_unicode.preflight', side_effect=AssertionError('No input activation')):
                self.assertIsNone(fixture.session.backend._probe_identity())
            self.assertEqual(categories(fixture.state()['commands']), ['devices'])
            self.assertNotEqual(fixture.session.backend.artifact_verification['status'], 'verified')
            fixture.assert_reaped(self)

    def test_default_probe_still_verifies_and_preflights_opt_in_unicode(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = CaptureFixture(tmp)
            fixture.session.backend.unicode_input = {'component': 'com.bfs.mcp.ime/.UnicodeIme', 'apkSha256': fixture.sha}
            with patch('apk_inventory.android_unicode.preflight') as preflight:
                result = fixture.session.backend.probe()
            preflight.assert_called_once_with(fixture.session.backend)
            self.assertEqual(categories(fixture.state()['commands']), ['devices', *TRIPLET])
            self.assertTrue(result['appArtifactVerified'])
            self.assertIn('type_unicode', result['features'])
            fixture.assert_reaped(self)

    def test_capture_never_requires_or_activates_configured_unicode_transport(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = CaptureFixture(tmp)
            selected = {'component': 'com.bfs.mcp.ime/.UnicodeIme', 'apkSha256': fixture.sha}
            fixture.session.backend.unicode_input = selected
            with patch('apk_inventory.android_unicode.preflight', side_effect=AssertionError('No input activation')):
                result = fixture.capture()
            self.assertIs(fixture.session.backend.unicode_input, selected)
            self.assertTrue(result['appArtifactVerified'])
            self.assertEqual(categories(fixture.state()['commands']), EXPECTED)

    def test_each_capture_repeats_both_proofs_and_changed_second_capture_rejects(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = CaptureFixture(tmp)
            fixture.capture('first'); fixture.capture('second')
            self.assertEqual(categories(fixture.state()['commands']), EXPECTED * 2)
            fixture.update(corrupt=True)
            with self.assertRaises(MobileError) as raised:
                fixture.capture('changed')
            self.assertEqual(raised.exception.code, 'APK_ARTIFACT_MISMATCH')
            self.assertEqual(fixture.state()['captured'], 2)
            self.assertFalse((fixture.root / 'changed/screenshot.png').exists())
            fixture.assert_reaped(self)

    def test_no_expected_artifact_does_not_become_verified(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = CaptureFixture(tmp)
            fixture.session.backend.expected_artifact = None
            result = fixture.capture()
            self.assertFalse(result['appArtifactVerified'])
            self.assertIn('app_artifact_not_verified', result['gaps'])
            self.assertEqual(categories(fixture.state()['commands']), ['devices', 'foreground', 'screencap', 'foreground'])

    def test_pre_capture_failures_never_capture_or_dispatch(self):
        cases = [('missing', {'paths': []}, 'APK_ARTIFACT_UNVERIFIED'),
                 ('split', {'paths': [REMOTE, '/data/app/fixture/split.apk']}, 'APK_ARTIFACT_UNVERIFIED'),
                 ('hash', {'corrupt': True}, 'APK_ARTIFACT_MISMATCH'),
                 ('changed_path', {'replaceDuringHash': True}, 'APK_ARTIFACT_UNVERIFIED'),
                 ('unavailable', {'hashUnavailable': True}, 'APK_ARTIFACT_UNVERIFIED'),
                 ('foreground', {'app': 'other.application'}, 'APP_OUT_OF_SCOPE'),
                 ('offline', {'offline': True}, 'DEVICE_NOT_AUTHORIZED_OR_OFFLINE')]
        for name, change, code in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                fixture = CaptureFixture(tmp, **change)
                with self.assertRaises(MobileError) as raised:
                    fixture.capture()
                self.assertEqual(raised.exception.code, code)
                self.assertEqual(fixture.state()['captured'], 0)
                self.assertFalse((fixture.root / 'capture/screenshot.png').exists())
                fixture.assert_reaped(self)

    def test_post_capture_changes_reject_without_publishing_capture(self):
        cases = [({'postHashMismatch': True}, 'APK_ARTIFACT_MISMATCH'),
                 ({'postUninstall': True}, 'APK_ARTIFACT_UNVERIFIED'),
                 ({'postForegroundChange': True}, 'APP_OUT_OF_SCOPE')]
        for change, code in cases:
            with self.subTest(change=change), tempfile.TemporaryDirectory() as tmp:
                fixture = CaptureFixture(tmp, **change)
                with self.assertRaises(MobileError) as raised:
                    fixture.capture()
                self.assertEqual(raised.exception.code, code)
                self.assertEqual(fixture.state()['captured'], 1)
                self.assertFalse((fixture.root / 'capture/screenshot.png').exists())
                fixture.assert_reaped(self)

    def test_hash_timeout_reaps_command_and_does_not_retry_or_capture(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = CaptureFixture(tmp, sleepHash=True)
            class ShortHashBudget(Budget):
                def timeout(self, maximum=15.):
                    self.check()
                    return .05 if len(fixture.state()['commands']) >= 2 else 5.
            fixture.session.budget = fixture.session.backend.budget = ShortHashBudget({'maxDurationMs': 10000})
            with self.assertRaises(MobileError) as raised:
                fixture.capture()
            self.assertEqual(raised.exception.code, 'APK_ARTIFACT_UNVERIFIED')
            self.assertEqual(categories(fixture.state()['commands']), ['devices', 'pm path', 'sha256sum'])
            self.assertEqual(fixture.state()['captured'], 0)
            self.assertFalse((fixture.root / 'capture/screenshot.png').exists())
            fixture.assert_reaped(self)

    def test_cancellation_before_or_during_capture_never_publishes(self):
        for post in [False, True]:
            with self.subTest(post=post), tempfile.TemporaryDirectory() as tmp:
                fixture = CaptureFixture(tmp, postCancel=post)
                class CancellableBudget(Budget):
                    def check(self):
                        if fixture.state().get('cancelled'):
                            raise MobileError('STOPPED', 'partial')
                        super().check()
                fixture.session.budget = fixture.session.backend.budget = CancellableBudget({'maxDurationMs': 10000})
                if not post:
                    fixture.update(cancelled=True)
                with self.assertRaises(MobileError) as raised:
                    fixture.capture()
                self.assertEqual(raised.exception.code, 'STOPPED')
                self.assertFalse((fixture.root / 'capture/screenshot.png').exists())
                self.assertEqual(fixture.session.budget.count, 0)
                fixture.assert_reaped(self)

    @unittest.skipUnless(os.environ.get('APK_INVENTORY_FIXTURE'), 'Requires existing signed APK fixture')
    def test_real_compiled_signed_fixture_bytes_are_the_exact_reported_artifact(self):
        apk = Path(os.environ['APK_INVENTORY_FIXTURE'])
        data = apk.read_bytes()
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            self.assertFalse(archive.read('AndroidManifest.xml').lstrip().startswith(b'<'))
            self.assertTrue(archive.read('classes.dex').startswith(b'dex\n'))
            signature = b'APK Sig Block 42' in data or any(name.startswith('META-INF/') and name.endswith(('.RSA', '.DSA', '.EC')) for name in archive.namelist())
            self.assertTrue(signature, 'Existing corpus must contain APK signing structure')
        with tempfile.TemporaryDirectory() as tmp:
            fixture = CaptureFixture(tmp)
            result = fixture.capture()
            self.assertEqual(result['artifactVerification']['expectedSha256'], hashlib.sha256(data).hexdigest())
            self.assertEqual(result['artifactVerification']['actualSha256'], hashlib.sha256(data).hexdigest())
            self.assertEqual(categories(fixture.state()['commands']), EXPECTED)
            fixture.assert_reaped(self)


if __name__ == '__main__':
    unittest.main()
