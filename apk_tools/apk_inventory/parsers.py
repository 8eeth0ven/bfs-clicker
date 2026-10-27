"""Bounded structural parsers. They never execute app code."""
from __future__ import annotations

import contextlib
import io
import re
import struct
import xml.etree.ElementTree as ET

from .common import InventoryError, METHODS

ANDROID = "{http://schemas.android.com/apk/res/android}"


def parse_manifest(data: bytes) -> dict:
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise InventoryError("XML_UNSAFE", "External XML declarations are not supported")
    if data.lstrip().startswith(b"<"):
        root = ET.fromstring(data)
        backend = "xml"
    else:
        from pyaxmlparser.axmlprinter import AXMLPrinter
        root = AXMLPrinter(data).get_xml_obj()
        if root is None:
            raise InventoryError("MANIFEST_INVALID", "Cannot parse binary manifest")
        backend = "pyaxmlparser"
    package = root.get("package", "unknown")
    if root.tag.split("}")[-1] != "manifest" or not re.fullmatch(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*", package) or package == "unknown":
        raise InventoryError("MANIFEST_INVALID", "Manifest has no valid application package")
    app = root.find("application")
    launcher = None
    urls = []
    fragments = []
    for node in root.iter():
        for key, value in node.attrib.items():
            if value.startswith(("http://", "https://")):
                urls.append((value, node.tag + "@" + key.split("}")[-1]))
        if node.tag == "data":
            scheme, host = node.get(ANDROID + "scheme"), node.get(ANDROID + "host")
            if scheme in {"http", "https"} and host:
                path = node.get(ANDROID + "path") or node.get(ANDROID + "pathPrefix") or "/"
                if "*" not in host:
                    port = node.get(ANDROID + "port")
                    urls.append((scheme + "://" + host + (":" + port if port else "") + path, "intent-filter/data"))
            elif scheme or host:
                fragments.append({"kind": "deep_link", "scheme": scheme, "host": host})
    if app is not None:
        for node in list(app.findall("activity")) + list(app.findall("activity-alias")):
            for filt in node.findall("intent-filter"):
                actions = {x.get(ANDROID + "name") for x in filt.findall("action")}
                categories = {x.get(ANDROID + "name") for x in filt.findall("category")}
                if "android.intent.action.MAIN" in actions and "android.intent.category.LAUNCHER" in categories:
                    name = node.get(ANDROID + "name")
                    if name:
                        launcher = package + name if name.startswith(".") else package + "." + name if "." not in name else name
    return {"package_name": package, "version_name": root.get(ANDROID + "versionName"),
            "version_code": root.get(ANDROID + "versionCode"), "launcher_activity": launcher,
            "backend": backend, "urls": urls, "fragments": fragments}


def parse_arsc(data: bytes) -> list[tuple[str, str]]:
    from pyaxmlparser.arscparser import ARSCParser
    parsed = ARSCParser(data).get_resolved_strings()
    result = []
    for package, locales in parsed.items():
        for locale, resources in locales.items():
            for resource_id, value in resources.items():
                if isinstance(value, str):
                    result.append((value, f"{package}:{locale}:{resource_id}"))
    return result


class DexReader:
    """Small bounds-checked reader for DEX annotation metadata, not bytecode analysis."""
    def __init__(self, data: bytes):
        self.data = data
        if len(data) < 112 or not data.startswith(b"dex\n") or data[7] != 0:
            raise InventoryError("DEX_INVALID", "Not a supported DEX file")
        if self.u32(32) > len(data) or self.u32(36) != 112 or self.u32(40) != 0x12345678:
            raise InventoryError("DEX_INVALID", "Invalid DEX header")
        count, off = self.u32(56), self.u32(60)
        self.check_table(count, off, 4)
        self.strings = [self.string(self.u32(off + 4 * i)) for i in range(count)]
        count, off = self.u32(64), self.u32(68)
        self.check_table(count, off, 4)
        self.types = [self.index(self.strings, self.u32(off + 4 * i)) for i in range(count)]
        count, off = self.u32(88), self.u32(92)
        self.check_table(count, off, 8)
        self.methods = []
        for i in range(count):
            c, _, name = struct.unpack_from("<HHI", data, off + i * 8)
            self.methods.append(self.index(self.types, c) + "->" + self.index(self.strings, name))

    def check(self, off, size=1):
        if off < 0 or size < 0 or off + size > len(self.data):
            raise InventoryError("DEX_INVALID", "DEX metadata points outside member")

    def check_table(self, count, off, itemsize):
        if count > 2_000_000:
            raise InventoryError("DEX_LIMIT", "DEX table exceeds parser budget")
        self.check(off, count * itemsize)

    @staticmethod
    def index(values, i):
        if i >= len(values):
            raise InventoryError("DEX_INVALID", "DEX index out of bounds")
        return values[i]

    def u32(self, off):
        self.check(off, 4)
        return struct.unpack_from("<I", self.data, off)[0]

    def uleb(self, off):
        value = 0
        for i in range(5):
            self.check(off)
            byte = self.data[off]
            off += 1
            value |= (byte & 127) << (7 * i)
            if byte < 128:
                return value, off
        raise InventoryError("DEX_INVALID", "Invalid ULEB128")

    def string(self, off):
        _, start = self.uleb(off)
        end = self.data.find(b"\0", start, min(len(self.data), start + 65537))
        if end < 0:
            raise InventoryError("DEX_LIMIT", "Unterminated/oversized DEX string")
        return self.data[start:end].replace(b"\xc0\x80", b"\0").decode("utf-8", "replace")

    def value(self, off, depth=0):
        if depth > 12:
            raise InventoryError("DEX_LIMIT", "Annotation nesting exceeds budget")
        self.check(off)
        tag = self.data[off]
        off += 1
        kind, arg = tag & 31, tag >> 5
        if kind == 0x1e:
            return None, off
        if kind == 0x1f:
            return bool(arg), off
        if kind == 0x1c:
            count, off = self.uleb(off)
            if count > 4096:
                raise InventoryError("DEX_LIMIT", "Annotation array exceeds budget")
            values = []
            for _ in range(count):
                item, off = self.value(off, depth + 1)
                values.append(item)
            return values, off
        if kind == 0x1d:
            return self.annotation(off, depth + 1)
        self.check(off, arg + 1)
        number = int.from_bytes(self.data[off:off + arg + 1], "little")
        off += arg + 1
        if kind == 0x17:
            return self.index(self.strings, number), off
        return number, off

    def annotation(self, off, depth=0):
        type_id, off = self.uleb(off)
        size, off = self.uleb(off)
        if size > 4096:
            raise InventoryError("DEX_LIMIT", "Too many annotation members")
        values = {}
        for _ in range(size):
            name, off = self.uleb(off)
            values[self.index(self.strings, name)], off = self.value(off, depth + 1)
        return {"type": self.index(self.types, type_id), "values": values}, off

    def annotation_set(self, off):
        if not off:
            return []
        count = self.u32(off)
        self.check_table(count, off + 4, 4)
        return [self.annotation(self.u32(off + 4 + i * 4) + 1)[0] for i in range(count)]

    def retrofit(self):
        count, off = self.u32(96), self.u32(100)
        self.check_table(count, off, 32)
        results = []
        for c in range(count):
            directory = self.u32(off + c * 32 + 20)
            if not directory:
                continue
            fields, methods, params = self.u32(directory + 4), self.u32(directory + 8), self.u32(directory + 12)
            cursor = directory + 16 + fields * 8
            self.check_table(methods + params, cursor, 8)
            method_annotations = {}
            parameter_annotations = {}
            for i in range(methods):
                method_id, annotation_off = self.u32(cursor + i * 8), self.u32(cursor + i * 8 + 4)
                method_annotations[method_id] = self.annotation_set(annotation_off)
            cursor += methods * 8
            for i in range(params):
                method_id, refs = self.u32(cursor + i * 8), self.u32(cursor + i * 8 + 4)
                n = self.u32(refs)
                self.check_table(n, refs + 4, 4)
                parameter_annotations[method_id] = [self.annotation_set(self.u32(refs + 4 + j * 4)) for j in range(n)]
            for method_id, annotations in method_annotations.items():
                locator = self.index(self.methods, method_id)
                for ann in annotations:
                    match = re.fullmatch(r"Lretrofit2/http/(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|HTTP);", ann["type"])
                    if not match:
                        continue
                    method = ann["values"].get("method") if match[1] == "HTTP" else match[1]
                    path = ann["values"].get("path") if match[1] == "HTTP" else ann["values"].get("value")
                    if method not in METHODS or not isinstance(path, str):
                        continue
                    parameter_names = {"query": [], "path": [], "headers": []}
                    for parameter in parameter_annotations.get(method_id, []):
                        for parameter_ann in parameter:
                            name = parameter_ann["values"].get("value")
                            typ = parameter_ann["type"]
                            key = {"Lretrofit2/http/Query;": "query", "Lretrofit2/http/Path;": "path", "Lretrofit2/http/Header;": "headers"}.get(typ)
                            if key and isinstance(name, str):
                                parameter_names[key].append(name)
                    results.append({"method": method, "path": path, "package": locator, "parameters": parameter_names})
        return results


def parse_dex(data: bytes) -> dict:
    reader = DexReader(data)
    backend = "dex_metadata"
    diagnostics = []
    network_classes = set()
    try:
        # Androguard supplies validated string decoding; metadata reading below
        # separately preserves method/annotation association instead of grepping.
        from loguru import logger
        logger.disable("androguard")
        from androguard.core.dex import DEX
        with contextlib.redirect_stdout(io.StringIO()):
            parsed = DEX(data)
        strings = list(parsed.get_strings())
        backend = "androguard"
        for cls in parsed.get_classes():
            relevant = False
            for method in cls.get_methods():
                code = method.get_code()
                if code is None:
                    continue
                for instruction in code.get_bc().get_instructions():
                    if instruction.get_name() in {"const-string", "const-string/jumbo"}:
                        value = instruction.get_string()
                        if "http://" in value or "https://" in value:
                            relevant = True
                            break
                if relevant:
                    break
            if relevant:
                network_classes.add(cls.get_name())
    except ImportError:
        strings = reader.strings
        diagnostics.append("ANDROGUARD_UNAVAILABLE")
    except Exception:
        strings = reader.strings
        diagnostics.append("ANDROGUARD_PARSE_FAILED")
    annotations = reader.retrofit()
    network_classes.update(value["package"].split("->", 1)[0] for value in annotations)
    return {"strings": strings, "retrofit": annotations, "backend": backend, "network_classes": sorted(network_classes)[:128],
            "diagnostics": diagnostics,
            "network_libraries": sorted({name for name, marker in [("okhttp", "okhttp3/"), ("retrofit", "retrofit2/"), ("java_url", "Ljava/net/URL;")] if any(marker in value for value in strings)})}
