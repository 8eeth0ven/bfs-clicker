"""Container/worker integration for native candidates; no third-party APK."""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from apk_inventory.extract import ExtractOptions, extract_apk

try:
    from .native_fixtures import link_android_fixture
except ImportError:
    from native_fixtures import link_android_fixture

MANIFEST=b'''<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.nativefixture" android:versionName="1.0"><application/></manifest>'''


@unittest.skipUnless(importlib.util.find_spec('elftools'),'pyelftools is needed for native ELF integration')
class NativeApkTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='native-apk-integration-')
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        compiler=shutil.which('clang')
        if not compiler:self.skipTest('clang is needed for the compiled ELF fixture')
        self.binary=self.root/'native-android.o'
        source=Path(__file__).parent/'fixtures/native_demo.c'
        command=[compiler,'-target','aarch64-linux-android','-fPIC','-c',str(source),'-o',str(self.binary)]
        result=subprocess.run(command,capture_output=True,timeout=30)
        if result.returncode:self.skipTest('clang lacks the cross-compilation target')
        linked=link_android_fixture(self.binary,self.root)
        self.linked=linked is not None
        if linked:self.binary=linked
        self.apk=self.root/'fixture.apk'
        with zipfile.ZipFile(self.apk,'w',compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('AndroidManifest.xml',MANIFEST)
            archive.write(self.binary,'lib/arm64-v8a/libfixture.so')

    def test_apk_native_worker_endpoints_and_evidence_are_connected(self):
        out=self.root/'inventory'
        extract_apk(self.apk,out,ExtractOptions())
        endpoints=json.loads((out/'endpoints.static.json').read_text())
        native=[e for e in endpoints if e['source']=='native']
        self.assertGreaterEqual(len(native),2)
        self.assertTrue(all(e['method'] is None and e['categories']==['static_candidate'] for e in native))
        query=next(e['query'] for e in native if e['url'].endswith('/items'))
        self.assertEqual('[REDACTED]',query['token'])
        self.assertEqual('1',query['page'])
        evidence=[json.loads(x) for x in (out/'evidence.jsonl').read_text().splitlines()]
        native_evidence=[e for e in evidence if e['source']=='native']
        self.assertTrue(native_evidence)
        binary=self.binary.read_bytes()
        for e in native_evidence:
            self.assertEqual('lib/arm64-v8a/libfixture.so',e['member'])
            self.assertTrue(e['native']['section'].startswith('.'))
            self.assertEqual('AArch64',e['native']['architecture'])
            self.assertEqual(b'https://',binary[e['offset']:e['offset']+8])
        libraries=json.loads((out/'native_libraries.json').read_text())['libraries']
        self.assertEqual(1,len(libraries))
        self.assertEqual('elf',libraries[0]['format'])
        self.assertEqual('ET_DYN' if self.linked else 'ET_REL',libraries[0]['elf_type'])
        if self.linked:self.assertIn('libnativefixturedep.so',libraries[0]['libraries'])
        self.assertIn('Java_com_example_inventory_Native_endpoint',libraries[0]['jni_symbols'])
        for path in out.iterdir():
            if path.is_file():self.assertNotIn('synthetic-native-secret',path.read_text())

    def test_no_native_cli_skips_shared_library(self):
        out=self.root/'skipped'
        root=Path(__file__).resolve().parents[2]
        env=os.environ.copy();env['PYTHONPATH']=str(root/'apk_tools')
        result=subprocess.run([sys.executable,'-m','apk_inventory.extract',str(self.apk),'--out',str(out),'--no-native'],env=env,cwd=root,capture_output=True,text=True,timeout=30)
        self.assertEqual(0,result.returncode,result.stderr)
        summary=json.loads(result.stdout)
        self.assertIn('NATIVE_DISABLED',summary['warnings'])
        self.assertEqual([],json.loads((out/'native_libraries.json').read_text())['libraries'])
        self.assertFalse(any(e['source']=='native' for e in json.loads((out/'endpoints.static.json').read_text())))


if __name__=='__main__':unittest.main()
