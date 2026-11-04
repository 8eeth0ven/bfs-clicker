#!/usr/bin/env python3
"""Build an owned inspectable WKWebView simulator fixture with local tools."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess

HERE = Path(__file__).resolve().parent


def run(args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr[-8000:])
    return result.stdout.strip()


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True, type=Path)
    output = parser.parse_args().out.resolve()
    if output.suffix != '.app' or output.exists():
        raise SystemExit('Use a new owned .app output path')
    sdk = run(['/usr/bin/xcrun', '--sdk', 'iphonesimulator', '--show-sdk-path'])
    clang = run(['/usr/bin/xcrun', '--sdk', 'iphonesimulator', '--find', 'clang'])
    output.mkdir(parents=True, mode=0o700)
    executable = output / 'BFSWebViewFixture'
    manifest = {
        'CFBundleIdentifier': 'com.example.bfsmcp.webview', 'CFBundleName': 'BFSWebViewFixture',
        'CFBundleDisplayName': 'BFS WKWebView', 'CFBundleExecutable': executable.name,
        'CFBundlePackageType': 'APPL', 'CFBundleVersion': '1', 'CFBundleShortVersionString': '1.0',
        'CFBundleSupportedPlatforms': ['iPhoneSimulator'], 'MinimumOSVersion': '17.0',
        'LSRequiresIPhoneOS': True, 'UIDeviceFamily': [1, 2], 'UILaunchScreen': {},
        'UIRequiredDeviceCapabilities': ['arm64'],
        'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True, 'NSAllowsArbitraryLoadsInWebContent': True},
        'NSLocalNetworkUsageDescription': 'Owned fixture serves its local loopback HTML only.',
        'UIApplicationSceneManifest': {'UIApplicationSupportsMultipleScenes': False,
            'UISceneConfigurations': {'UIWindowSceneSessionRoleApplication': [
                {'UISceneConfigurationName': 'Default Configuration', 'UISceneDelegateClassName': 'BFSWebScene'}]}},
        'UISupportedInterfaceOrientations': ['UIInterfaceOrientationPortrait'],
    }
    (output / 'Info.plist').write_bytes(plistlib.dumps(manifest))
    (output / 'form.html').write_bytes((HERE / 'form.html').read_bytes())
    run([clang, '-target', 'arm64-apple-ios17.0-simulator', '-isysroot', sdk,
         '-fobjc-arc', '-framework', 'UIKit', '-framework', 'Foundation', '-framework', 'WebKit',
         '-framework', 'CoreGraphics',
         str(HERE / 'main.m'), '-o', str(executable)])
    run(['/usr/bin/codesign', '--force', '--sign', '-', str(output)])
    run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(output)])
    print(json.dumps({'ok': True, 'app': str(output), 'bundleId': manifest['CFBundleIdentifier'],
                      'executableSha256': hashlib.sha256(executable.read_bytes()).hexdigest(),
                      'htmlSha256': hashlib.sha256((output / 'form.html').read_bytes()).hexdigest(), 'sdk': sdk}))


if __name__ == '__main__':
    main()
