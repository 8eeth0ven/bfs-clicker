"""Explicit owner geometry, no device/capture/OCR or runtime authority by hash."""
import copy
import hashlib
import json
from pathlib import Path
import string
import tempfile
import unittest
from types import SimpleNamespace

from apk_inventory import mobile_visual_ios_keyboard as keyboard
from apk_inventory import mobile_visual_ios_keys as keys
from apk_inventory.mobile_ui import MobileError, digest
from test_mobile_visual_ios_keyboard import DEF as BASE_DEF
from test_mobile_visual_ios_keys import INPUT, KeyHarness

APP = 'com.example.bfsmcp.iosvisualkeyboard'
DEF = {**BASE_DEF, 'valueRegion': {'x': .05, 'y': .2, 'width': .9, 'height': .08},
       'resultRegion': {'x': .05, 'y': .47, 'width': .9, 'height': .12}}
GEOMETRY = (402, 874)
OBS = {'width': 1206, 'height': 2622}
REGION = {'x': 0, 'y': 572 / 874, 'width': 1, 'height': 302 / 874}
SOURCE = {'x': 0, 'y': 590 / 874, 'width': 1, 'height': 226 / 874}


def plan():
    evidence = {'schemaVersion': 1, 'mode': 'owner_approved_split', 'authority': 'local_config',
                'appId': APP, 'window': {'width': 402, 'height': 874}, 'image': OBS.copy(),
                'keyPlane': {'x': 0, 'y': 590, 'width': 402, 'height': 226},
                'visualEnvelope': {'x': 0, 'y': 572, 'width': 402, 'height': 302},
                'calibration': {'kind': 'owner_inspected_source_and_frame_pair',
                    **{k: hashlib.sha256(k.encode()).hexdigest() for k in
                       ('beforeImageSha256', 'visibleImageSha256', 'visibleSourceSha256')}}}
    return {'enabled': True, 'region': REGION.copy(), 'sourceRegion': SOURCE.copy(),
            'dismissAnchor': 'Dismiss', 'keyInput': copy.deepcopy(INPUT), 'geometryEvidence': evidence}


def source(y=590, extra=''):
    rows = []
    for i, char in enumerate(string.ascii_lowercase):
        rows.append(f'<Key type="XCUIElementTypeKey" name="{char}" label="{char}" visible="true" enabled="true" x="{5+(i%10)*39}" y="{600+(i//10)*54}" width="30" height="45"/>')
    for name, x in [('shift', 2), ('numbers', 50), ('delete', 100)]:
        c = INPUT['controls'][name]
        rows.append(f'<Key type="{c["type"]}" name="{c["name"]}" label="{c["label"]}" visible="true" enabled="true" x="{x}" y="760" width="35" height="40"/>')
    return f'<AppiumAUT><Application type="XCUIElementTypeApplication" bundleId="{APP}"><Keyboard type="XCUIElementTypeKeyboard" visible="true" x="0" y="{y}" width="402" height="226">{"".join(rows)}</Keyboard>{extra}</Application></AppiumAUT>'


def session(raw, app=APP):
    actions = []
    backend = SimpleNamespace(app_id=app, foreground=lambda: None,
        request=lambda method, route: raw if (method, route) == ('GET', '/source') else actions.append(route))
    return SimpleNamespace(backend=backend, budget=SimpleNamespace(check=lambda: None)), actions


class SplitGeometryTests(unittest.TestCase):
    def test_legacy_remains_red_but_exact_local_split_is_valid(self):
        p = plan()
        with self.assertRaises(MobileError):
            keyboard.keyboard_contract({k: v for k, v in p.items() if k != 'geometryEvidence'}, DEF)
        self.assertIs(keyboard.keyboard_contract(p, DEF), p)
        s, actions = session(source())
        self.assertEqual(keyboard.keyboard_state(s, p, OBS, GEOMETRY, True), SOURCE)
        self.assertEqual(actions, [])

    def test_exact_schema_bounds_provenance_and_both_rois(self):
        cases = []
        for key, value in [('schemaVersion', True), ('authority', 'mcp_request'), ('mode', 'auto_parent'),
                           ('appId', 'bad app'), ('surprise', True)]:
            p = plan(); p['geometryEvidence'][key] = value; cases.append(p)
        for group, key, value in [('window', 'width', True), ('image', 'height', 2621),
                                  ('keyPlane', 'height', 300), ('visualEnvelope', 'y', 400),
                                  ('visualEnvelope', 'height', 303), ('keyPlane', 'x', 1)]:
            p = plan(); p['geometryEvidence'][group][key] = value; cases.append(p)
        p = plan(); p['region']['y'] += .00001; cases.append(p)
        p = plan(); p['sourceRegion']['height'] -= .00001; cases.append(p)
        for value in ['0'*64, 'REPLACE_WITH_SHA', 'A'*64]:
            p = plan(); p['geometryEvidence']['calibration']['visibleSourceSha256'] = value; cases.append(p)
        p = plan(); p['geometryEvidence']['calibration']['beforeImageSha256'] = p['geometryEvidence']['calibration']['visibleImageSha256']; cases.append(p)
        for p in cases:
            with self.subTest(p=p), self.assertRaises(MobileError): keyboard.keyboard_contract(p, DEF)
        for roi in ['valueRegion', 'resultRegion']:
            with self.subTest(roi=roi), self.assertRaises(MobileError):
                keyboard.keyboard_contract(plan(), {**DEF, roi: {'x': .1, 'y': .7, 'width': .8, 'height': .1}})

    def test_app_window_image_and_subpixel_source_drift_reject_without_ui(self):
        for app, obs, geometry, raw in [(APP+'x', OBS, GEOMETRY, source()),
                (APP, OBS, (403,874), source()), (APP, {'width':1205,'height':2622}, GEOMETRY, source()),
                (APP, OBS, GEOMETRY, source(590.01))]:
            s, actions = session(raw, app)
            with self.subTest(app=app,obs=obs,geometry=geometry), self.assertRaises(MobileError):
                keyboard.keyboard_state(s, plan(), obs, geometry, True)
            self.assertEqual(actions, [])

    def test_hidden_phase_also_checks_context_and_duplicate_keyboard(self):
        s, actions = session(source().replace('visible="true"', 'visible="false"'))
        with self.assertRaises(MobileError): keyboard.keyboard_state(s, plan(), OBS, (403,874), False)
        raw = source().replace('</Application>', '<Keyboard type="XCUIElementTypeKeyboard" visible="false" x="0" y="874" width="402" height="226"/></Application>')
        s, actions = session(raw)
        with self.assertRaises(MobileError): keyboard.keyboard_state(s, plan(), OBS, GEOMETRY, True)
        self.assertEqual(actions, [])

    def test_only_current_keyboard_subtree_has_key_authority(self):
        extra = '<Button type="XCUIElementTypeButton" name="dictation" label="Dictate" enabled="true" visible="true" x="325" y="805" width="69" height="70"/>'
        s, actions = session(source(extra=extra+extra))
        state = keys.read_source(s, {'keyboard': plan()}, OBS, GEOMETRY)
        self.assertEqual(keys._target(state, 'a', True)['name'], 'a')
        with self.assertRaises(MobileError): keys._target(state, 'dictation', False)
        p = plan(); p['geometryEvidence']['image']['width'] -= 1
        with self.assertRaises(MobileError): keys.read_source(s, {'keyboard':p}, OBS, GEOMETRY)
        self.assertEqual(actions, [])

    def test_center_overlap_and_disabled_targets_still_reject(self):
        raw = source(); clone = '<Button type="XCUIElementTypeButton" name="unknown" label="unknown" visible="true" enabled="false" x="5" y="600" width="30" height="45"/>'
        s, actions = session(raw.replace('</Keyboard>', clone+'</Keyboard>'))
        state = keys.read_source(s, {'keyboard':plan()}, OBS, GEOMETRY)
        with self.assertRaisesRegex(MobileError, 'VISUAL_KEYBOARD_KEY_AMBIGUOUS'): keys._target(state, 'a', True)
        self.assertEqual(actions, [])

    def test_evidence_changes_existing_digest(self):
        p = plan(); q = copy.deepcopy(p); q['geometryEvidence']['calibration']['visibleSourceSha256'] = 'b'*64
        self.assertNotEqual(digest(p), digest(q))

    def test_explicit_profile_retains_full_workflow_echo_dismiss_result_and_no_retry_gates(self):
        definition = {**BASE_DEF, 'resultRegion': {'x': .1, 'y': .4, 'width': .8, 'height': .08}}
        p = plan(); p['region'] = p['sourceRegion'] = {'x':0,'y':.5,'width':1,'height':.5}
        e = p['geometryEvidence']; e['appId'] = 'com.example.fixture'; e['window'] = {'width':100,'height':200}
        e['image'] = {'width':300,'height':600}; e['keyPlane'] = e['visualEnvelope'] = {'x':0,'y':100,'width':100,'height':100}
        for options, expected in [({}, None), ({'submitNoop':True}, 'VISUAL_RESULT_NOT_VERIFIED'),
                ({'inputIgnored':True}, 'VISUAL_INPUT_NOT_VERIFIED'), ({'lateKeyboardOverlay':True}, 'VISUAL_FRAME_CHANGED'),
                ({'dismissChangesInput':True}, 'VISUAL_INPUT_NOT_VERIFIED')]:
            with self.subTest(options=options), tempfile.TemporaryDirectory() as directory:
                with KeyHarness(self, directory, plan=p, definition=definition, **options) as h:
                    observe = h.observation
                    def observation():
                        value = observe()
                        for token in value['tokens']:
                            if token['bounds']['y'] == 370: token['bounds']['y'] = 245
                        return value
                    h.observation = observation
                    if expected is None:
                        result = h.run('Ab7z')
                        self.assertEqual(h.result, 'RESULT Ab7z 1')
                        self.assertEqual(h.count, 1)
                    else:
                        with self.assertRaisesRegex(MobileError, expected): h.run('Ab7z')
                    self.assertFalse(any(route == '/keys' for route, _ in h.calls))
                    self.assertLessEqual(h.count, 1)

    def test_public_example_is_disabled_and_requires_real_local_calibration(self):
        root = Path(__file__).resolve().parents[2]
        example = json.loads((root/'examples/software/ios-visual-keyboard-device.example.json').read_text())
        self.assertIs(example['nativeVisualWorkflow']['enabled'], False)
        with self.assertRaises(MobileError): keyboard.keyboard_contract(example['nativeVisualWorkflow']['keyboard'], DEF)

    def test_source_precheck_projection_cannot_substitute_for_actual_ocr_image_dimensions(self):
        p = plan(); p['region'] = p['sourceRegion'] = {'x':0,'y':.5,'width':1,'height':.5}
        e = p['geometryEvidence']; e['appId'] = 'com.example.fixture'; e['window'] = {'width':100,'height':200}
        e['image'] = {'width':300,'height':600}; e['keyPlane'] = e['visualEnvelope'] = {'x':0,'y':100,'width':100,'height':100}
        definition = {**BASE_DEF, 'resultRegion': {'x':.1,'y':.4,'width':.8,'height':.08}}
        with tempfile.TemporaryDirectory() as directory, KeyHarness(self,directory,plan=p,definition=definition) as h:
            observe = h.observation
            def changed_image():
                result = observe(); result.update(width=600,height=1200); return result
            h.observation = changed_image
            with self.assertRaisesRegex(MobileError,'VISUAL_KEYBOARD_GEOMETRY_UNVERIFIED'): h.run('Ab7z')
            self.assertEqual(h.calls, [])

    def test_seventeenth_original_xml_replay_is_not_device_acceptance(self):
        root = Path(__file__).resolve().parents[2]
        run = root/'output-vision-implementation/ios-key-sampling-compiler17-seventeenth-postfix-source-20261102/output-vision-implementation/ios-keyboard-compiler17-seventeenth-20261102'
        if not (run/'calibration-visible.xml').is_file(): self.skipTest('private archived source absent')
        raw = (run/'calibration-visible.xml').read_text(); p = plan()
        s, actions = session(raw)
        self.assertEqual(keyboard.keyboard_state(s, p, OBS, GEOMETRY, True), SOURCE)
        state = keys.read_source(s, {'keyboard':p}, OBS, GEOMETRY)
        self.assertEqual(state['layer'], 'lower')
        self.assertEqual(keys._target(state, 'a', True)['name'], 'a')
        self.assertFalse(any(row['name']=='dictation' for row in state['rows']))
        self.assertEqual(actions, [])


if __name__ == '__main__': unittest.main()
