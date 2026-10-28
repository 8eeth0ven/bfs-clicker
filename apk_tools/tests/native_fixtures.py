"""Build self-owned Android-format DSOs with an already installed ELF linker."""
from pathlib import Path
import shutil
import subprocess


def elf_linker():
    choices=[shutil.which('ld.lld'),'/opt/homebrew/opt/llvm/bin/ld.lld']
    choices.extend(str(p) for p in (Path.home()/'.rustup/toolchains').glob('*/lib/rustlib/*/bin/rust-lld'))
    choices.extend(str(p) for p in (Path.home()/'.rustup/toolchains').glob('*/lib/rustlib/*/bin/gcc-ld/ld.lld'))
    for value in choices:
        if value and Path(value).is_file():
            return [value,*(['-flavor','gnu'] if Path(value).name=='rust-lld' else [])]
    return None


def link_android_fixture(obj: Path, directory: Path):
    """Return a true ET_DYN DSO, or None when a required local tool is absent.

    A linker/compilation failure raises instead of silently falling back, so an
    installed yet incompatible toolchain cannot make the assertion pass.
    """
    linker=elf_linker();compiler=shutil.which('clang')
    if not linker or not compiler:return None
    source=Path(__file__).parent/'fixtures/native_dependency.c'
    dep_obj=directory/'native-dependency.o';dependency=directory/'libnativefixturedep.so'
    result=subprocess.run([compiler,'-target','aarch64-linux-android','-fPIC','-c',str(source),'-o',str(dep_obj)],capture_output=True,timeout=30)
    if result.returncode:raise RuntimeError('installed clang failed the self-owned Android dependency fixture')
    subprocess.run([*linker,'-shared','-soname','libnativefixturedep.so','-o',str(dependency),str(dep_obj)],capture_output=True,timeout=30,check=True)
    output=directory/'libnativefixture.so'
    subprocess.run([*linker,'-shared','-soname','libnativefixture.so','-o',str(output),str(obj),'--no-as-needed',str(dependency)],capture_output=True,timeout=30,check=True)
    return output
