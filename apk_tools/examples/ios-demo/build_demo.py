#!/usr/bin/env python3
"""Build an installable owned UIKit simulator app with local SDK and ad-hoc signing.

This does not accept licenses, change xcode-select, use an Apple account, install
runtimes, or contact a device. The output is simulator-only, not an App Store IPA.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import subprocess

HERE = Path(__file__).resolve().parent

def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--controls', action='store_true')
    options = parser.parse_args()
    out = options.out.resolve()
    if out.suffix != '.app':
        raise SystemExit('--out must end in .app')
    if out.exists() and not (out / '.bfs-owned-fixture').is_file():
        raise SystemExit('Refusing to overwrite an existing app without our fixture marker')
    sdk = run(['/usr/bin/xcrun', '--sdk', 'iphonesimulator', '--show-sdk-path'])
    clang = run(['/usr/bin/xcrun', '--sdk', 'iphonesimulator', '--find', 'clang'])
    out.mkdir(parents=True, exist_ok=True)
    (out / '.bfs-owned-fixture').write_text('owned simulator fixture\n')
    manifest = {
        'CFBundleIdentifier': 'com.example.bfsmcp.ioscontrols' if options.controls else 'com.example.bfsmcp.iosfixture',
        'CFBundleName': 'BFSMCPDemo', 'CFBundleDisplayName': 'BFS MCP Demo',
        'CFBundleExecutable': 'BFSMCPDemo', 'CFBundlePackageType': 'APPL',
        'CFBundleVersion': '1', 'CFBundleShortVersionString': '1.0',
        'CFBundleSupportedPlatforms': ['iPhoneSimulator'],
        'MinimumOSVersion': '17.0', 'LSRequiresIPhoneOS': True,
        'UIDeviceFamily': [1, 2], 'UILaunchScreen': {},
        'UIApplicationSceneManifest': {'UIApplicationSupportsMultipleScenes': False, 'UISceneConfigurations': {'UIWindowSceneSessionRoleApplication': [{'UISceneConfigurationName': 'Default Configuration', 'UISceneDelegateClassName': 'BFSDemoSceneDelegate'}]}},
        'UIRequiredDeviceCapabilities': ['arm64'],
        'UISupportedInterfaceOrientations': ['UIInterfaceOrientationPortrait'],
    }
    (out / 'Info.plist').write_bytes(plistlib.dumps(manifest))
    run([clang, '-target', 'arm64-apple-ios17.0-simulator', '-isysroot', sdk,
         '-fobjc-arc', '-framework', 'UIKit', '-framework', 'Foundation',
         *(['-DBFS_CONTROLS=1'] if options.controls else []), str(HERE / 'main.m'), '-o', str(out / 'BFSMCPDemo')])
    run(['/usr/bin/codesign', '--force', '--sign', '-', str(out)])
    run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(out)])
    print(json.dumps({'ok': True, 'app': str(out), 'bundleId': manifest['CFBundleIdentifier'],
                      'sdk': sdk, 'executableSha256': hashlib.sha256((out / 'BFSMCPDemo').read_bytes()).hexdigest()}))

if __name__ == '__main__':
    main()
