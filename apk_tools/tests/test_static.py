import io
import json
import os
import struct
import subprocess
import tempfile
import tracemalloc
import unittest
import zipfile
from pathlib import Path

from apk_inventory.common import InventoryError, normalize_url, redact
from apk_inventory.extract import ExtractOptions, collect_js, collect_json, Collector, extract_apk, run_parser, scan_urls
from apk_inventory.hermes import HBC_MAGIC, available_backend, disassemble, literal_objects, probe_header, run_bounded
from apk_inventory.parsers import DexReader, parse_manifest


MANIFEST = b'''<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.fixture" android:versionName="1.0"><application><activity android:name=".MainActivity"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/><data android:scheme="https" android:host="links.example.test" android:path="/welcome"/></intent-filter></activity></application></manifest>'''


def annotation_dex():
    strings = ["Lcom/example/Api;", "Lretrofit2/http/GET;", "value", "https://api.example.test/items", "fetch", "Lretrofit2/http/Query;", "page"]
    data = bytearray(112 + len(strings) * 4 + 3 * 4 + 8 + 32)
    data[:8] = b"dex\n035\0"
    string_ids = 112
    type_ids = string_ids + len(strings) * 4
    method_ids = type_ids + 12
    class_defs = method_ids + 8
    for i, value in enumerate(strings):
        offset = len(data)
        data.extend(bytes([len(value)]) + value.encode() + b"\0")
        struct.pack_into("<I", data, string_ids + i * 4, offset)
    struct.pack_into("<III", data, type_ids, 0, 1, 5)
    struct.pack_into("<HHI", data, method_ids, 0, 0, 4)
    get_item = len(data)
    data.extend(b"\0\1\1\2\x17\3")
    query_item = len(data)
    data.extend(b"\0\2\1\2\x17\6")
    get_set = len(data)
    data.extend(struct.pack("<II", 1, get_item))
    query_set = len(data)
    data.extend(struct.pack("<II", 1, query_item))
    query_refs = len(data)
    data.extend(struct.pack("<II", 1, query_set))
    directory = len(data)
    data.extend(struct.pack("<IIIIIIII", 0, 0, 1, 1, 0, get_set, 0, query_refs))
    struct.pack_into("<I", data, class_defs + 20, directory)
    for off, value in [(32, len(data)), (36, 112), (40, 0x12345678), (56, len(strings)), (60, string_ids), (64, 3), (68, type_ids), (88, 1), (92, method_ids), (96, 1), (100, class_defs)]:
        struct.pack_into("<I", data, off, value)
    return bytes(data)


class StaticTests(unittest.TestCase):
    def test_url_query_and_identity(self):
        url, query = normalize_url("HTTPS://API.Example.test:443/items/?tag=a&tag=b&empty=#anchor")
        self.assertEqual(url, "https://api.example.test/items/")
        self.assertEqual(query, {"tag": ["a", "b"], "empty": ""})
        for url in ["file:///etc/passwd", "https://user:secret@api.test/x", "//api.test/x"]:
            with self.assertRaises(InventoryError):
                normalize_url(url)

    def test_manifest_metadata_and_deeplink(self):
        result = parse_manifest(MANIFEST)
        self.assertEqual(result["package_name"], "com.example.fixture")
        self.assertEqual(result["launcher_activity"], "com.example.fixture.MainActivity")
        self.assertIn(("https://links.example.test/welcome", "intent-filter/data"), result["urls"])

    def test_dex_annotation_method_and_query_are_linked(self):
        reader = DexReader(annotation_dex())
        self.assertEqual(reader.retrofit(), [{"method": "GET", "path": "https://api.example.test/items", "package": "Lcom/example/Api;->fetch", "parameters": {"query": ["page"], "path": [], "headers": []}}])
        malformed = bytearray(annotation_dex())
        struct.pack_into("<I", malformed, 60, len(malformed) + 1)
        with self.assertRaises(InventoryError):
            DexReader(bytes(malformed))

    def test_stream_cross_chunk_and_utf16(self):
        text = b"z" * 65530 + b' "https://api.example.test/cross?q=1" tail '
        found = list(scan_urls(io.BytesIO(text)))
        self.assertEqual([v for v, _, e in found if e == "ascii"], ["https://api.example.test/cross?q=1"])
        for encoding in ["utf-16le", "utf-16be"]:
            data = (" " * 32760 + '"https://api.example.test/utf16" end').encode(encoding)
            values = [value for value, _, _ in scan_urls(io.BytesIO(data))]
            self.assertIn("https://api.example.test/utf16", values)
        urls = [x[0] for x in scan_urls(io.BytesIO(b'"http://[::1]/items/{id}"'))]
        self.assertEqual(urls, ["http://[::1]/items/{id}"])

    def test_34mb_printable_run_has_bounded_scanner_memory(self):
        # Build on disk before measuring; read() must remain chunk bounded.
        with tempfile.TemporaryFile() as stream:
            for _ in range(34):
                stream.write(b"x" * 1024 * 1024)
            stream.write(b' "https://api.example.test/large"')
            stream.seek(0)
            tracemalloc.start()
            values = list(scan_urls(stream))
            _, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
        self.assertEqual([x[0] for x in values], ["https://api.example.test/large"])
        self.assertLess(peak, 3 * 1024 * 1024)

    @unittest.skipUnless(os.name == "posix", "POSIX resource RSS accounting")
    def test_34mb_scanner_rss_growth_is_bounded(self):
        with tempfile.TemporaryDirectory() as temporary:
            paths = []
            for megabytes in [1, 34]:
                path = Path(temporary) / f"{megabytes}.bundle"
                with path.open("wb") as stream:
                    for _ in range(megabytes):
                        stream.write(b"a" * 1024 * 1024)
                    stream.write(b' "https://api.example.test/rss"')
                paths.append(str(path))
            script = """import json,resource,sys
from apk_inventory.extract import scan_urls
values=[]
for path in sys.argv[1:]:
 with open(path,'rb') as stream:
  found=list(scan_urls(stream))
 assert len(found)==1
 high=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
 values.append(high if sys.platform=='darwin' else high*1024)
print(json.dumps(values))
"""
            result = subprocess.run([os.sys.executable, "-c", script, *paths], capture_output=True, text=True, timeout=30, check=True)
            small_peak, large_peak = json.loads(result.stdout)
            self.assertLess(large_peak - small_peak, 8 * 1024 * 1024)

    def test_json_object_association_and_secret_redaction(self):
        with tempfile.TemporaryDirectory() as temp:
            collector = Collector(Path(temp) / "index.sqlite", ExtractOptions())
            collect_json({"baseURL": "https://api.example.test/", "path": "/v1/items", "method": "GET", "params": {"token": "example-local-secret", "page": "001"}}, collector, "asset", "assets/config.json")
            collect_json({"host": "https://unrelated.example.test", "paths": ["/api/private"]}, collector, "asset", "assets/unrelated.json")
            records = list(collector.records())
            linked = next(x for x in records if x["url"] == "https://api.example.test/v1/items")
            self.assertEqual(linked["method"], "GET")
            self.assertEqual(linked["query"], {"token": "[REDACTED]", "page": "001"})
            self.assertFalse(any(x["url"] == "https://unrelated.example.test/api/private" for x in records))
            self.assertNotIn("example-local-secret", json.dumps(records))
            collector.db.close()

    def test_sensitive_parameter_names_preserve_generated_schema(self):
        with tempfile.TemporaryDirectory() as temp:
            collector = Collector(Path(temp) / "db", ExtractOptions())
            collector.add("https://api.example.test/x?access_token=secret-placeholder", "asset", "assets/config.json", method="POST", body={"token": {"nested": "secret-placeholder"}, "password": "secret-placeholder"}, body_present=True)
            record = list(collector.records())[0]
            self.assertEqual(record["body"]["password"], "[REDACTED]")
            self.assertEqual(record["body_shape"]["properties"]["token"]["type"], "object")
            collector.write_evidence(Path(temp) / "evidence.jsonl")
            evidence = json.loads((Path(temp) / "evidence.jsonl").read_text())
            self.assertEqual(evidence["query_shape"]["properties"]["access_token"], {"type": "string"})
            self.assertEqual(evidence["body_shape"]["properties"]["token"]["properties"]["nested"], {"type": "string"})
            self.assertNotIn("secret-placeholder", json.dumps(record) + json.dumps(evidence))
            collector.db.close()

    def test_object_query_preserves_type_without_guessing_wire_encoding(self):
        with tempfile.TemporaryDirectory() as temporary:
            collector = Collector(Path(temporary) / "db", ExtractOptions())
            collector.add("https://api.example.test/x", "asset", "config.json", method="GET", query={"filter": {"state": "open"}, "tag": ["a", "b"]})
            record = list(collector.records())[0]
            self.assertIsNone(record["query"]["filter"])
            self.assertEqual(record["query_shape"]["properties"]["filter"]["type"], "object")
            self.assertEqual(record["unsupported_query_parameters"], ["filter"])
            self.assertEqual(record["query"]["tag"], ["a", "b"])
            collector.db.close()

    def test_literal_js_call_methods(self):
        with tempfile.TemporaryDirectory() as temp:
            collector = Collector(Path(temp) / "db", ExtractOptions())
            collect_js('axios.post("https://api.example.test/write", body); fetch("https://api.example.test/read");', collector, "asset", "assets/a.js")
            result = {x["url"]: x["method"] for x in collector.records()}
            self.assertEqual(result["https://api.example.test/write"], "POST")
            self.assertEqual(result["https://api.example.test/read"], "GET")
            collector.db.close()

    def test_hermes_probe_and_unknown_version_fallback(self):
        self.assertEqual(probe_header(HBC_MAGIC + struct.pack("<I", 100)), {"format": "hermes", "hbc_version": 100})
        self.assertIsNone(available_backend(100, "auto"))

    def test_bounded_tool_timeout_and_literal_arguments(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp) / "out"
            result = run_bounded([os.sys.executable, "-c", "import time;time.sleep(3)"], out, timeout=0.1)
            self.assertTrue(result["timed_out"])
            result = run_bounded([os.sys.executable, "-c", "import sys;print(sys.argv[1])", "a b;$(echo bad)"], out)
            self.assertEqual(result["returncode"], 0)
            self.assertEqual(out.read_text().strip(), "a b;$(echo bad)")

    def test_external_tool_resident_memory_budget(self):
        with tempfile.TemporaryDirectory() as temp:
            result = run_bounded([os.sys.executable, "-c", "import time; x=bytearray(80*1024*1024);time.sleep(3)"], Path(temp) / "out", memory_limit=32 * 1024 * 1024)
            self.assertTrue(result["memory_limited"])
            self.assertGreater(result["peak_rss_bytes"], 32 * 1024 * 1024)

    def test_structural_parser_resident_memory_budget(self):
        with self.assertRaisesRegex(InventoryError, "resident-memory"):
            run_parser("manifest", MANIFEST, ExtractOptions(worker_memory_bytes=1))

    def test_hermes_object_adapter_is_literal_only(self):
        data = "==> NewObjectWithBuffer # Object: {'baseURL': 'https://api.example.test/', 'path': '/items', 'method': 'GET', 'enabled': true}\n==> X # Object: {'url': __import__('os').system('bad')}\n"
        objects = list(literal_objects(io.StringIO(data)))
        self.assertEqual(len(objects), 1)
        self.assertEqual(objects[0][0]["enabled"], True)

    def test_hermes_cli_adapter_collects_output(self):
        with tempfile.TemporaryDirectory() as temp:
            temp = Path(temp)
            tool = temp / "fake hbc-disassembler"
            tool.write_text("#!/usr/bin/env python3\nprint(\"==> X # Object: {'url': 'https://api.example.test/from-object', 'method': 'GET'}\")\n")
            tool.chmod(0o700)
            bundle = temp / "bundle.hbc"
            bundle.write_bytes(HBC_MAGIC + struct.pack("<I", 96))
            result = disassemble(bundle, temp, 96, requested="hermes-dec", executable=str(tool))
            self.assertEqual(result["status"], "complete")
            with result["files"][0].open() as stream:
                self.assertEqual(list(literal_objects(stream))[0][0]["method"], "GET")

    @unittest.skipUnless(os.environ.get("HBC_FIXTURE"), "Compile tests/fixtures/hermes-config.js and set HBC_FIXTURE")
    def test_real_hermes_bytecode_network_configuration(self):
        fixture = Path(os.environ["HBC_FIXTURE"])
        binary = os.environ.get("HBC_DISASSEMBLER", "hbc-disassembler")
        with fixture.open("rb") as stream:
            self.assertEqual(probe_header(stream.read(32))["format"], "hermes")
        with tempfile.TemporaryDirectory() as temporary:
            temporary = Path(temporary)
            apk = temporary / "fixture.apk"
            with zipfile.ZipFile(apk, "w") as archive:
                archive.writestr("AndroidManifest.xml", '<manifest package="test.hermes.fixture"><application/></manifest>')
                archive.write(fixture, "assets/index.android.bundle")
            summary = extract_apk(apk, temporary / "out", ExtractOptions(hermes="hermes-dec", hermes_executable=binary))
            self.assertEqual(summary["status"], "complete")
            records = json.loads((temporary / "out/endpoints.static.json").read_text())
            pairs = {(row["method"], row["url"]) for row in records}
            self.assertIn(("GET", "https://api.fixture.invalid/v1/items"), pairs)
            self.assertIn(("POST", "https://stg.fixture.invalid/v2/items"), pairs)
            self.assertTrue(all(row["source"] == "hermes" for row in records))
            self.assertFalse(any("itemshttps" in row["url"] for row in records))
            evidence = [json.loads(line) for line in (temporary / "out/evidence.jsonl").read_text().splitlines()]
            self.assertTrue(any(row["backend"] == "hermes-dec" and row["backend_version"] for row in evidence))
            self.assertFalse(any(row["mode"] == "binary_printable" for row in evidence))

    @unittest.skipUnless(os.environ.get("APK_INVENTORY_FIXTURE"), "Set APK_INVENTORY_FIXTURE to build_demo.py's signed APK")
    def test_real_compiled_manifest_resources_and_retrofit_dex(self):
        apk = Path(os.environ["APK_INVENTORY_FIXTURE"])
        with zipfile.ZipFile(apk) as archive:
            self.assertFalse(archive.read("AndroidManifest.xml").lstrip().startswith(b"<"))
            self.assertTrue(archive.read("classes.dex").startswith(b"dex\n"))
            self.assertIn("resources.arsc", archive.namelist())
        with tempfile.TemporaryDirectory() as temp:
            result = extract_apk(apk, temp, ExtractOptions(base_url="http://127.0.0.1:8765/"))
            records = json.loads((Path(temp) / "endpoints.static.json").read_text())
            self.assertEqual(result["status"], "complete")
            native = [r for r in records if "dex" in r["extraction_sources"] and r["method"] == "GET"]
            self.assertTrue(any(r.get("parameters", {}).get("query") == ["page"] for r in native))
            self.assertTrue(any(r["url"].endswith("/items/{id}") for r in records))
            report = json.loads((Path(temp) / "extraction_report.json").read_text())
            self.assertTrue(any(s.get("backend") == "androguard" for s in report["stages"]))
            self.assertTrue(any(r["source"] == "strings" and "stg.api.example.test" in r["url"] for r in records))

    def test_extractor_outputs_versioned_artifact_and_unknown_method(self):
        with tempfile.TemporaryDirectory() as temp:
            apk, out = Path(temp) / "fixture.apk", Path(temp) / "out"
            with zipfile.ZipFile(apk, "w") as archive:
                archive.writestr("AndroidManifest.xml", MANIFEST)
                archive.writestr("assets/config.json", json.dumps({"url": "https://api.example.test/items?tag=a&tag=b", "method": "GET"}))
                archive.writestr("assets/index.android.bundle", HBC_MAGIC + struct.pack("<I", 100) + b' "https://stg.api.example.test/unknown" ')
            summary = extract_apk(apk, out)
            descriptor = json.loads((out / "source.json").read_text())
            records = json.loads((out / "endpoints.static.json").read_text())
            self.assertEqual(descriptor["kind"], "apk")
            self.assertEqual(descriptor["app"]["package_name"], "com.example.fixture")
            unknown = next(x for x in records if "/unknown" in x["url"])
            self.assertIsNone(unknown["method"])
            self.assertEqual(unknown["source"], "hermes")
            self.assertEqual(unknown["categories"], ["static_candidate"])
            self.assertEqual(summary["status"], "partial")
            self.assertIn("HERMES_BACKEND_UNAVAILABLE", summary["warnings"])
            self.assertEqual(next(x for x in json.loads((out / "hosts_summary.json").read_text())["hosts"] if x["host"] == "stg.api.example.test")["environment_hint"], "stg")

    def test_zip_unsafe_path_and_budgets(self):
        with tempfile.TemporaryDirectory() as temp:
            apk = Path(temp) / "bad.apk"
            with zipfile.ZipFile(apk, "w") as archive:
                archive.writestr("AndroidManifest.xml", MANIFEST)
                archive.writestr("../outside", "bad")
            with self.assertRaisesRegex(InventoryError, "Unsafe member"):
                extract_apk(apk, Path(temp) / "out")
            with zipfile.ZipFile(apk, "w") as archive:
                archive.writestr("AndroidManifest.xml", MANIFEST)
                archive.writestr("assets/big.txt", b"a" * 1024)
            with self.assertRaises(InventoryError):
                extract_apk(apk, Path(temp) / "out", ExtractOptions(max_total_bytes=500))

    def test_missing_deep_tool_preserves_other_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            apk = Path(temp) / "fixture.apk"
            with zipfile.ZipFile(apk, "w") as archive:
                archive.writestr("AndroidManifest.xml", MANIFEST)
                archive.writestr("classes.dex", annotation_dex())
            result = extract_apk(apk, Path(temp) / "out", ExtractOptions(profile="deep", jadx=str(Path(temp) / "missing-jadx")))
            self.assertEqual(result["status"], "partial")
            self.assertIn("JADX_START_FAILED", result["warnings"])
            self.assertGreater(result["endpoint_count"], 0)

    def test_raw_strings_xml_decodes_entities(self):
        with tempfile.TemporaryDirectory() as temp:
            apk = Path(temp) / "fixture.apk"
            with zipfile.ZipFile(apk, "w") as archive:
                archive.writestr("AndroidManifest.xml", MANIFEST)
                archive.writestr("res/values/strings.xml", '<resources><string name="api">https://api.example.test/items?one=1&amp;two=2</string></resources>')
            extract_apk(apk, Path(temp) / "out")
            records = json.loads((Path(temp) / "out/endpoints.static.json").read_text())
            record = next(r for r in records if r["url"] == "https://api.example.test/items")
            self.assertEqual(record["query"], {"one": "1", "two": "2"})


if __name__ == "__main__":
    unittest.main()
