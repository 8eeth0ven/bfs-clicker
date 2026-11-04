#!/usr/bin/env python3
"""Build the owned, offline two-path UIKit simulator fixture with local tools."""
from pathlib import Path
import argparse
import hashlib
import json
import plistlib
import subprocess

HERE = Path(__file__).resolve().parent


def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True, type=Path)
    options = parser.parse_args()
    out = options.out.resolve()
    if out.suffix != '.app' or out.exists():
        raise SystemExit('Use a new owned .app output path')
    sdk = run(['/usr/bin/xcrun', '--sdk', 'iphonesimulator', '--show-sdk-path'])
    clang = run(['/usr/bin/xcrun', '--sdk', 'iphonesimulator', '--find', 'clang'])
    out.mkdir(parents=True, mode=0o700)
    (out / '.bfs-owned-fixture').write_text('Owned two-path offline UIKit fixture\n')
    manifest = {
        'CFBundleIdentifier': 'com.example.bfsmcp.nativebranches',
        'CFBundleName': 'BFSNativeBranches', 'CFBundleDisplayName': 'BFS Branches',
        'CFBundleExecutable': 'BFSNativeBranches', 'CFBundlePackageType': 'APPL',
        'CFBundleVersion': '1', 'CFBundleShortVersionString': '1.0',
        'CFBundleSupportedPlatforms': ['iPhoneSimulator'], 'MinimumOSVersion': '17.0',
        'LSRequiresIPhoneOS': True, 'UIDeviceFamily': [1, 2], 'UILaunchScreen': {},
        'UIApplicationSceneManifest': {'UIApplicationSupportsMultipleScenes': False,
            'UISceneConfigurations': {'UIWindowSceneSessionRoleApplication': [
                {'UISceneConfigurationName': 'Default Configuration', 'UISceneDelegateClassName': 'BFSBranchSceneDelegate'}]}},
        'UIRequiredDeviceCapabilities': ['arm64'],
        'UISupportedInterfaceOrientations': ['UIInterfaceOrientationPortrait'],
    }
    (out / 'Info.plist').write_bytes(plistlib.dumps(manifest))
    run([clang, '-target', 'arm64-apple-ios17.0-simulator', '-isysroot', sdk,
         '-fobjc-arc', '-framework', 'UIKit', '-framework', 'Foundation',
         str(HERE / 'main.m'), '-o', str(out / 'BFSNativeBranches')])
    run(['/usr/bin/codesign', '--force', '--sign', '-', str(out)])
    run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(out)])
    print(json.dumps({'ok': True, 'app': str(out), 'bundleId': manifest['CFBundleIdentifier'],
                      'sdk': sdk, 'executableSha256': hashlib.sha256((out / 'BFSNativeBranches').read_bytes()).hexdigest()}))


if __name__ == '__main__':
    main()
