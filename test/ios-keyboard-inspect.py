#!/usr/bin/env python3
"""Read-only calibration proposal for the owned device acceptance fixture."""
import argparse, json, math
from pathlib import Path
from apk_inventory.mobile_visual_ios_keyboard import inspect_source
p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);p.add_argument('--width',type=float,required=True);p.add_argument('--height',type=float,required=True);p.add_argument('--app-id',required=True);target=p.add_mutually_exclusive_group();target.add_argument('--key-label');target.add_argument('--control',choices=['shift','numbers','letters','delete']);a=p.parse_args()
if a.source.stat().st_size>2*1024*1024:raise SystemExit('SOURCE_LIMIT')
raw=a.source.read_text();proposal=inspect_source(raw,(a.width,a.height),a.app_id)
result={'proposal':proposal,'authorization':False,'provenance':'actual_wda_xml_proposal'}
if a.key_label is not None or a.control is not None:
    import xml.etree.ElementTree as ET
    if proposal is None:raise SystemExit('KEYBOARD_NOT_VISIBLE')
    root=ET.fromstring(raw)
    keyboards=[n for n in root.iter() if n.attrib.get('type',n.tag)=='XCUIElementTypeKeyboard' and n.attrib.get('visible')=='true']
    kind,name,label=('XCUIElementTypeKey',a.key_label,a.key_label) if a.key_label is not None else {
        'shift':('XCUIElementTypeButton','shift','shift'),
        'numbers':('XCUIElementTypeKey','more','numbers'),
        'letters':('XCUIElementTypeKey','more','letters'),
        'delete':('XCUIElementTypeKey','delete','delete'),
    }[a.control]
    keys=[n for n in keyboards[0].iter() if n.attrib.get('type',n.tag)==kind and n.attrib.get('visible')=='true' and n.attrib.get('enabled')=='true' and n.attrib.get('name')==name and n.attrib.get('label')==label]
    if len(keys)!=1:raise SystemExit('KEYBOARD_KEY_AMBIGUOUS_OR_MISSING')
    try:
        box={k:float(keys[0].attrib[k]) for k in ('x','y','width','height')}
        parent={k:float(keyboards[0].attrib[k]) for k in ('x','y','width','height')}
    except (ValueError,KeyError):raise SystemExit('KEYBOARD_KEY_GEOMETRY_INVALID')
    if any(not math.isfinite(v) for v in box.values()) or box['width']<=0 or box['height']<=0 or box['x']<parent['x'] or box['y']<parent['y'] or box['x']+box['width']>parent['x']+parent['width'] or box['y']+box['height']>parent['y']+parent['height']:raise SystemExit('KEYBOARD_KEY_OUTSIDE_KEYBOARD')
    result['key']={'type':kind,'name':name,'label':label,'rect':box}
print(json.dumps(result))
