#!/usr/bin/env python3
"""Build the synthetic debug APK with a local Android SDK; no Gradle downloads."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile

def build(out: Path, sdk: Path):
    source = Path(__file__).resolve().parent
    versions = sorted((p for p in (sdk / 'build-tools').iterdir() if '-rc' not in p.name),key=lambda p:tuple(int(x) for x in p.name.split('.')))
    platforms = sorted((sdk / 'platforms').glob('android-*'),key=lambda p:int(p.name.split('-')[-1]))
    if not versions or not platforms:
        raise RuntimeError('Android SDK build-tools and platform are required')
    tools = versions[-1]
    android_jar = platforms[-1] / 'android.jar'
    out.parent.mkdir(parents=True,exist_ok=True)
    keystore=out.parent/'inventory-demo-debug.keystore'
    def run(*args):
        subprocess.run([str(x) for x in args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)
    with tempfile.TemporaryDirectory(prefix='inventory-apk-build-') as temp:
        work = Path(temp)
        (work/'generated').mkdir(); (work/'classes').mkdir(); (work/'dex').mkdir()
        run(tools/'aapt2', 'compile', '--dir', source/'res', '-o', work/'resources.zip')
        run(tools/'aapt2', 'link', '-o', work/'unsigned.apk', '--manifest', source/'AndroidManifest.xml', '-I', android_jar,
            '--java', work/'generated', '--min-sdk-version', '24', '--target-sdk-version', '35', work/'resources.zip')
        java_files = list((source/'src').rglob('*.java'))+list((work/'generated').rglob('*.java'))
        run('javac', '--release', '8', '-classpath', android_jar, '-d', work/'classes', *java_files)
        run(tools/'d8', '--lib', android_jar, '--min-api', '24', '--output', work/'dex', *list((work/'classes').rglob('*.class')))
        with zipfile.ZipFile(work/'unsigned.apk', 'a', zipfile.ZIP_DEFLATED) as archive:
            archive.write(work/'dex/classes.dex','classes.dex')
            for file in (source/'assets').rglob('*'):
                if file.is_file(): archive.write(file,'assets/'+str(file.relative_to(source/'assets')))
        if not keystore.exists():
            run('keytool', '-genkeypair', '-keystore', keystore, '-storepass', 'android', '-keypass', 'android',
                '-alias', 'inventory', '-dname', 'CN=Inventory Demo', '-keyalg', 'RSA', '-validity', '3650', '-noprompt')
            keystore.chmod(0o600)
        run(tools/'zipalign', '-f', '4', work/'unsigned.apk', work/'aligned.apk')
        run(tools/'apksigner', 'sign', '--ks', keystore, '--ks-pass', 'pass:android', '--out', out, work/'aligned.apk')
    return out

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out',type=Path,default=Path('output-unicode-ime/ime.apk'))
    parser.add_argument('--sdk',type=Path,default=Path(os.environ.get('ANDROID_SDK_ROOT',str(Path.home()/'Library/Android/sdk'))))
    args=parser.parse_args()
    try:
        result=build(args.out.resolve(),args.sdk)
        print(json.dumps({'ok':True,'apk':str(result)}))
    except (OSError,RuntimeError,subprocess.SubprocessError) as error:
        print(json.dumps({'ok':False,'error':type(error).__name__}))
        if isinstance(error,subprocess.CalledProcessError):
            print(error.stderr.decode(errors='replace'),file=__import__('sys').stderr)
        raise SystemExit(1)

if __name__=='__main__':main()
