from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import plistlib
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from apk_inventory.common import InventoryError, sha256_file
from apk_inventory.extract import ExtractOptions
from apk_inventory.ios import artifact_hash, extract_ios, main


def load(path):
    return json.loads(Path(path).read_text())


class IosTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ios-extract-test-")
        self.root = Path(self.temp.name)
        self.out = self.root / "inventory"

    def tearDown(self):
        self.temp.cleanup()

    def bundle(self, name="Demo.app", *, identifier="com.example.iosfixture", binary=True):
        app = self.root / name
        app.mkdir()
        info = {"CFBundleIdentifier": identifier, "CFBundleShortVersionString": "1.2", "CFBundleVersion": "3",
                "CFBundleURLTypes": [{"CFBundleURLSchemes": ["fixture", "https://scheme-only.example.test"]}],
                "NSAppTransportSecurity": {"NSAllowsArbitraryLoads": False, "NSExceptionDomains": {"ats.example.test": {"NSIncludesSubdomains": True}}},
                "APIConfiguration": {"method": "GET", "url": "https://api.example.test/items?token=SYNTHETIC_QUERY_SECRET", "params": {"page": 1}},
                "client_secret": "https://sensitive-value.example.test/do-not-export"}
        (app / "Info.plist").write_bytes(plistlib.dumps(info, fmt=plistlib.FMT_BINARY if binary else plistlib.FMT_XML))
        (app / "network.json").write_text(json.dumps({"method": "POST", "url": "https://api.example.test/update", "body": {"token": "SYNTHETIC_BODY_SECRET", "n": 2}}))
        (app / "Localizable.strings").write_bytes(('"URL" = "https://api.example.test/help";\n"API_TOKEN" = "https://string-secret.example.test/";').encode("utf-16"))
        return app

    def zip(self, app, name="demo.ipa", *, extra=None):
        path = self.root / name
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for file in sorted(app.rglob("*")):
                if file.is_file():
                    archive.write(file, "Payload/" + app.name + "/" + file.relative_to(app).as_posix())
            for member, data in extra or []:
                archive.writestr(member, data)
        return path

    def records(self):
        descriptor = load(self.out / "source.json")
        return load(self.out / descriptor["inventory"])

    def test_binary_plist_resources_queries_and_sensitive_values(self):
        app = self.bundle()
        summary = extract_ios(app, self.out)
        self.assertGreater(summary["endpoint_count"], 2)
        descriptor = load(self.out / "source.json")
        self.assertEqual(descriptor["kind"], "ios")
        self.assertEqual(descriptor["app"]["bundle_id"], "com.example.iosfixture")
        self.assertEqual(descriptor["app"]["artifact_type"], "app")
        self.assertNotIn("apk_sha256", descriptor["app"])
        self.assertNotIn("ipa_sha256", descriptor["app"])
        self.assertEqual(descriptor["inventory_sha256"], sha256_file(self.out / descriptor["inventory"]))
        records = self.records()
        self.assertTrue(all(x["categories"] == ["static_candidate"] for x in records))
        get = next(x for x in records if x["url"].endswith("/items") and x["method"] == "GET")
        self.assertEqual(get["query"], {"token": "[REDACTED]", "page": 1})
        help_ = next(x for x in records if x["url"].endswith("/help"))
        self.assertIsNone(help_["method"])
        self.assertEqual(help_["source"], "plist")
        combined = "\n".join(p.read_text() for p in self.out.rglob("*.json*"))
        for secret in ("SYNTHETIC_QUERY_SECRET", "SYNTHETIC_BODY_SECRET", "sensitive-value.example.test", "string-secret.example.test"):
            self.assertNotIn(secret, combined)
        self.assertNotIn("scheme-only.example.test", json.dumps(records))
        fragments = [json.loads(line) for line in (self.out / "fragments.jsonl").read_text().splitlines()]
        self.assertTrue(any(x["kind"] == "deep_link_scheme" for x in fragments))
        self.assertTrue(any(x["kind"] == "ats_exception_domain" and x["host"] == "ats.example.test" for x in fragments))

    def test_xml_plist_ipa_identity_and_source_generation(self):
        app = self.bundle(binary=False)
        ipa = self.zip(app)
        extract_ios(ipa, self.out)
        source = load(self.out / "source.json")
        self.assertEqual(source["app"]["artifact_type"], "ipa")
        self.assertEqual(source["app"]["ipa_sha256"], hashlib.sha256(ipa.read_bytes()).hexdigest())
        self.assertEqual(source["app"]["artifact_sha256"], source["app"]["ipa_sha256"])
        self.assertTrue(source["inventory"].startswith("static/"))
        self.assertEqual(source["static_inventory"], source["inventory"])
        self.assertEqual(load(self.out / "endpoints.static.json"), self.records())

    def test_tree_hash_is_path_sensitive_and_timestamp_independent(self):
        app = self.bundle()
        digest = artifact_hash(app)
        second = self.root / "Another.app"
        shutil.copytree(app, second)
        os.utime(second / "network.json", (1, 1))
        self.assertEqual(digest, artifact_hash(second))
        (second / "network.json").rename(second / "different.json")
        self.assertNotEqual(digest, artifact_hash(second))
        extract_ios(app, self.out)
        self.assertEqual(digest, load(self.out / "source.json")["app"]["artifact_sha256"])

    def test_multipart_ipa_requires_explicit_app_selection(self):
        app = self.bundle()
        second = {"CFBundleIdentifier": "com.example.second"}
        ipa = self.zip(app, extra=[("Payload/Second.app/Info.plist", plistlib.dumps(second))])
        with self.assertRaises(InventoryError) as error:
            extract_ios(ipa, self.out)
        self.assertEqual(error.exception.code, "IOS_APP_AMBIGUOUS")
        extract_ios(ipa, self.out, app="Second.app")
        self.assertEqual(load(self.out / "source.json")["app"]["bundle_id"], "com.example.second")
        self.assertEqual(self.records(), [])
        with self.assertRaises(InventoryError):
            extract_ios(ipa, self.out, app="Missing.app")

    def test_zip_slip_aliases_duplicates_and_symlinks_are_rejected(self):
        app = self.bundle()
        for index, member in enumerate(("../outside", "/absolute", "Payload/Demo.app/../evil", "Payload//Demo.app/evil", "Payload/Demo.app\\evil")):
            ipa = self.zip(app, name=f"bad{index}.ipa", extra=[(member, "bad")])
            with self.assertRaises(InventoryError) as error:
                extract_ios(ipa, self.out)
            self.assertEqual(error.exception.code, "ZIP_PATH_INVALID")
        link = zipfile.ZipInfo("Payload/Demo.app/link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        ipa = self.zip(app, name="symlink.ipa", extra=[(link, "../../outside")])
        with self.assertRaises(InventoryError) as error:
            extract_ios(ipa, self.out)
        self.assertEqual(error.exception.code, "IOS_SYMLINK")
        with self.assertWarns(UserWarning):
            ipa = self.zip(app, name="duplicate.ipa", extra=[("Payload/Demo.app/Info.plist", b"x")])
        with self.assertRaises(InventoryError) as error:
            extract_ios(ipa, self.out)
        self.assertEqual(error.exception.code, "ZIP_DUPLICATE_MEMBER")

    def test_directory_symlinks_special_files_and_nested_output_rejected(self):
        app = self.bundle()
        link = app / "link"
        link.symlink_to(self.root / "absent")
        with self.assertRaises(InventoryError) as error:
            artifact_hash(app)
        self.assertEqual(error.exception.code, "IOS_SYMLINK")
        link.unlink()
        if hasattr(os, "mkfifo"):
            os.mkfifo(app / "fifo")
            with self.assertRaises(InventoryError) as error:
                extract_ios(app, self.out)
            self.assertEqual(error.exception.code, "IOS_FILE_TYPE")
            (app / "fifo").unlink()
        with self.assertRaises(InventoryError) as error:
            extract_ios(app, app / "output")
        self.assertEqual(error.exception.code, "IOS_OUTPUT_INVALID")

    def test_member_total_and_compression_budgets(self):
        app = self.bundle()
        with self.assertRaises(InventoryError):
            extract_ios(app, self.out, ExtractOptions(max_member_bytes=10))
        with self.assertRaises(InventoryError):
            extract_ios(app, self.out, ExtractOptions(max_members=1))
        ipa = self.zip(app, extra=[("Payload/Demo.app/bomb", b"A" * 32768)])
        with self.assertRaises(InventoryError) as error:
            extract_ios(ipa, self.out, ExtractOptions(max_ratio=2))
        self.assertEqual(error.exception.code, "ZIP_SIZE_LIMIT")
        with self.assertRaises(InventoryError):
            extract_ios(ipa, self.out, ExtractOptions(max_total_bytes=10))

    def test_invalid_resource_continues_and_preserves_valid_candidates(self):
        app = self.bundle()
        (app / "bad.json").write_text("{ invalid }")
        summary = extract_ios(app, self.out)
        self.assertEqual(summary["status"], "partial")
        self.assertIn("IOS_MEMBER_PARSE_FAILED", summary["warnings"])
        self.assertTrue(any(x["url"].endswith("/items") for x in self.records()))

    def test_native_worker_metadata_encryption_and_disabled_mode(self):
        app = self.bundle()
        (app / "Demo").write_bytes(bytes.fromhex("cffaedfe") + b"x" * 32)
        info = plistlib.loads((app / "Info.plist").read_bytes())
        info["CFBundleExecutable"] = "Demo"
        (app / "Info.plist").write_bytes(plistlib.dumps(info))
        native = {"endpoints": [{"url": "https://native.example.test/items?token=SECRET", "source": "native", "method": None, "offset": 123,
                                 "section": "__cstring", "architecture": "arm64", "backend": "macholib", "mode": "section_strings"}],
                  "metadata": {"format": "mach-o", "slices": [{"architecture": "arm64"}]},
                  "limitations": [{"code": "NATIVE_ENCRYPTED_SLICE"}], "fragments": []}
        with patch("apk_inventory.ios.run_parser", return_value=native) as worker:
            summary = extract_ios(app, self.out)
        self.assertEqual(worker.call_args.args[0], "native")
        self.assertEqual(worker.call_args.args[1]["location"], "Demo")
        self.assertIn("NATIVE_ENCRYPTED_SLICE", summary["warnings"])
        record = next(x for x in self.records() if x["source"] == "native")
        self.assertIsNone(record["method"])
        evidence = [json.loads(line) for line in (self.out / "evidence.jsonl").read_text().splitlines()]
        self.assertTrue(any(x.get("offset") == 123 for x in evidence))
        options = ExtractOptions()
        options.native = False
        with patch("apk_inventory.ios.run_parser") as worker:
            summary = extract_ios(app, self.out, options)
        worker.assert_not_called()
        self.assertIn("NATIVE_DISABLED", summary["warnings"])
        self.assertFalse(any(x["source"] == "native" for x in self.records()))

    def test_failed_publication_keeps_previous_generation_pointer_valid(self):
        app = self.bundle()
        extract_ios(app, self.out)
        before = (self.out / "source.json").read_bytes()
        pointer = load(self.out / "source.json")
        previous = (self.out / pointer["inventory"]).read_bytes()
        (app / "new.json").write_text(json.dumps({"url": "https://new.example.test/route"}))
        with patch("apk_inventory.ios._copy_atomic", side_effect=OSError("simulated publish failure")):
            with self.assertRaises(OSError):
                extract_ios(app, self.out)
        self.assertEqual((self.out / "source.json").read_bytes(), before)
        self.assertEqual((self.out / pointer["inventory"]).read_bytes(), previous)
        self.assertEqual(sha256_file(self.out / pointer["inventory"]), pointer["inventory_sha256"])

    def test_invalid_info_and_cli_exit_status(self):
        app = self.bundle()
        capture = io.StringIO()
        with contextlib.redirect_stdout(capture):
            code = main([str(app), "--out", str(self.out), "--strict"])
        self.assertEqual(code, 3)  # No executable was declared in this resource-only fixture.
        self.assertEqual(json.loads(capture.getvalue())["status"], "partial")
        (app / "Info.plist").write_bytes(b"invalid")
        capture = io.StringIO()
        with contextlib.redirect_stdout(capture):
            code = main([str(app), "--out", str(self.out)])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(capture.getvalue())["error"]["code"], "IOS_INFO_INVALID")

    @unittest.skipUnless(shutil.which("clang") and importlib.util.find_spec("macholib"), "clang and macholib required for real Mach-O fixture")
    def test_real_compiled_arm64_macho_ipa_framework_and_cli(self):
        builder = Path(__file__).parents[1] / "examples" / "ios_demo" / "build_demo.py"
        ipa = self.root / "compiled.ipa"
        result = subprocess.run([sys.executable, str(builder), "--out", str(ipa), "--api-origin", "http://127.0.0.1:8765"], capture_output=True, text=True, timeout=40)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(json.loads(result.stdout)["launchable"])
        summary = extract_ios(ipa, self.out)
        self.assertGreater(summary["endpoint_count"], 0)
        record = next(x for x in self.records() if x["source"] == "native" and x["url"].endswith("/native/items"))
        self.assertIsNone(record["method"])
        self.assertEqual(record["query"]["api_key"], "[REDACTED]")
        self.assertTrue(any("DemoNetwork.framework" in x for x in record["locations"]))
        report = load(self.out / "extraction_report.json")
        self.assertTrue(any(x.get("metadata", {}).get("format") in {"mach-o", "macho"} for x in report["stages"]))
        evidence = [json.loads(line) for line in (self.out / "evidence.jsonl").read_text().splitlines()]
        native_evidence = [x for x in evidence if x["source"] == "native"]
        self.assertTrue(native_evidence)
        self.assertTrue(all(isinstance(x.get("offset"), int) for x in native_evidence))


if __name__ == "__main__":
    unittest.main()
