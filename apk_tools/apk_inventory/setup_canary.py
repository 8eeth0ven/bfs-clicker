"""Local-only HTTPS proxy/trust check; loaded by the setup-owned mitmdump."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from apk_inventory.common import atomic_json


class SetupCanary:
    def load(self, loader):
        loader.add_option("setup_config", str, "", "Local setup canary configuration")

    def running(self):
        self.config = None
        from mitmproxy import ctx
        path = ctx.options.setup_config
        if not path or Path(path).stat().st_size > 65536:
            raise ValueError("Invalid setup config")
        value = json.loads(Path(path).read_text())
        parsed = urlsplit(value["portal_local_origin"])
        import ipaddress
        if parsed.scheme != "http" or not parsed.hostname or not ipaddress.ip_address(parsed.hostname).is_loopback or parsed.username or parsed.password or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            raise ValueError("Setup portal forwarding requires a fixed loopback HTTP origin")
        self.config = value

    def request(self, flow):
        from mitmproxy import http
        config = getattr(self, "config", None)
        if not config:
            if flow.request.host.endswith(".capture.invalid"):
                flow.response = http.Response.make(503, b"Setup configuration unavailable")
            return
        if flow.request.host == config.get("front_host"):
            # Android USB/emulator onboarding uses its already configured proxy,
            # avoiding a second reverse tunnel or a requirement for shared Wi-Fi.
            from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
            class NoRedirect(HTTPRedirectHandler):
                def redirect_request(self, *_):
                    return None
            path = flow.request.path
            prefix = "/" + config["portal_token"] + "/"
            if flow.request.scheme != "http" or not path.startswith(prefix) or flow.request.method not in {"GET", "POST"} or len(flow.request.raw_content or b"") > 1024:
                flow.response = http.Response.make(404, b"Not found")
                return
            target = config["portal_local_origin"] + path
            headers = {key: flow.request.headers[key] for key in ("origin", "x-setup-token", "content-type") if key in flow.request.headers}
            request = Request(target, data=flow.request.raw_content if flow.request.method == "POST" else None, headers=headers, method=flow.request.method)
            try:
                with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=3) as response:
                    body = response.read(512 * 1024 + 1)
                    if len(body) > 512 * 1024:
                        raise ValueError("Portal response budget")
                    safe_headers = {key: value for key, value in response.headers.items() if key.lower() in {"content-type", "cache-control", "content-security-policy", "referrer-policy", "x-content-type-options", "x-frame-options"}}
                    flow.response = http.Response.make(response.status, body, safe_headers)
            except Exception as error:
                close = getattr(error, "close", None)
                if close:
                    close()
                flow.response = http.Response.make(502, b"Setup portal unavailable", {"cache-control": "no-store"})
            return
        if flow.request.host != config["host"]:
            return
        origin = flow.request.headers.get("origin", "")
        valid_path = flow.request.path.split("?", 1)[0] == "/check/" + config["token"]
        valid_origin = origin in config["portal_origins"]
        tls = bool(getattr(flow.client_conn, "tls", False)) and bool(getattr(flow.client_conn, "tls_established", False))
        if flow.request.method == "GET" and valid_path and valid_origin and flow.request.scheme == "https" and tls:
            atomic_json(config["result"], {"ok": True, "session_id": config["session_id"],
                                           "evidence_scope": "selected_browser_proxy_and_tls_path"})
            data = json.dumps({"ok": True, "session_id": config["session_id"]}).encode()
            flow.response = http.Response.make(200, data, {
                "content-type": "application/json", "access-control-allow-origin": origin,
                "cache-control": "no-store", "access-control-allow-private-network": "true"})
        elif flow.request.method == "OPTIONS" and valid_path and valid_origin:
            flow.response = http.Response.make(204, b"", {
                "access-control-allow-origin": origin, "access-control-allow-methods": "GET, OPTIONS",
                "access-control-allow-private-network": "true", "cache-control": "no-store"})
        else:
            # Never send an invalid canary request to an upstream DNS/server.
            flow.response = http.Response.make(404, b"Not found", {"cache-control": "no-store"})


addons = [SetupCanary()]
