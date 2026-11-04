#!/usr/bin/env python3
"""Strict readonly source parsing for the fixture-owner calibration sampler."""
import argparse
import hashlib
import json
import math
import xml.etree.ElementTree as ET
from pathlib import Path
from apk_inventory.mobile_visual_ios_keyboard import _inspect_source


def require(condition, code):
    if not condition:
        raise ValueError(code)

p = argparse.ArgumentParser()
p.add_argument('--source', type=Path, required=True)
p.add_argument('--width', type=int, required=True)
p.add_argument('--height', type=int, required=True)
p.add_argument('--app-id', required=True)
a = p.parse_args()
require(a.source.is_file() and not a.source.is_symlink() and a.source.stat().st_size <= 2 * 1024**2, 'CALIBRATION_SOURCE_INVALID')
data = a.source.read_bytes()
raw = data.decode('utf8', 'strict')
proposal = _inspect_source(raw, (a.width, a.height), a.app_id, unique=True)
require(proposal is not None, 'CALIBRATION_KEYBOARD_UNVERIFIED')
root = ET.fromstring(raw)
app = [n for n in root.iter() if n.attrib.get('type', n.tag) == 'XCUIElementTypeApplication'][0]
windows = [n for n in app.iter() if n.attrib.get('type', n.tag) == 'XCUIElementTypeWindow']
require(windows and all(n.attrib.get('visible') in ('true', 'false') for n in windows), 'CALIBRATION_SOURCE_WINDOW_INVALID')
def rect(node):
    values = [float(node.attrib[k]) for k in ('x', 'y', 'width', 'height')]
    require(all(math.isfinite(v) for v in values) and values == [0, 0, a.width, a.height], 'CALIBRATION_SOURCE_WINDOW_INVALID')
    return values
require(app.attrib.get('visible') == 'true' and app.attrib.get('enabled') == 'true', 'CALIBRATION_SOURCE_APP_INVALID')
rect(app)
result = {'proposal': proposal, 'sourceSha256': hashlib.sha256(data).hexdigest(), 'appId': a.app_id,
          'windows': [{'rect': rect(n), 'visible': n.attrib['visible']} for n in windows], 'authorization': False}
print(json.dumps(result))
