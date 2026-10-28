"""Small capability-URL setup portal. No directory listing or private CA keys."""
from __future__ import annotations

import html
import ipaddress
import json
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


def public_profile(path):
    import plistlib
    raw = Path(path).read_bytes()
    if len(raw) > 512 * 1024 or b"PRIVATE KEY" in raw:
        raise ValueError("Profile is not a public setup profile")
    profile = plistlib.loads(raw)
    if not isinstance(profile, dict) or profile.get("PayloadType") != "Configuration" or not isinstance(profile.get("PayloadContent"), list):
        raise ValueError("Expected a public Configuration profile with payloads")
    if not profile["PayloadContent"] or not all(isinstance(item, dict) and isinstance(item.get("PayloadType"), str) for item in profile["PayloadContent"]):
        raise ValueError("Profile payloads must be typed public configuration objects")
    allowed = {"Configuration", "com.apple.security.root", "com.apple.wifi.managed", "com.apple.proxy.http.global"}
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization
    import re
    def check(value):
        if isinstance(value, dict):
            if "PayloadType" in value and value["PayloadType"] not in allowed:
                raise ValueError("Unexpected setup payload")
            if "PayloadType" in value:
                common = {"PayloadType", "PayloadVersion", "PayloadIdentifier", "PayloadUUID", "PayloadDisplayName", "PayloadContent", "PayloadDescription", "PayloadOrganization", "PayloadRemovalDisallowed", "PayloadScope", "PayloadEnabled"}
                extra = {"com.apple.security.root": {"PayloadCertificateFileName"},
                         "com.apple.wifi.managed": {"SSID_STR", "AutoJoin", "EncryptionType", "HIDDEN_NETWORK", "ProxyType", "ProxyServer", "ProxyServerPort", "ProxyPACURL", "ProxyPACFallbackAllowed"},
                         "com.apple.proxy.http.global": {"ProxyType", "ProxyServer", "ProxyServerPort", "ProxyPACURL", "ProxyPACFallbackAllowed", "ProxyCaptiveLoginAllowed"}}
                if set(value) - common - extra.get(value["PayloadType"], set()):
                    raise ValueError("Unsupported public setup property")
            for key, item in value.items():
                if re.search(r"password|passwd|secret|username|privatekey|pkcs12|identity|eapclientconfiguration", key, re.I):
                    raise ValueError("Profile must not contain credentials")
                if isinstance(item, bytes):
                    if key != "PayloadContent" or value.get("PayloadType") != "com.apple.security.root":
                        raise ValueError("Opaque profile data is not a public CA")
                    try:
                        cert = x509.load_der_x509_certificate(item)
                        if cert.public_bytes(serialization.Encoding.DER) != item or not cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
                            raise ValueError()
                    except (ValueError, x509.ExtensionNotFound):
                        raise ValueError("Invalid profile CA") from None
                if key == "ProxyPACURL":
                    parsed = urlsplit(item)
                    if parsed.username or parsed.password or parsed.scheme not in {"http", "https"}:
                        raise ValueError("PAC URL contains credentials or an unsupported scheme")
                check(item)
        elif isinstance(value, list):
            for item in value:
                check(item)
    check(profile)
    return raw


class SetupPortal:
    def __init__(self, host="127.0.0.1", port=0, public_host=None, token=None, status=None):
        self.host, self.token = host, token or secrets.token_hex(24)
        self.public_host = public_host or host
        self.status = status or {}
        self.files = {}
        self.pac_active = False
        self.pac_proxy = None
        self.stop_requested = threading.Event()
        self.continue_requested = threading.Event()
        self.reinstall_requested = threading.Event()
        self.retry_requested = threading.Event()
        self.wifi_requested = threading.Event()
        self.requested_ssid = None
        self.selected_device = None
        self.lock = threading.Lock()
        portal = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass  # Capability URLs and device details never enter access logs.
            def reply(self, code, data, mime="application/json"):
                self.send_response(code)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Referrer-Policy", "no-referrer")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("X-Frame-Options", "DENY")
                if mime.startswith("text/html"):
                    self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://*.capture.invalid; frame-ancestors 'none'")
                self.end_headers()
                self.wfile.write(data)
            def route(self):
                host = self.headers.get("Host", "")
                if host not in portal.allowed_hosts:
                    return None
                path = urlsplit(self.path).path
                prefix = "/" + portal.token + "/"
                return path[len(prefix):] if path.startswith(prefix) else None
            def do_GET(self):
                route = self.route()
                if route is None:
                    return self.reply(404, b'{}')
                if route == "":
                    document = Path(__file__).with_name("setup_ui.html").read_text()
                    document = document.replace("@@TOKEN@@", portal.token)
                    return self.reply(200, document.encode(), "text/html; charset=utf-8")
                if route == "state":
                    with portal.lock:
                        value = json.dumps(portal.status, ensure_ascii=False).encode()
                    return self.reply(200, value)
                if route == "qr.svg":
                    try:
                        import io
                        import qrcode
                        import qrcode.image.svg
                        result = io.BytesIO()
                        qrcode.make(getattr(portal, "share_url", portal.url), image_factory=qrcode.image.svg.SvgPathImage).save(result)
                        return self.reply(200, result.getvalue(), "image/svg+xml")
                    except ImportError:
                        return self.reply(404, b'{}')
                if route == "proxy.pac":
                    result = "PROXY " + portal.pac_proxy + "; DIRECT" if portal.pac_active and portal.pac_proxy else "DIRECT"
                    # The portal must remain reachable while the system switches proxies.
                    source = "function FindProxyForURL(url, host) { if (url.indexOf(" + json.dumps("http://" + portal.public_host + ":" + str(portal.server.server_address[1]) + "/") + ") === 0) return 'DIRECT'; return " + json.dumps(result) + "; }\n"
                    return self.reply(200, source.encode(), "application/x-ns-proxy-autoconfig")
                if route in portal.files:
                    raw, mime = portal.files[route]
                    return self.reply(200, raw, mime)
                return self.reply(404, b'{}')
            def do_POST(self):
                route = self.route()
                if route not in {"stop", "continue", "reinstall", "retry", "device", "wifi"}:
                    return self.reply(404, b'{}')
                if self.headers.get("Origin") not in portal.origins or self.headers.get("X-Setup-Token") != portal.token:
                    return self.reply(403, b'{}')
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                except ValueError:
                    return self.reply(400, b'{}')
                if not 0 <= length <= 1024:
                    return self.reply(413, b'{}')
                raw = self.rfile.read(length)
                if route in {"device", "wifi"}:
                    try:
                        data = json.loads(raw)
                        value = data.get("id" if route == "device" else "ssid")
                        maximum = 255 if route == "device" else 32
                        if not isinstance(value, str) or not value or len(value.encode()) > maximum or any(ord(c) < 32 for c in value):
                            raise ValueError()
                    except (ValueError, AttributeError):
                        return self.reply(400, b'{}')
                    if route == "device":
                        portal.selected_device = value
                    else:
                        portal.requested_ssid = value
                        portal.wifi_requested.set()
                else:
                    {"stop": portal.stop_requested, "continue": portal.continue_requested, "reinstall": portal.reinstall_requested, "retry": portal.retry_requested}[route].set()
                return self.reply(200, b'{"ok":true}')
        self.server = ThreadingHTTPServer((host, port), Handler)
        actual_port = self.server.server_address[1]
        self.allowed_hosts = {f"{self.public_host}:{actual_port}", f"127.0.0.1:{actual_port}", f"localhost:{actual_port}"}
        self.origins = {"http://" + host for host in self.allowed_hosts}
        self.url = f"http://{self.public_host}:{actual_port}/{self.token}/"
        self.local_url = f"http://127.0.0.1:{actual_port}/{self.token}/"
        self.thread = None

    def update(self, **fields):
        with self.lock:
            self.status.update(fields)

    def certificate(self, path):
        from cryptography import x509
        from cryptography.hazmat.primitives import serialization
        raw = Path(path).read_bytes()
        if b"PRIVATE KEY" in raw:
            raise ValueError("Public certificate required")
        try:
            cert = x509.load_pem_x509_certificate(raw)
        except ValueError:
            cert = x509.load_der_x509_certificate(raw)
        self.files["ca.cer"] = (cert.public_bytes(serialization.Encoding.DER), "application/x-x509-ca-cert")

    def profile(self, path):
        self.files["setup.mobileconfig"] = (public_profile(path), "application/x-apple-aspen-config")
        self.update(profile_available=True)

    def start(self):
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def close(self):
        if self.thread:
            self.server.shutdown()
            self.thread.join(timeout=2)
        self.server.server_close()
