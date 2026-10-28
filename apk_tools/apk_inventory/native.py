"""Bounded ELF/Mach-O evidence extraction; never loads or executes a library.

pyelftools handles ELF layouts. macholib's typed structures handle Mach-O
headers; its top-level MachO parser is deliberately not used because it eagerly
loads section contents. URL evidence is static and never implies an HTTP method.
"""
from __future__ import annotations

import importlib.metadata
import re
import struct
import time
from pathlib import Path
from urllib.parse import urlencode

from .common import InventoryError, normalize_url, redact, redact_text

_MACH = {b'\xfe\xed\xfa\xce':('>',32), b'\xce\xfa\xed\xfe':('<',32),
         b'\xfe\xed\xfa\xcf':('>',64), b'\xcf\xfa\xed\xfe':('<',64)}
_FAT = {b'\xca\xfe\xba\xbe':('>',32), b'\xbe\xba\xfe\xca':('<',32),
        b'\xca\xfe\xba\xbf':('>',64), b'\xbf\xba\xfe\xca':('<',64)}
_NETWORK = re.compile(r'(?:curl_|SSL_|TLS_|HTTP|NSURL|CFNetwork|CFHTTP|AFNetwork|Cronet|grpc|nghttp|socket|connect|send|recv)',re.I)
_STRING_SECTIONS = {'__cstring','__objc_methname','__objc_classname','__objc_methtype','__ustring','__const','__data'}


def _setting(options, name, default):
    return getattr(options,name,default) if not isinstance(options,dict) else options.get(name,default)


def _safe(value, limit=256):
    if isinstance(value,bytes):value=value.split(b'\0',1)[0].decode('utf-8','replace')
    return redact_text(str(value))[:limit]


def _url(value):
    """Do not expose a credential literal even to direct backend consumers."""
    try:
        base,query=normalize_url(value)
    except InventoryError:
        return None
    query=redact(query)
    return base+('?' + urlencode(query,doseq=True) if query else '')


class _Budget(Exception):
    def __init__(self,code):self.code=code


class _Reader:
    """Seekable parser facade: limits single reads and cumulative metadata IO."""
    def __init__(self, raw, state):self.raw,self.state=raw,state
    def read(self,n=-1):
        self.state.check()
        if n<0 or n>min(self.state.parser_left,1024*1024):raise _Budget('NATIVE_PARSER_READ_LIMIT')
        value=self.raw.read(n)
        self.state.parser_left-=len(value)
        if self.state.parser_left<0:raise _Budget('NATIVE_PARSER_READ_LIMIT')
        return value
    def seek(self,offset,whence=0):return self.raw.seek(offset,whence)
    def tell(self):return self.raw.tell()


class _Range:
    def __init__(self,raw,start,size,state):
        self.raw,self.left,self.state=raw,size,state
        raw.seek(start)
    def read(self,n=-1):
        self.state.check()
        n=min(self.left,self.state.chunk if n<0 else n)
        n=min(n,self.state.scan_left)
        if self.left and n<=0:raise _Budget('NATIVE_SCAN_LIMIT')
        data=self.raw.read(n)
        self.left-=len(data);self.state.scan_left-=len(data)
        return data


class _State:
    def __init__(self,path,location,options):
        self.path=Path(path);self.size=self.path.stat().st_size;self.options=options
        self.location=_safe(location,2048)
        self.max_sections=max(1,int(_setting(options,'max_native_sections',4096)))
        self.max_symbols=max(1,int(_setting(options,'max_native_symbols',20000)))
        self.max_slices=max(1,int(_setting(options,'max_native_slices',32)))
        self.max_endpoints=max(1,int(_setting(options,'max_candidates',20000)))
        self.chunk=max(16,min(int(_setting(options,'chunk_bytes',65536)),1024*1024))
        self.parser_left=max(64,int(_setting(options,'max_parser_bytes',64*1024*1024)))
        self.scan_left=max(0,int(_setting(options,'max_native_scan_bytes',_setting(options,'max_member_bytes',128*1024*1024))))
        self.deadline=time.monotonic()+max(.01,float(_setting(options,'worker_timeout',30)))
        self.output_left=max(1024,min(int(_setting(options,'max_tool_output',64*1024*1024)),24*1024*1024))-1024
        self.result={'endpoints':[],'metadata':{'format':'unknown','location':self.location,'file_bytes':self.size,'architectures':[],'slices':[],'sections':[],'imports':[],'exports':[],'jni_symbols':[],'network_symbols':[],'libraries':[]},'limitations':[],'fragments':[]}
        self.seen=set();self.metadata_seen={};self.symbol_count=0;self.section_count=0
    def check(self):
        if time.monotonic()>self.deadline:raise _Budget('NATIVE_TIMEOUT')
    def limit(self,code,**data):
        if not any(x['code']==code and x.get('slice_offset')==data.get('slice_offset') for x in self.result['limitations']):self.result['limitations'].append({'code':code,**data})
    def bounds(self,start,size,low=0,high=None):
        if start<low or size<0 or start> (self.size if high is None else high) or size>(self.size if high is None else high)-start:raise _Budget('NATIVE_INVALID_BOUNDS')
    def charge(self,size):
        self.output_left-=size
        if self.output_left<0:raise _Budget('NATIVE_OUTPUT_LIMIT')
    def metadata(self,key,value):
        items=self.result['metadata'][key];seen=self.metadata_seen.setdefault(key,set())
        if value not in seen and len(items)<self.max_symbols:
            self.charge(len(str(value).encode())+128);items.append(value);seen.add(value)
    def symbol(self,name,undefined,arch,slice_offset,exported=True):
        if self.symbol_count>=self.max_symbols:raise _Budget('NATIVE_SYMBOL_LIMIT')
        self.symbol_count+=1
        name=_safe(name)
        if not name:return
        if undefined or exported:self.metadata('imports' if undefined else 'exports',name)
        if name.lstrip('_').startswith(('Java_','JNI_OnLoad','JNI_OnUnload')):self.metadata('jni_symbols',name)
        if _NETWORK.search(name):
            self.metadata('network_symbols',name)
            if len(self.result['fragments'])<min(self.max_symbols,4096):
                self.charge(len(name.encode())+len(self.location.encode())+384)
                self.result['fragments'].append({'kind':'native_network_symbol','symbol':name,'package':self.location,'architecture':arch,'slice_offset':slice_offset})
    def section(self,name,start,size,arch,slice_offset):
        self.section_count+=1
        if self.section_count>self.max_sections:raise _Budget('NATIVE_SECTION_LIMIT')
        record={'name':_safe(name,128),'offset':start,'size':size,'architecture':arch,'slice_offset':slice_offset}
        self.charge(len(record['name'].encode())+384)
        self.result['metadata']['sections'].append(record)
        return record
    def scan(self,raw,start,size,section,arch,slice_offset,backend,version,mode='section_strings'):
        from .extract import scan_urls
        self.bounds(start,size)
        stream=_Range(raw,start,size,self)
        for literal,offset,encoding in scan_urls(stream,self.chunk):
            self.check()
            url=_url(literal)
            if not url:continue
            key=(url,start+offset,arch)
            if key in self.seen:continue
            if len(self.result['endpoints'])>=self.max_endpoints:raise _Budget('NATIVE_CANDIDATE_LIMIT')
            self.charge(len(url.encode())+len(self.location.encode())+768)
            self.seen.add(key)
            self.result['endpoints'].append({'url':url,'source':'native','package':self.location,'method':None,'offset':start+offset,'section':_safe(section,128),'architecture':arch,'slice_offset':slice_offset,'backend':backend,'backend_version':version,'mode':mode,'encoding':encoding})


def _elf(state,raw):
    try:
        from elftools.elf.elffile import ELFFile
        from elftools.elf.sections import SymbolTableSection
        from elftools.elf.dynamic import DynamicSection
    except ImportError:
        state.limit('NATIVE_BACKEND_UNAVAILABLE',backend='pyelftools')
        state.scan(raw,0,state.size,'<binary>', 'unknown',0,'bounded_stream_scan',None,'binary_strings_fallback')
        return
    version=importlib.metadata.version('pyelftools');state.result['metadata']['backend']='pyelftools';state.result['metadata']['backend_version']=version
    parser=_Reader(raw,state);elf=ELFFile(parser)
    arch=_safe(elf.get_machine_arch(),64)
    state.result['metadata'].update({'format':'elf','bits':elf.elfclass,'endianness':'little' if elf.little_endian else 'big','elf_type':str(elf['e_type']),'architectures':[arch],'machine':str(elf['e_machine'])})
    count=elf.num_sections()
    if count>state.max_sections:raise _Budget('NATIVE_SECTION_LIMIT')
    if int(elf['e_phnum'])>state.max_sections:raise _Budget('NATIVE_SECTION_LIMIT')
    ranges=[];has_symtab=False
    for sec in elf.iter_sections():
        state.check()
        name=sec.name;offset=int(sec['sh_offset']);size=int(sec['sh_size'])
        if sec['sh_type']!='SHT_NOBITS':state.bounds(offset,size)
        state.section(name,offset,size,arch,0)
        if isinstance(sec,SymbolTableSection):
            has_symtab=has_symtab or sec['sh_type']=='SHT_SYMTAB'
            if sec.num_symbols()>state.max_symbols-state.symbol_count:raise _Budget('NATIVE_SYMBOL_LIMIT')
            for sym in sec.iter_symbols():
                exported=sym['st_info']['bind'] in {'STB_GLOBAL','STB_WEAK'} and sym['st_other']['visibility'] in {'STV_DEFAULT','STV_PROTECTED'}
                state.symbol(sym.name,sym['st_shndx']=='SHN_UNDEF',arch,0,exported)
        elif isinstance(sec,DynamicSection):
            for i,tag in enumerate(sec.iter_tags()):
                if i>=state.max_symbols:raise _Budget('NATIVE_SYMBOL_LIMIT')
                if tag.entry.d_tag=='DT_NEEDED':state.metadata('libraries',_safe(tag.needed))
        # Raw instruction bytes are not used to invent literals. Data and string
        # tables remain useful in stripped libraries, including UTF-16 constants.
        elif size and (sec['sh_type']=='SHT_STRTAB' or sec['sh_type']=='SHT_PROGBITS' and not int(sec['sh_flags'])&4):
            if int(sec['sh_flags'])&0x800:
                state.limit('NATIVE_COMPRESSED_SECTION_SKIPPED');continue
            ranges.append((offset,size,name,'section_strings'))
    if not count:
        state.limit('NATIVE_SECTION_HEADERS_ABSENT')
        for i,seg in enumerate(elf.iter_segments()):
            if seg['p_type']=='PT_LOAD' and int(seg['p_flags'])&4 and not int(seg['p_flags'])&1:
                off,size=int(seg['p_offset']),int(seg['p_filesz']);state.bounds(off,size)
                ranges.append((off,size,f'<PT_LOAD:{i}>','segment_strings'))
    state.result['metadata']['stripped']=not has_symtab
    if not has_symtab:state.limit('NATIVE_SYMBOLS_STRIPPED_OR_ABSENT')
    for start,size,name,mode in ranges:state.scan(raw,start,size,name,arch,0,'pyelftools',version,mode)


def _cstring(raw,start,size,state):
    state.bounds(start,size)
    raw.seek(start);data=_Reader(raw,state).read(min(size,1024))
    return _safe(data.split(b'\0',1)[0])


def _macho(state,raw,magic):
    try:
        from macholib import mach_o as mo
        from macholib.ptypes import sizeof
    except ImportError:
        state.limit('NATIVE_BACKEND_UNAVAILABLE',backend='macholib')
        # Never blindly scan a possibly encrypted Mach-O when its load commands
        # cannot be interpreted safely.
        return
    version=importlib.metadata.version('macholib');state.result['metadata'].update({'format':'mach-o','backend':'macholib','backend_version':version})
    parser=_Reader(raw,state)
    slices=[]
    if magic in _FAT:
        endian,bits=_FAT[magic];raw.seek(0);header=mo.fat_header.from_fileobj(parser,_endian_=endian)
        count=int(header.nfat_arch)
        if count<1 or count>state.max_slices:raise _Budget('NATIVE_SLICE_LIMIT')
        cls=mo.fat_arch64 if bits==64 else mo.fat_arch
        table_end=8+count*sizeof(cls);state.bounds(0,table_end)
        for _ in range(count):
            a=cls.from_fileobj(parser,_endian_=endian);start,size=int(a.offset),int(a.size)
            state.bounds(start,size,table_end)
            if size<28 or any(start<o+s and o<start+size for o,s in slices):raise _Budget('NATIVE_INVALID_BOUNDS')
            slices.append((start,size))
    else:slices=[(0,state.size)]
    for start,size in slices:
        try:_macho_slice(state,raw,parser,mo,sizeof,start,size,version)
        except _Budget as e:
            state.limit(e.code,slice_offset=start)
            if e.code in {'NATIVE_TIMEOUT','NATIVE_PARSER_READ_LIMIT','NATIVE_CANDIDATE_LIMIT','NATIVE_SCAN_LIMIT','NATIVE_OUTPUT_LIMIT'}:break
        except Exception:
            state.limit('NATIVE_MACHO_SLICE_INVALID',slice_offset=start)


def _macho_slice(state,raw,parser,mo,sizeof,start,size,version):
    raw.seek(start);magic=raw.read(4)
    if magic not in _MACH:raise _Budget('NATIVE_MACHO_SLICE_INVALID')
    endian,bits=_MACH[magic];header_cls=mo.mach_header_64 if bits==64 else mo.mach_header
    raw.seek(start);header=header_cls.from_fileobj(parser,_endian_=endian)
    header_size=sizeof(header_cls);command_bytes=int(header.sizeofcmds);ncmds=int(header.ncmds)
    if ncmds>state.max_sections or command_bytes>state.parser_left:raise _Budget('NATIVE_COMMAND_LIMIT')
    state.bounds(start+header_size,command_bytes,start,start+size)
    arch=_safe(mo.CPU_TYPE_NAMES.get(int(header.cputype),f'cpu:{int(header.cputype)}'),64)
    state.metadata('architectures',arch)
    slice_info={'offset':start,'size':size,'bits':bits,'architecture':arch,'endianness':'little' if endian=='<' else 'big','encrypted':False,'stripped':True}
    state.result['metadata']['slices'].append(slice_info)
    commands_end=start+header_size+command_bytes;position=start+header_size
    sections=[];symtabs=[];encrypted=[]
    dylibs={mo.LC_LOAD_DYLIB,mo.LC_ID_DYLIB,mo.LC_LOAD_WEAK_DYLIB,mo.LC_REEXPORT_DYLIB,mo.LC_LAZY_LOAD_DYLIB,mo.LC_LOAD_UPWARD_DYLIB}
    for _ in range(ncmds):
        state.check();state.bounds(position,8,start,commands_end);raw.seek(position)
        load=mo.load_command.from_fileobj(parser,_endian_=endian);cmdsize=int(load.cmdsize);cmd=int(load.cmd)
        if cmdsize<8:raise _Budget('NATIVE_INVALID_BOUNDS')
        state.bounds(position,cmdsize,start,commands_end)
        cls=mo.LC_REGISTRY.get(cmd)
        if cls is None:
            state.limit('NATIVE_UNKNOWN_LOAD_COMMAND',slice_offset=start);position+=cmdsize;continue
        if sizeof(cls)+8>cmdsize:raise _Budget('NATIVE_INVALID_BOUNDS')
        command=cls.from_fileobj(parser,_endian_=endian)
        if cmd in (mo.LC_SEGMENT,mo.LC_SEGMENT_64):
            nsects=int(command.nsects);section_cls=mo.section_64 if cmd==mo.LC_SEGMENT_64 else mo.section
            if nsects>state.max_sections-state.section_count:raise _Budget('NATIVE_SECTION_LIMIT')
            if 8+sizeof(cls)+nsects*sizeof(section_cls)!=cmdsize:raise _Budget('NATIVE_INVALID_BOUNDS')
            segment_start=start+int(command.fileoff);segment_size=int(command.filesize)
            state.bounds(segment_start,segment_size,start,start+size)
            for _ in range(nsects):
                section=section_cls.from_fileobj(parser,_endian_=endian)
                offset,length=start+int(section.offset),int(section.size);name=_safe(section.sectname,128);segment=_safe(section.segname,128)
                typ=int(section.flags)&0xff
                if typ in (mo.S_ZEROFILL,mo.S_GB_ZEROFILL,0x12):continue
                state.bounds(offset,length,segment_start,segment_start+segment_size)
                state.section(segment+','+name,offset,length,arch,start)
                if length and (typ==mo.S_CSTRING_LITERALS or name in _STRING_SECTIONS or name.startswith('__swift')):
                    sections.append((offset,length,segment+','+name))
        elif cmd in (mo.LC_ENCRYPTION_INFO,mo.LC_ENCRYPTION_INFO_64):
            off,length,cryptid=int(command.cryptoff),int(command.cryptsize),int(command.cryptid)
            state.bounds(start+off,length,start,start+size)
            if cryptid:
                encrypted.append((start+off,start+off+length));slice_info['encrypted']=True
                state.limit('NATIVE_ENCRYPTED_SLICE',slice_offset=start,cryptid=cryptid)
        elif cmd==mo.LC_SYMTAB:
            off,count,stroff,strsize=int(command.symoff),int(command.nsyms),int(command.stroff),int(command.strsize)
            symbol_cls=mo.nlist_64 if bits==64 else mo.nlist
            if count>state.max_symbols-state.symbol_count:raise _Budget('NATIVE_SYMBOL_LIMIT')
            state.bounds(start+off,count*sizeof(symbol_cls),start,start+size);state.bounds(start+stroff,strsize,start,start+size)
            symtabs.append((off,count,stroff,strsize,symbol_cls))
            slice_info['stripped']=True if count==0 else None
            slice_info['symbol_table_present']=count>0
        elif cmd in dylibs:
            off=int(command.name)
            if off<8+sizeof(cls) or off>=cmdsize:raise _Budget('NATIVE_INVALID_BOUNDS')
            state.metadata('libraries',_cstring(raw,position+off,cmdsize-off,state))
        position+=cmdsize
    if position!=commands_end:raise _Budget('NATIVE_INVALID_BOUNDS')
    if slice_info['stripped']:state.limit('NATIVE_SYMBOLS_STRIPPED_OR_ABSENT',slice_offset=start)
    for off,count,stroff,strsize,cls in symtabs:
        # Encrypting only __TEXT normally leaves linkedit visible; nevertheless
        # never interpret a symbol range that intersects an encryption range.
        if any(start+off<hi and lo<start+off+count*sizeof(cls) or start+stroff<hi and lo<start+stroff+strsize for lo,hi in encrypted):continue
        for index in range(count):
            raw.seek(start+off+index*sizeof(cls));symbol=cls.from_fileobj(parser,_endian_=endian)
            string_index=int(symbol.n_un)
            if string_index<0 or string_index>=strsize:continue
            name=_cstring(raw,start+stroff+string_index,strsize-string_index,state)
            state.symbol(name,int(symbol.n_type)&0x0e==0,arch,start,bool(int(symbol.n_type)&1))
    for offset,length,name in sections:
        if any(offset<hi and lo<offset+length for lo,hi in encrypted):continue
        state.scan(raw,offset,length,name,arch,start,'macholib',version)


def analyze_native(path: Path, location: str, options) -> dict:
    """Return bounded static candidates plus binary metadata/limitations.

    The caller should run this backend in its existing timeout/RSS-limited worker.
    Unknown or corrupt headers are diagnostics, never proof of no endpoints.
    """
    state=_State(path,location,options)
    maximum=int(_setting(options,'max_member_bytes',128*1024*1024))
    if state.size>maximum:
        state.limit('NATIVE_FILE_LIMIT');return state.result
    try:
        with state.path.open('rb') as raw:
            magic=raw.read(4)
            if magic==b'\x7fELF':
                if state.size<52:raise _Budget('NATIVE_TRUNCATED_HEADER')
                state.result['metadata']['format']='elf';_elf(state,raw)
            elif magic in _MACH or magic in _FAT:
                if state.size<28:raise _Budget('NATIVE_TRUNCATED_HEADER')
                state.result['metadata']['format']='mach-o';_macho(state,raw,magic)
            else:state.limit('NATIVE_UNRECOGNIZED_FORMAT')
    except _Budget as e:state.limit(e.code)
    except Exception as e:
        # Third-party exception strings may contain literals and file paths.
        state.limit('NATIVE_PARSE_FAILED',error_type=type(e).__name__)
    state.result['metadata']['candidate_count']=len(state.result['endpoints'])
    state.result['metadata']['section_count']=state.section_count
    state.result['metadata']['symbols_inspected']=state.symbol_count
    state.result['metadata']['static_only']=True
    return state.result
