import io
import os
import sys
import signal
import subprocess
import tempfile
import time
from pathlib import Path
from apk_inventory.mobile_ui import Budget
import unittest
from unittest.mock import patch
from apk_inventory.mobile_ui import MobileError
from apk_inventory.mobile_visual import _adb_png

class CaptureOwnershipTests(unittest.TestCase):
    def test_budget_expires_immediately_after_spawn_and_child_is_reaped(self):
        class Budget:
            def check(self): pass
            def timeout(self): raise MobileError('DURATION_BUDGET', 'partial')
        class Backend:
            executable='adb'
            device='fixture'
            budget=Budget()
        class Child:
            stdout=io.BytesIO()
            pid=12345
            killed=False
            waited=False
            def poll(self): return None
            def kill(self): self.killed=True
            def wait(self): self.waited=True
        child=Child()
        with patch('apk_inventory.mobile_visual.subprocess.Popen', return_value=child), patch('apk_inventory.mobile_visual.os.killpg'):
            with self.assertRaises(MobileError) as raised:
                _adb_png(Backend())
        self.assertEqual(raised.exception.code,'DURATION_BUDGET')
        self.assertTrue(child.killed)
        self.assertTrue(child.waited)
        self.assertTrue(child.stdout.closed)

    def test_timed_out_wrapper_and_child_are_both_stopped(self):
        with tempfile.TemporaryDirectory() as directory:
            wrapper=Path(directory)/'wrapper.py'
            pidfile=Path(directory)/'child.pid'
            wrapper.write_text('#!'+sys.executable+'\nimport subprocess,sys,time\nchild=subprocess.Popen([sys.executable,"-c","import time;time.sleep(30)"])\nopen('+repr(str(pidfile))+',"w").write(str(child.pid))\ntime.sleep(30)\n')
            wrapper.chmod(0o700)
            class Backend:
                executable=str(wrapper)
                device='fixture'
                budget=Budget({'maxDurationMs':10000})
            original_spawn=subprocess.Popen
            def started_wrapper(*args, **kwargs):
                child=original_spawn(*args, **kwargs)
                deadline=time.monotonic()+10
                while not pidfile.exists() and child.poll() is None and time.monotonic()<deadline:
                    time.sleep(.01)
                if not pidfile.exists():
                    try: os.killpg(child.pid,signal.SIGKILL)
                    except ProcessLookupError: pass
                    child.wait()
                    self.fail('wrapper did not create its child during startup')
                # The cleanup deadline begins only after this real child exists.
                # A slow interpreter launch must not masquerade as a leak.
                Backend.budget=Budget({'maxDurationMs':100})
                return child
            with patch('apk_inventory.mobile_visual.subprocess.Popen', side_effect=started_wrapper):
                with self.assertRaises(MobileError):
                    _adb_png(Backend())
            self.assertTrue(pidfile.exists())
            pid=int(pidfile.read_text())
            for _ in range(100):
                try:
                    os.kill(pid,0)
                except ProcessLookupError:
                    break
                state=subprocess.run(['ps','-o','stat=','-p',str(pid)],capture_output=True,text=True).stdout.strip()
                if not state or state.startswith('Z'):
                    break
                time.sleep(.02)
            else:
                self.fail('wrapper child remained alive after timeout')
