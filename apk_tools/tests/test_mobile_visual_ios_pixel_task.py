"""Real local Node/PNG IPC tests; never device, browser, capture or OCR."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import psutil
from apk_inventory import mobile_visual_ios as ios
from apk_inventory import mobile_visual_ios_keyboard as keyboard
from apk_inventory.mobile_ui import MobileError
from test_mobile_visual_ios_keyboard import session
from test_mobile_visual_ios_caret import CARET, CARET_PLAN, IMAGE_DEF, image, masks
from test_mobile_visual_ios_keys import KEY_PLAN, KeyHarness
from types import SimpleNamespace


def active(pid):
    try:
        return psutil.Process(pid).status()!=psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False


class PixelTaskTests(unittest.TestCase):
    def wrapper(self, directory, program):
        file=Path(directory)/'node-wrapper'
        file.write_text('#!'+sys.executable+'\n'+program)
        file.chmod(0o700)
        return str(file)

    def test_multiple_original_png_operations_share_one_child_and_original_values(self):
        with tempfile.TemporaryDirectory() as directory:
            current=session(directory,plan=CARET_PLAN);node=shutil.which('node');base=image(Path(directory)/'base.png');fade=image(Path(directory)/'fade.png',[114,144,246]);selected=masks(current.config['nativeVisualWorkflow'])
            expected=ios._masked(node,current,base,selected)
            expected_fade=ios._masked(node,current,fade,selected)
            with patch.object(ios.subprocess,'Popen',wraps=subprocess.Popen) as popen:
                with ios._pixel_task(node,current) as task:
                    self.assertEqual(task.fingerprint(base,selected),expected)
                    self.assertEqual(task.fingerprint(fade,selected),expected_fade)
                    self.assertTrue(keyboard._caret_equivalent(current,current.config['nativeVisualWorkflow'],IMAGE_DEF,base,fade,(100,200),selected,task=task))
                self.assertEqual(popen.call_count,1)
                self.assertIsNotNone(task.child.poll())

    def test_same_worker_rereads_changed_file_instead_of_reusing_a_cached_image(self):
        with tempfile.TemporaryDirectory() as directory:
            current=session(directory);base=image(Path(directory)/'base.png')
            with ios._pixel_task(shutil.which('node'),current) as task:
                first=task.fingerprint(base,[])
                image(Path(directory)/'base.png',[0,0,0])
                self.assertNotEqual(task.fingerprint(base,[]),first)

    def test_partial_worker_initialization_failure_reaps_the_spawned_child(self):
        with tempfile.TemporaryDirectory() as directory:
            current=session(directory);task=ios._pixel_task(shutil.which('node'),current)
            with patch.object(ios.os,'set_blocking',side_effect=OSError()),self.assertRaisesRegex(MobileError,'VISUAL_PIXELS_UNAVAILABLE'):
                with task:raise AssertionError('initialization must fail')
            self.assertIsNotNone(task.child.poll())

    def test_bad_json_overflow_dimensions_sha_bool_id_and_extra_output_are_not_hash_misses(self):
        bad=['x\n','x'*4097+'\n','{}\n',json.dumps({'id':True,'operation':'fingerprint','ok':True,'value':{'width':300,'height':600,'sha256':'a'*64}})+'\n',json.dumps({'id':1,'operation':'fingerprint','ok':1,'value':{'width':300,'height':600,'sha256':'a'*64}})+'\n',json.dumps({'id':1,'operation':'fingerprint','ok':True,'value':{'width':True,'height':600,'sha256':'a'*64}})+'\n',json.dumps({'id':1,'operation':'fingerprint','ok':True,'value':{'width':300,'height':600,'sha256':'A'*64}})+'\n',json.dumps({'id':1,'operation':'fingerprint','ok':True,'value':{'width':300,'height':600,'sha256':'a'*64}})+'\n\n']
        with tempfile.TemporaryDirectory() as directory:
            current=session(directory);base=image(Path(directory)/'base.png')
            for output in bad:
                node=self.wrapper(directory,'import sys\nsys.stdin.readline()\nsys.stdout.write('+repr(output)+')\nsys.stdout.flush()\n')
                with self.subTest(output=output[:80]),self.assertRaisesRegex(MobileError,'VISUAL_PIXELS_UNAVAILABLE'):
                    with ios._pixel_task(node,current) as task:task.fingerprint(base,[])
                self.assertIsNotNone(task.child.poll())

    def test_nonzero_exit_and_invalid_caret_preserve_stage_specific_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            current=session(directory,plan=CARET_PLAN);base=image(Path(directory)/'base.png')
            node=self.wrapper(directory,'import sys\nsys.stdin.readline()\nsys.exit(3)\n')
            for caret in (False,True):
                with self.subTest(caret=caret),self.assertRaisesRegex(MobileError,'VISUAL_CARET_UNAVAILABLE' if caret else 'VISUAL_PIXELS_UNAVAILABLE'):
                    with ios._pixel_task(node,current) as task:
                        if caret:keyboard._caret_equivalent(current,current.config['nativeVisualWorkflow'],IMAGE_DEF,base,base,(100,200),masks(current.config['nativeVisualWorkflow']),task=task)
                        else:task.fingerprint(base,[])
                self.assertIsNotNone(task.child.poll())

    def test_budget_checked_between_operations_before_the_second_request(self):
        with tempfile.TemporaryDirectory() as directory:
            current=session(directory);base=image(Path(directory)/'base.png');marker=Path(directory)/'requests'
            program='import json,sys\nfor line in sys.stdin:\n r=json.loads(line)\n open('+repr(str(marker))+',"a").write(str(r["id"])+"\\n")\n print(json.dumps({"id":r["id"],"operation":r["operation"],"ok":True,"value":{"width":300,"height":600,"sha256":"a"*64}}),flush=True)\n'
            node=self.wrapper(directory,program)
            class Budget:
                cancelled=False
                def check(self):
                    if self.cancelled:raise MobileError('CANCELLED','cancelled')
                def timeout(self):return 5
            current.budget=Budget()
            with self.assertRaisesRegex(MobileError,'CANCELLED'):
                with ios._pixel_task(node,current) as task:
                    task.fingerprint(base,[]);current.budget.cancelled=True;task.fingerprint(base,[])
            self.assertEqual(marker.read_text().splitlines(),['1'])
            self.assertIsNotNone(task.child.poll())

    def test_hanging_read_or_write_checks_budget_and_reaps_owned_process_group(self):
        for block_write in (False,True):
            with self.subTest(block_write=block_write),tempfile.TemporaryDirectory() as directory:
                current=session(directory);base=image(Path(directory)/'base.png');marker=Path(directory)/'pids.json'
                program='import json,os,subprocess,sys,time\nchild=subprocess.Popen([sys.executable,"-c","import time;time.sleep(30)"])\nopen('+repr(str(marker))+',"w").write(json.dumps([os.getpid(),child.pid]))\n'+('' if block_write else 'sys.stdin.readline()\n')+'time.sleep(30)\n'
                node=self.wrapper(directory,program);start=time.monotonic()
                class Budget:
                    def check(self):
                        if marker.exists() or time.monotonic()-start>2:raise MobileError('CANCELLED','cancelled')
                    def timeout(self):return 5
                current.budget=Budget()
                with self.assertRaisesRegex(MobileError,'CANCELLED'):
                    with ios._pixel_task(node,current) as task:
                        task.fingerprint({**base,'_imagePath':'/'+'x'*15000},[])
                self.assertLess(time.monotonic()-start,3)
                parent,child=json.loads(marker.read_text());self.assertIsNotNone(task.child.poll())
                deadline=time.monotonic()+1
                while time.monotonic()<deadline:
                    if not active(child):break
                    time.sleep(.01)
                self.assertFalse(active(child))

    def test_hanging_fingerprint_has_its_own_absolute_operation_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            current=session(directory);base=image(Path(directory)/'base.png')
            node=self.wrapper(directory,'import sys,time\nsys.stdin.readline()\ntime.sleep(30)\n')
            class Budget:
                def check(self): pass
                def timeout(self): return .15
            current.budget=Budget();started=time.monotonic()
            with self.assertRaisesRegex(MobileError,'VISUAL_PIXELS_UNAVAILABLE'):
                with ios._pixel_task(node,current) as task:task.fingerprint(base,[])
            self.assertLess(time.monotonic()-started,1)
            self.assertIsNotNone(task.child.poll())

    def test_invalid_caret_result_is_rejected_without_truthy_or_mode_coercion(self):
        for value in ({'width':True,'height':600,'equivalent':True,'mode':'exact','changedPixels':0},
                      {'width':300,'height':600,'equivalent':1,'mode':'caret','changedPixels':10},
                      {'width':300,'height':600,'equivalent':False,'mode':'caret','changedPixels':10},
                      {'width':300,'height':600,'equivalent':True,'mode':'caret','changedPixels':0}):
            with self.subTest(value=value),tempfile.TemporaryDirectory() as directory:
                current=session(directory,plan=CARET_PLAN);base=image(Path(directory)/'base.png')
                response=json.dumps({'id':1,'operation':'caret','ok':True,'value':value})+'\n'
                node=self.wrapper(directory,'import sys\nsys.stdin.readline()\nprint('+repr(response)+',end="",flush=True)\n')
                with self.assertRaisesRegex(MobileError,'VISUAL_CARET_UNAVAILABLE'):
                    with ios._pixel_task(node,current) as task:
                        keyboard._caret_equivalent(current,current.config['nativeVisualWorkflow'],IMAGE_DEF,base,base,(100,200),masks(current.config['nativeVisualWorkflow']),task=task)
                self.assertIsNotNone(task.child.poll())

    def test_worker_exception_terminates_before_another_frame_or_physical_key(self):
        with tempfile.TemporaryDirectory() as directory,KeyHarness(self,directory) as h:
            h.value='';calls=[];closed=[]
            class Task:
                def __enter__(self):return self
                def __exit__(self,*_):closed.append(True);return False
                def fingerprint(self,observation,masks):
                    calls.append(masks)
                    if len(calls)==3:raise MobileError('VISUAL_PIXELS_UNAVAILABLE')
                    return h.masked(None,h.session,observation,masks)
            with patch.object(ios,'_pixel_task',side_effect=lambda *_:Task()):
                with self.assertRaisesRegex(MobileError,'VISUAL_PIXELS_UNAVAILABLE'):h.run('a')
            self.assertEqual(len(calls),3);self.assertEqual(len(closed),2)
            self.assertEqual(h.physical,[]);self.assertEqual(h.session.budget.count,1)

    def test_keyboard_mismatch_short_circuits_global_caret_and_keeps_six_frame_limit(self):
        with tempfile.TemporaryDirectory() as directory,KeyHarness(self,directory,lateKeyboardOverlay=True) as h:
            h.value='';calls=[];closed=[]
            class Task:
                def __enter__(self):return self
                def __exit__(self,*_):closed.append(True);return False
                def fingerprint(self,observation,masks):
                    calls.append(masks);return h.masked(None,h.session,observation,masks)
                def caret(self,*_):raise AssertionError('K mismatch must not reach caret')
            with patch.object(ios,'_pixel_task',side_effect=lambda *_:Task()),self.assertRaisesRegex(MobileError,'VISUAL_FRAME_CHANGED'):
                h.run('a')
            self.assertEqual(len(closed),7)  # one expected scope plus six fresh scopes
            self.assertEqual(len(calls),8)  # two expected hashes plus six K-only hashes
            self.assertEqual(calls.count([h.definition['resultRegion']]),1)
            self.assertEqual(h.physical,[]);self.assertEqual(h.session.budget.count,1)

    def test_nominal_window_after_first_complete_mismatch_stops_before_next_candidate(self):
        from apk_inventory import mobile_visual_ios_keys as keys
        with tempfile.TemporaryDirectory() as directory,KeyHarness(self,directory,lateKeyboardOverlay=True) as h:
            h.value='';now=[0]
            # Controlled steps, independent of how many timing fields are read:
            # the first complete mismatch occurs at0; its existing pause then
            # crosses the unique candidate-admission window, before another IO.
            clock=SimpleNamespace(monotonic=lambda:now[0],sleep=lambda *_:now.__setitem__(0,2))
            with patch.object(keys,'time',clock),self.assertRaisesRegex(MobileError,'VISUAL_FRAME_CHANGED'):
                h.run('a')
            self.assertEqual(h.physical,[]);self.assertEqual(h.session.budget.count,1)
            # The legacy unchanged-image helper is mocked in this harness;
            # its only capture here is the rejected key freshness frame.
            self.assertEqual(len(h.captures),1)
            record,=list((h.session.output/'visual-private').glob('keyboard-key-sampling-*.json'))
            sampled=json.loads(record.read_text())
            self.assertEqual(sampled['firstMismatchAtMs'],0)
            self.assertEqual(sampled['stopReason'],'candidate_window_expired')

    def test_legal_result_followed_by_nonzero_exit_never_authorizes_caller(self):
        with tempfile.TemporaryDirectory() as directory:
            current=session(directory,plan=CARET_PLAN);base=image(Path(directory)/'base.png')
            for operation,value,error in [('fingerprint',{'width':300,'height':600,'sha256':'a'*64},'VISUAL_PIXELS_UNAVAILABLE'),('caret',{'width':300,'height':600,'equivalent':True,'mode':'exact','changedPixels':0},'VISUAL_CARET_UNAVAILABLE')]:
                response={'id':1,'operation':operation,'ok':True,'value':value}
                node=self.wrapper(directory,'import json,sys\nsys.stdin.readline()\nprint('+repr(json.dumps(response))+',flush=True)\nsys.exit(3)\n')
                authorized=False;response_seen=False
                with self.subTest(operation=operation),self.assertRaisesRegex(MobileError,error):
                    with ios._pixel_task(node,current) as task:
                        if operation=='fingerprint':task.fingerprint(base,[])
                        else:keyboard._caret_equivalent(current,current.config['nativeVisualWorkflow'],IMAGE_DEF,base,base,(100,200),masks(current.config['nativeVisualWorkflow']),task=task)
                        response_seen=True
                    authorized=True
                self.assertTrue(response_seen);self.assertFalse(authorized);self.assertEqual(task.child.returncode,3)

    def test_legal_result_then_open_stdout_or_inheriting_descendant_is_bounded_and_reaped(self):
        for mode in ('open','closed','descendant'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory() as directory:
                current=session(directory);base=image(Path(directory)/'base.png')
                response={'id':1,'operation':'fingerprint','ok':True,'value':{'width':300,'height':600,'sha256':'a'*64}}
                body='import json,os,subprocess,sys,time\nsys.stdin.readline()\nreply='+repr(response)+'\n'
                if mode=='descendant':body+='p=subprocess.Popen([sys.executable,"-c","import time;time.sleep(30)"])\nreply["value"]["sha256"]=format(p.pid,"064x")\n'
                body+='print(json.dumps(reply),flush=True)\n'
                if mode=='closed':body+='os.close(1)\n'
                if mode!='descendant':body+='time.sleep(30)\n'
                node=self.wrapper(directory,body)
                class Budget:
                    deadline=None
                    def check(self):
                        if self.deadline is not None and time.monotonic()>=self.deadline:raise MobileError('CANCELLED','cancelled')
                    def timeout(self):return 15 if self.deadline is None else max(.001,self.deadline-time.monotonic())
                current.budget=Budget();authorized=False;response_seen=False;pid=None
                with self.assertRaisesRegex(MobileError,'CANCELLED'):
                    with ios._pixel_task(node,current) as task:
                        digest=task.fingerprint(base,[])
                        response_seen=True
                        if mode=='descendant':pid=int(digest,16)
                        # Arm cancellation only after the fixture has proved a
                        # valid reply. This tests EOF/wait cleanup, independently
                        # of interpreter startup or a racy side-file marker.
                        started=time.monotonic();current.budget.deadline=started+.2
                    authorized=True
                self.assertTrue(response_seen);self.assertFalse(authorized);self.assertLess(time.monotonic()-started,1);self.assertIsNotNone(task.child.poll())
                if mode=='descendant':
                    self.assertIsNotNone(pid);deadline=time.monotonic()+1
                    while time.monotonic()<deadline:
                        if not active(pid):break
                        time.sleep(.01)
                    self.assertFalse(active(pid))

    def test_caret_reply_without_scope_exit_still_checks_overall_cancel_and_does_not_authorize(self):
        with tempfile.TemporaryDirectory() as directory:
            current=session(directory,plan=CARET_PLAN);base=image(Path(directory)/'base.png');marker=Path(directory)/'ready'
            response={'id':1,'operation':'caret','ok':True,'value':{'width':300,'height':600,'equivalent':True,'mode':'exact','changedPixels':0}}
            node=self.wrapper(directory,'import sys,time\nsys.stdin.readline()\nopen('+repr(str(marker))+',"w").write("ready")\nprint('+repr(json.dumps(response))+',flush=True)\ntime.sleep(30)\n')
            start=time.monotonic()
            class Budget:
                armed=None
                def check(self):
                    now=time.monotonic()
                    if marker.exists() and self.armed is None:self.armed=now
                    if self.armed is not None and now-self.armed>.1 or now-start>2:raise MobileError('CANCELLED','cancelled')
                def timeout(self):return 1
            current.budget=Budget();authorized=False
            with self.assertRaisesRegex(MobileError,'CANCELLED'):
                with ios._pixel_task(node,current) as task:
                    keyboard._caret_equivalent(current,current.config['nativeVisualWorkflow'],IMAGE_DEF,base,base,(100,200),masks(current.config['nativeVisualWorkflow']),task=task)
                authorized=True
            self.assertFalse(authorized);self.assertLess(time.monotonic()-start,3);self.assertIsNotNone(task.child.poll())

    def test_caret_is_last_only_after_keyboard_match_and_global_mismatch(self):
        with tempfile.TemporaryDirectory() as directory,KeyHarness(self,directory,plan={**KEY_PLAN,'caret':CARET}) as h:
            h.value='';scopes=[];events=[]
            class Task:
                def __init__(self):self.index=len(scopes);scopes.append(self)
                def __enter__(self):return self
                def __exit__(self,*_):return False
                def fingerprint(self,observation,masks):
                    global_mask=masks==[h.definition['resultRegion']]
                    events.append((self.index,'global' if global_mask else 'keyboard'))
                    if self.index and global_mask:return 'd'*64
                    return h.masked(None,h.session,observation,masks)
                def caret(self,before,after,options):
                    events.append((self.index,'caret'))
                    self.test_masks=options['masks']
                    return False
            with patch.object(ios,'_pixel_task',side_effect=lambda *_:Task()),self.assertRaisesRegex(MobileError,'VISUAL_FRAME_CHANGED'):
                h.run('a')
            self.assertEqual(events[:2],[(0,'global'),(0,'keyboard')])
            for index in range(1,7):
                self.assertEqual([kind for scope,kind in events if scope==index],['keyboard','global','caret'])
                self.assertEqual(scopes[index].test_masks,[h.definition['resultRegion']])
            self.assertEqual(h.physical,[]);self.assertEqual(h.session.budget.count,1)


if __name__=='__main__':unittest.main()
