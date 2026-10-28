import builtins
import dataclasses
import importlib.util
import json
import shutil
import struct
import subprocess
import tempfile
import tracemalloc
import unittest
from pathlib import Path
from unittest.mock import patch

from apk_inventory.extract import ExtractOptions
from apk_inventory.native import analyze_native

try:
    from .native_fixtures import link_android_fixture
except ImportError:
    from native_fixtures import link_android_fixture

URL=b'https://native.example.test/v1/items?token=synthetic-native-secret&page=1\0'


def macho_literal(*, encrypted=False, endian='<', bits=64, padding=0, literal=URL):
    """A valid layout-only fixture; runtime/compiler coverage is separate below."""
    is64=bits==64
    segsize=152 if is64 else 124
    encsize=24 if is64 else 20
    commands=segsize+(encsize if encrypted else 0)
    header_size=32 if is64 else 28
    offset=header_size+commands+padding
    length=offset+len(literal)
    header=struct.pack(endian+('IIIIIIII' if is64 else 'IIIIIII'),0xfeedfacf if is64 else 0xfeedface,0x100000c if is64 else 12,0,2,2 if encrypted else 1,commands,0,*([0] if is64 else []))
    if is64:
        segment=struct.pack(endian+'II16sQQQQiiII',0x19,segsize,b'__TEXT',0,length,0,length,7,5,1,0)
        section=struct.pack(endian+'16s16sQQIIIIIIII',b'__cstring',b'__TEXT',0,len(literal),offset,0,0,0,2,0,0,0)
    else:
        segment=struct.pack(endian+'II16sIIIIiiII',1,segsize,b'__TEXT',0,length,0,length,7,5,1,0)
        section=struct.pack(endian+'16s16sIIIIIIIII',b'__cstring',b'__TEXT',0,len(literal),offset,0,0,0,2,0,0)
    encryption=struct.pack(endian+('IIIIII' if is64 else 'IIIII'),0x2c if is64 else 0x21,encsize,offset,len(literal),1,*([0] if is64 else [])) if encrypted else b''
    return header+segment+section+encryption+b'\0'*padding+literal


def fat_macho(slices, *, fat64=False):
    stride=4096
    head=struct.pack('>II',0xcafebabf if fat64 else 0xcafebabe,len(slices))
    data=bytearray(stride*(len(slices)+1))
    for i,item in enumerate(slices):
        off=stride*(i+1)
        if fat64:head+=struct.pack('>iiQQII',0x100000c,0,off,len(item),12,0)
        else:head+=struct.pack('>iiIII',0x100000c,0,off,len(item),12)
        data[off:off+len(item)]=item
    data[:len(head)]=head
    return bytes(data)


class NativeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='native-evidence-test-')
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.options=ExtractOptions()

    def analyze(self,data,name='fixture.bin',options=None):
        path=self.root/name;path.write_bytes(data)
        return analyze_native(path,'lib/arm64-v8a/'+name,options or self.options)

    def codes(self,result):return {x['code'] for x in result['limitations']}

    def compile(self,target=None,name='native.o'):
        compiler=shutil.which('clang')
        if not compiler:self.skipTest('clang is needed for the real compiler fixture')
        source=Path(__file__).parent/'fixtures/native_demo.c'
        out=self.root/name
        command=[compiler,'-fPIC','-c',str(source),'-o',str(out)]
        if target:command[1:1]=['-target',target]
        result=subprocess.run(command,capture_output=True,timeout=30)
        if result.returncode:self.skipTest('installed clang does not support fixture target')
        return out

    def test_unknown_and_truncated_magic_are_not_url_proof(self):
        unknown=self.analyze(URL)
        self.assertEqual([],unknown['endpoints'])
        self.assertIn('NATIVE_UNRECOGNIZED_FORMAT',self.codes(unknown))
        truncated=self.analyze(b'\x7fELFxx')
        self.assertEqual([],truncated['endpoints'])
        self.assertIn('NATIVE_TRUNCATED_HEADER',self.codes(truncated))

    @unittest.skipUnless(importlib.util.find_spec('elftools'),'pyelftools is optional')
    def test_real_cross_compiled_elf_offsets_symbols_and_no_method_guess(self):
        path=self.compile('aarch64-linux-gnu')
        result=analyze_native(path,'lib/arm64-v8a/libdemo.so',self.options)
        self.assertEqual([],result['limitations'])
        self.assertEqual('elf',result['metadata']['format'])
        self.assertEqual('AArch64',result['metadata']['architectures'][0])
        self.assertEqual('ET_REL',result['metadata']['elf_type'])
        self.assertIn('curl_easy_init',result['metadata']['imports'])
        self.assertIn('Java_com_example_inventory_Native_endpoint',result['metadata']['jni_symbols'])
        self.assertNotIn('native_demo.c',result['metadata']['exports'])
        self.assertGreaterEqual(len(result['endpoints']),2)
        raw=path.read_bytes()
        for endpoint in result['endpoints']:
            self.assertIsNone(endpoint['method'])
            self.assertEqual(b'https://',raw[endpoint['offset']:endpoint['offset']+8])
            self.assertEqual('native',endpoint['source'])
            self.assertTrue(endpoint['section'].startswith('.'))
        self.assertNotIn('synthetic-native-secret',json.dumps(result))
        self.assertTrue(any('token=' in e['url'] for e in result['endpoints']))

    @unittest.skipUnless(importlib.util.find_spec('elftools'),'pyelftools is optional')
    def test_linked_android_shared_library_symbols_and_dt_needed(self):
        obj=self.compile('aarch64-linux-android','native-android.o')
        path=link_android_fixture(obj,self.root)
        if path is None:self.skipTest('no local ELF linker for the self-owned shared-library fixture')
        result=analyze_native(path,'lib/arm64-v8a/libnativefixture.so',self.options)
        self.assertEqual([],result['limitations'])
        self.assertEqual('ET_DYN',result['metadata']['elf_type'])
        self.assertIn('libnativefixturedep.so',result['metadata']['libraries'])
        self.assertIn('curl_easy_init',result['metadata']['imports'])
        self.assertIn('Java_com_example_inventory_Native_endpoint',result['metadata']['exports'])
        self.assertGreaterEqual(len(result['endpoints']),2)
        self.assertTrue(all(e['method'] is None for e in result['endpoints']))
        self.assertNotIn('synthetic-native-secret',json.dumps(result))

    @unittest.skipUnless(importlib.util.find_spec('elftools'),'pyelftools is optional')
    def test_real_elf32_and_big_endian(self):
        for target,bits,endian in [('armv7a-linux-gnueabi',32,'little'),('aarch64_be-linux-gnu',64,'big')]:
            with self.subTest(target=target):
                path=self.compile(target,target+'.o')
                result=analyze_native(path,path.name,self.options)
                self.assertEqual('elf',result['metadata']['format'])
                self.assertEqual(bits,result['metadata']['bits'])
                self.assertEqual(endian,result['metadata']['endianness'])
                self.assertGreaterEqual(len(result['endpoints']),2)

    @unittest.skipUnless(importlib.util.find_spec('elftools'),'pyelftools is optional')
    def test_elf_invalid_section_table_does_not_scan_arbitrary_payload(self):
        path=self.compile('aarch64-linux-gnu')
        data=bytearray(path.read_bytes());struct.pack_into('<Q',data,40,2**63)
        result=self.analyze(data)
        self.assertFalse(result['endpoints'])
        self.assertTrue(self.codes(result)&{'NATIVE_PARSE_FAILED','NATIVE_INVALID_BOUNDS'})

    @unittest.skipUnless(importlib.util.find_spec('macholib'),'macholib is optional')
    def test_real_compiled_macho_preserves_sections_and_imports(self):
        path=self.compile(name='native-macho.o')
        raw=path.read_bytes()
        if raw[:4] not in (b'\xcf\xfa\xed\xfe',b'\xce\xfa\xed\xfe',b'\xfe\xed\xfa\xcf',b'\xfe\xed\xfa\xce'):
            self.skipTest('host clang emits ELF, not Mach-O')
        result=analyze_native(path,'Payload/Demo.app/Demo',self.options)
        self.assertEqual([],result['limitations'])
        self.assertTrue(result['metadata']['slices'][0]['symbol_table_present'])
        self.assertIn('_curl_easy_init',result['metadata']['imports'])
        self.assertFalse(any(x.startswith('ltmp') for x in result['metadata']['exports']))
        self.assertGreaterEqual(len(result['endpoints']),2)
        self.assertTrue(all(e['section']=='__TEXT,__cstring' for e in result['endpoints']))
        self.assertNotIn('synthetic-native-secret',json.dumps(result))

    @unittest.skipUnless(importlib.util.find_spec('macholib'),'macholib is optional')
    def test_macho_thin_32_big_endian_and_stripped(self):
        for endian in ('<','>'):
            for bits in (32,64):
                with self.subTest(endian=endian,bits=bits):
                    data=macho_literal(endian=endian,bits=bits)
                    result=self.analyze(data)
                    self.assertEqual(1,len(result['endpoints']))
                    self.assertEqual(bits,result['metadata']['slices'][0]['bits'])
                    self.assertTrue(result['metadata']['slices'][0]['stripped'])
                    self.assertIn('NATIVE_SYMBOLS_STRIPPED_OR_ABSENT',self.codes(result))
                    self.assertEqual(b'https://',data[result['endpoints'][0]['offset']:][:8])

    @unittest.skipUnless(importlib.util.find_spec('macholib'),'macholib is optional')
    def test_macho_encrypted_section_is_diagnostic_not_static_evidence(self):
        for bits in (32,64):
            with self.subTest(bits=bits):
                result=self.analyze(macho_literal(encrypted=True,bits=bits))
                self.assertEqual([],result['endpoints'])
                self.assertTrue(result['metadata']['slices'][0]['encrypted'])
                self.assertIn('NATIVE_ENCRYPTED_SLICE',self.codes(result))

    @unittest.skipUnless(importlib.util.find_spec('macholib'),'macholib is optional')
    def test_fat32_fat64_slices_and_absolute_offsets(self):
        for fat64 in (False,True):
            with self.subTest(fat64=fat64):
                data=fat_macho([macho_literal(),macho_literal(endian='>')],fat64=fat64)
                result=self.analyze(data)
                self.assertEqual(2,len(result['metadata']['slices']))
                self.assertEqual(2,len(result['endpoints']))
                for endpoint in result['endpoints']:
                    self.assertIn(endpoint['slice_offset'],(4096,8192))
                    self.assertEqual(b'https://',data[endpoint['offset']:][:8])
                options=dataclasses.replace(self.options)
                options.max_native_slices=1
                capped=self.analyze(data,options=options)
                self.assertIn('NATIVE_SLICE_LIMIT',self.codes(capped))

    @unittest.skipUnless(importlib.util.find_spec('macholib'),'macholib is optional')
    def test_fat_slice_escape_and_overlap_are_rejected(self):
        data=bytearray(fat_macho([macho_literal(),macho_literal()]))
        struct.pack_into('>I',data,8+20+8,4096)
        result=self.analyze(data)
        self.assertEqual([],result['endpoints'])
        self.assertIn('NATIVE_INVALID_BOUNDS',self.codes(result))

    @unittest.skipUnless(importlib.util.find_spec('macholib'),'macholib is optional')
    def test_chunk_crossing_candidate_and_scan_budgets(self):
        data=macho_literal(padding=17)
        options=dataclasses.replace(self.options,chunk_bytes=16)
        result=self.analyze(data,options=options)
        self.assertEqual(1,len(result['endpoints']))
        options.max_native_scan_bytes=24
        limited=self.analyze(data,options=options)
        self.assertIn('NATIVE_SCAN_LIMIT',self.codes(limited))
        self.assertFalse(limited['endpoints'])

    @unittest.skipUnless(importlib.util.find_spec('macholib'),'macholib is optional')
    def test_34mb_macho_string_section_has_bounded_python_allocations(self):
        data=macho_literal(literal=b'X'*(34*1024*1024)+b'\0'+URL)
        path=self.root/'large-macho';path.write_bytes(data)
        tracemalloc.start()
        try:
            result=analyze_native(path,'Payload/Demo.app/Demo',self.options)
            peak=tracemalloc.get_traced_memory()[1]
        finally:tracemalloc.stop()
        self.assertEqual(1,len(result['endpoints']))
        self.assertLess(peak,4*1024*1024)
        self.assertNotIn('NATIVE_PARSE_FAILED',self.codes(result))

    @unittest.skipUnless(importlib.util.find_spec('elftools'),'pyelftools is optional')
    def test_symbol_candidate_output_and_file_limits(self):
        path=self.compile('aarch64-linux-gnu')
        for name,value,code in [('max_native_symbols',1,'NATIVE_SYMBOL_LIMIT'),('max_candidates',1,'NATIVE_CANDIDATE_LIMIT'),('max_tool_output',1024,'NATIVE_OUTPUT_LIMIT'),('max_member_bytes',8,'NATIVE_FILE_LIMIT')]:
            with self.subTest(name=name):
                options=dataclasses.replace(self.options);setattr(options,name,value)
                result=analyze_native(path,path.name,options)
                self.assertIn(code,self.codes(result))
                if name=='max_candidates':self.assertEqual(1,len(result['endpoints']))

    def test_macho_missing_backend_never_blindly_scans_ciphertext(self):
        original=builtins.__import__
        def blocked(name,*a,**kw):
            if name=='macholib':raise ImportError('fixture backend missing')
            return original(name,*a,**kw)
        with patch('builtins.__import__',side_effect=blocked):result=self.analyze(macho_literal(encrypted=True))
        self.assertFalse(result['endpoints'])
        self.assertIn('NATIVE_BACKEND_UNAVAILABLE',self.codes(result))

    @unittest.skipUnless(importlib.util.find_spec('elftools'),'pyelftools is optional')
    def test_missing_elf_backend_has_explicit_unverified_fallback(self):
        path=self.compile('aarch64-linux-gnu')
        original=builtins.__import__
        def blocked(name,*a,**kw):
            if name.startswith('elftools'):raise ImportError('fixture backend missing')
            return original(name,*a,**kw)
        with patch('builtins.__import__',side_effect=blocked):result=analyze_native(path,path.name,self.options)
        self.assertIn('NATIVE_BACKEND_UNAVAILABLE',self.codes(result))
        self.assertTrue(result['endpoints'])
        self.assertTrue(all(x['mode']=='binary_strings_fallback' and x['method'] is None for x in result['endpoints']))
        self.assertNotIn('synthetic-native-secret',json.dumps(result))


if __name__=='__main__':unittest.main()
