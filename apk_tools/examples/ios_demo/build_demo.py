#!/usr/bin/env python3
"""Build an unsigned IPA/.app evidence fixture, not a launchable iOS app.

The executable slot contains a real clang-generated arm64 iOS Mach-O object;
there is no device install, signing, SDK download or actual network request.
"""
from __future__ import annotations

import argparse
import json
import plistlib
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
from urllib.parse import urlsplit


def build(out: Path, api_origin="https://api.example.test", clang=None):
    out = Path(out)
    origin = urlsplit(api_origin)
    if origin.scheme not in {"http", "https"} or not origin.hostname or origin.username or origin.query or origin.fragment or origin.path not in {"", "/"}:
        raise ValueError("api-origin must be an absolute HTTP(S) origin")
    api_origin = api_origin.rstrip("/")
    compiler = clang or shutil.which("clang")
    if not compiler:
        raise RuntimeError("clang with arm64 Apple target support is required")
    if out.suffix.lower() not in {".ipa", ".app"} or out.exists():
        raise ValueError("out must be a new .ipa file or .app directory")
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ios-evidence-fixture-") as temporary:
        temporary = Path(temporary)
        app = temporary / "InventoryDemo.app"
        (app / "en.lproj").mkdir(parents=True)
        (app / "Frameworks" / "DemoNetwork.framework").mkdir(parents=True)
        info = {"CFBundleIdentifier": "com.example.iosinventorydemo", "CFBundleName": "InventoryDemo", "CFBundleExecutable": "InventoryDemo",
                "CFBundleVersion": "1", "CFBundleShortVersionString": "1.0", "CFBundlePackageType": "APPL",
                "CFBundleURLTypes": [{"CFBundleURLSchemes": ["inventorydemo"]}],
                "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True}}
        (app / "Info.plist").write_bytes(plistlib.dumps(info, fmt=plistlib.FMT_BINARY))
        source = Path(__file__).with_name("network_fixture.c").read_text()
        source = source.replace('"@NATIVE_URL@"', json.dumps(api_origin + "/native/items?api_key=SYNTHETIC_DEMO_ONLY&page=1"))
        native_source = temporary / "network_fixture.c"
        native_source.write_text(source)
        command = [compiler, "-target", "arm64-apple-ios13.0", "-g0", "-O0", "-c", str(native_source), "-o", str(app / "InventoryDemo")]
        result = subprocess.run(command, capture_output=True, text=True, timeout=30)
        if result.returncode:
            raise RuntimeError("clang could not compile the synthetic arm64 Mach-O fixture")
        shutil.copyfile(app / "InventoryDemo", app / "Frameworks" / "DemoNetwork.framework" / "DemoNetwork")
        (app / "network.json").write_text(json.dumps([
            {"method": "GET", "url": api_origin + "/items", "params": {"page": 1}},
            {"method": "POST", "url": api_origin + "/items", "body": {"title": "fixture", "token": "SYNTHETIC_BODY_ONLY"}}
        ], indent=2))
        (app / "en.lproj" / "Localizable.strings").write_bytes(('"HELP_URL" = "' + api_origin + '/help";\n').encode("utf-16"))
        if out.suffix.lower() == ".app":
            shutil.copytree(app, out)
        else:
            with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for path in sorted(app.rglob("*")):
                    if path.is_file():
                        archive.write(path, "Payload/InventoryDemo.app/" + path.relative_to(app).as_posix())
    return {"artifact": str(out.resolve()), "api_origin": api_origin, "signed": False, "launchable": False, "native_fixture": "arm64 iOS Mach-O object"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--api-origin", default="https://api.example.test")
    parser.add_argument("--clang")
    args = parser.parse_args(argv)
    try:
        print(json.dumps(build(args.out, args.api_origin, args.clang), ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"status": "failed", "error": type(error).__name__, "message": str(error)}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
