#!/usr/bin/env python3
"""Build the explicitly configured Android shell helper from local SDK tools."""
import argparse, hashlib, json, subprocess, tempfile, zipfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--sdk',type=Path,required=True);p.add_argument('--out',type=Path,required=True);args=p.parse_args()
versions=sorted((args.sdk/'build-tools').iterdir(),key=lambda p:tuple(int(x) for x in p.name.split('.')) if all(x.isdigit() for x in p.name.split('.')) else (0,))
platform=args.sdk/'platforms'/'android-36'/'android.jar'
if not platform.is_file():raise SystemExit('Android 36 SDK platform required')
with tempfile.TemporaryDirectory() as tmp:
 root=Path(tmp);(root/'classes').mkdir();(root/'dex').mkdir()
 subprocess.run(['javac','--release','8','-classpath',str(platform),'-d',str(root/'classes'),str(Path(__file__).with_name('TargetTap.java'))],check=True,timeout=60)
 subprocess.run([str(versions[-1]/'d8'),'--lib',str(platform),'--min-api','24','--output',str(root/'dex'),str(root/'classes'/'TargetTap.class')],check=True,timeout=60)
 args.out.parent.mkdir(parents=True,exist_ok=True)
 with zipfile.ZipFile(args.out,'w',zipfile.ZIP_DEFLATED) as z:z.write(root/'dex'/'classes.dex','classes.dex')
 print(json.dumps({'path':str(args.out.resolve()),'sha256':hashlib.sha256(args.out.read_bytes()).hexdigest()}))
