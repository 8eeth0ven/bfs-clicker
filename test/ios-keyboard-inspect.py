#!/usr/bin/env python3
"""Read-only calibration proposal for the owned device acceptance fixture."""
import argparse, json
from pathlib import Path
from apk_inventory.mobile_visual_ios_keyboard import inspect_source
p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);p.add_argument('--width',type=float,required=True);p.add_argument('--height',type=float,required=True);p.add_argument('--app-id',required=True);a=p.parse_args()
if a.source.stat().st_size>2*1024*1024:raise SystemExit('SOURCE_LIMIT')
print(json.dumps({'proposal':inspect_source(a.source.read_text(),(a.width,a.height),a.app_id),'authorization':False,'provenance':'actual_wda_xml_proposal'}))
