#!/usr/bin/env python3
"""Build the owned WebView fixture using the existing SDK/JDK, with no Gradle."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile


def build(out, sdk):
    source = Path(__file__).resolve().parent
    tools = sorted((p for p in (sdk / "build-tools").iterdir() if "-rc" not in p.name), key=lambda p: tuple(map(int, p.name.split("."))))[-1]
    platform = sorted((sdk / "platforms").glob("android-*"), key=lambda p: int(p.name.split("-")[-1]))[-1] / "android.jar"
    out.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    keystore = out.parent / "webview-fixture.keystore"
    java_home = os.environ.get("JAVA_HOME")
    binary = lambda name: str(Path(java_home) / "bin" / name) if java_home else name
    def run(*args):
        subprocess.run([str(arg) for arg in args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)
    with tempfile.TemporaryDirectory(prefix="webview-build-", dir=out.parent) as directory:
        work = Path(directory)
        for name in ["generated", "classes", "dex"]:
            (work / name).mkdir(mode=0o700)
        run(tools / "aapt2", "compile", "--dir", source / "res", "-o", work / "resources.zip")
        run(tools / "aapt2", "link", "-o", work / "unsigned.apk", "--manifest", source / "AndroidManifest.xml", "-I", platform,
            "--java", work / "generated", "--min-sdk-version", "26", "--target-sdk-version", "35", work / "resources.zip")
        files = sorted((source / "src").rglob("*.java")) + sorted((work / "generated").rglob("*.java"))
        run(binary("javac"), "--release", "8", "-classpath", platform, "-d", work / "classes", *files)
        run(tools / "d8", "--lib", platform, "--min-api", "26", "--output", work / "dex", *sorted((work / "classes").rglob("*.class")))
        with zipfile.ZipFile(work / "unsigned.apk", "a", zipfile.ZIP_DEFLATED) as archive:
            archive.write(work / "dex/classes.dex", "classes.dex")
            for file in sorted((source / "assets").rglob("*")):
                if file.is_file():
                    archive.write(file, "assets/" + file.relative_to(source / "assets").as_posix())
        if not keystore.exists():
            run(binary("keytool"), "-genkeypair", "-keystore", keystore, "-storepass", "android", "-keypass", "android",
                "-alias", "fixture", "-dname", "CN=Owned WebView Fixture", "-keyalg", "RSA", "-validity", "3650", "-noprompt")
            keystore.chmod(0o600)
        run(tools / "zipalign", "-f", "4", work / "unsigned.apk", work / "aligned.apk")
        run(tools / "apksigner", "sign", "--ks", keystore, "--ks-pass", "pass:android", "--out", out, work / "aligned.apk")
    out.chmod(0o600)
    return out


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--sdk", type=Path, default=Path(os.environ.get("ANDROID_SDK_ROOT", str(Path.home() / "Library/Android/sdk"))))
    args = parser.parse_args()
    try:
        artifact = build(args.out.resolve(), args.sdk)
        print(json.dumps({"ok": True, "apk": str(artifact), "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest()}))
    except subprocess.CalledProcessError as error:
        print(error.stderr.decode(errors="replace"), file=__import__("sys").stderr)
        raise
