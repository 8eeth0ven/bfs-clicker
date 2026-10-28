"""One entry point: plan, prepare, approve once, verify, capture and restore."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import ipaddress
import json
import os
import plistlib
import re
import secrets
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path

from .common import InventoryError, atomic_json, read_json
from .verify import load_scope, parse_duration


def save(path, value):
    path = Path(path)
    if path.is_symlink():
        raise InventoryError("SETUP_PATH_INVALID", "State files cannot be symlinks")
    atomic_json(path, value)
    os.chmod(path, 0o600)


def load_receipt(path):
    import stat
    path = Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > 1024 * 1024:
        raise InventoryError("SETUP_STATE_INVALID", "Session receipt must be a bounded regular file owned by this user")
    value = read_json(path)
    if not isinstance(value, dict) or value.get("version") != 1 or not isinstance(value.get("receipts"), list):
        raise InventoryError("SETUP_STATE_INVALID", "Expected a capture setup session receipt")
    return value


def save_recovery(path, state):
    save(path, state)
    root = Path(state.get("root", "."))
    identifier = str(state.get("session_id", ""))
    if not re.fullmatch(r"[a-f0-9]{32}", identifier):
        return
    session = root / "sessions" / identifier / "session.json"
    if str(session) == state.get("state_path") and session.is_file() and not session.is_symlink():
        save(session, state)
    latest = root / "latest.json"
    if latest.is_file() and not latest.is_symlink():
        current = load_receipt(latest)
        if current.get("session_id") == identifier:
            save(latest, state)


def cleanup_complete(state):
    result = state.get("cleanup")
    return isinstance(result, dict) and result.get("proxy_process") not in {None, "pending", "stop_failed", "invalid_process_receipt"} and all(item.get("status") not in {"partial", "failed"} for item in result.get("platforms", []))


class SessionLock:
    def __init__(self, path=None):
        base = Path.home() / ("Library/Application Support/bfs-clicker" if sys.platform == "darwin" else ".local/state/bfs-clicker")
        self.path = Path(path) if path else base / "capture.lock"
        self.stream = None

    def __enter__(self):
        import fcntl
        if self.path.parent.is_symlink() or self.path.is_symlink():
            raise InventoryError("SETUP_PATH_INVALID", "Session lock cannot be a symlink")
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor = os.open(self.path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        if os.fstat(descriptor).st_uid != os.getuid():
            os.close(descriptor)
            raise InventoryError("SETUP_PATH_INVALID", "Session lock belongs to another user")
        self.stream = os.fdopen(descriptor, "r+")
        try:
            fcntl.flock(self.stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.stream.close()
            raise InventoryError("SETUP_BUSY", "Another setup/capture session is active; finish it first") from None
        return self

    def __exit__(self, *_):
        if self.stream:
            self.stream.close()


def adapter(target, options):
    if target == "android":
        from .setup_android import AndroidSetup
        return AndroidSetup(options)
    if target == "macos":
        from .setup_macos import MacOSSetup
        return MacOSSetup(options)
    from .setup_ios import IOSSetup
    return IOSSetup(options)


def select_target(target, artifact, adb="adb"):
    if target != "auto":
        return target
    if artifact:
        path = Path(artifact)
        if path.suffix.lower() == ".apk":
            return "android"
        if path.suffix.lower() == ".ipa":
            return "ios"
        if path.suffix.lower() == ".app":
            try:
                info = plistlib.loads((path / "Info.plist").read_bytes())
                platforms = info.get("CFBundleSupportedPlatforms", [])
                if "iPhoneSimulator" in platforms:
                    return "ios-simulator"
                if "iPhoneOS" in platforms:
                    return "ios"
            except (OSError, ValueError, TypeError):
                pass
            return "macos"
    if shutil.which(adb):
        try:
            output = subprocess.run([adb, "devices"], capture_output=True, text=True, timeout=5).stdout
            devices = [line.split() for line in output.splitlines()[1:] if len(line.split()) >= 2 and line.split()[1] in {"device", "offline", "unauthorized"}]
            if len(devices) == 1:
                return "android"
            if len(devices) > 1:
                raise InventoryError("DEVICE_SELECTION", "Multiple Android devices: select --target and --device")
        except (OSError, subprocess.TimeoutExpired):
            pass
    if sys.platform == "darwin":
        return "macos"
    raise InventoryError("TARGET_REQUIRED", "Select --target android/ios/ios-simulator/macos")


def lan_address():
    if sys.platform == "darwin":
        for interface in ("en0", "en1"):
            try:
                result = subprocess.run(["/usr/sbin/ipconfig", "getifaddr", interface], capture_output=True, text=True, timeout=3)
                value = result.stdout.strip()
                if result.returncode == 0 and not ipaddress.ip_address(value).is_loopback:
                    return value
            except (OSError, ValueError, subprocess.TimeoutExpired):
                pass
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as connection:
        # UDP connect selects a local route without sending any packet.
        try:
            connection.connect(("192.0.2.1", 9))
            address = connection.getsockname()[0]
            if not ipaddress.ip_address(address).is_loopback:
                return address
        except OSError:
            pass
    return "127.0.0.1"


def current_ssid():
    if sys.platform != "darwin":
        return None
    for interface in ("en0", "en1"):
        try:
            value = subprocess.run(["/usr/sbin/networksetup", "-getairportnetwork", interface], capture_output=True, text=True, timeout=3).stdout.strip()
            if value.startswith("Current Wi-Fi Network: "):
                ssid = value.split(": ", 1)[1]
                if ssid and len(ssid.encode()) <= 32 and not any(ord(c) < 32 for c in ssid):
                    return ssid
        except (OSError, subprocess.TimeoutExpired):
            pass
    return None


def available_port(host, preferred):
    for port in ([preferred] + list(range(preferred + 1, min(preferred + 20, 65536)))) if preferred else [0]:
        with socket.socket() as probe:
            try:
                probe.bind((host, port))
                return probe.getsockname()[1]
            except OSError:
                continue
    raise InventoryError("PROXY_PORT_BUSY", "No setup proxy port is available near the requested port")


def discover_adb(value="adb"):
    found = shutil.which(value)
    if found or value != "adb":
        return found
    roots = [os.environ.get("ANDROID_HOME"), os.environ.get("ANDROID_SDK_ROOT"), str(Path.home() / "Library/Android/sdk")]
    for root in roots:
        if root:
            binary = Path(root) / "platform-tools/adb"
            if binary.is_file() and os.access(binary, os.X_OK):
                return str(binary)
    return None


def stop_owned_proxy(state):
    import psutil
    value = state.get("proxy_process", {})
    if not isinstance(value, dict):
        return "invalid_process_receipt"
    if not value.get("pid") or not value.get("command"):
        return "not_started"
    if isinstance(value["pid"], bool) or not isinstance(value["pid"], int) or value["pid"] <= 0 or not isinstance(value["command"], list) or not all(isinstance(item, str) for item in value["command"]):
        return "invalid_process_receipt"
    try:
        process = psutil.Process(value["pid"])
        if process.uids().real != os.getuid() or process.cmdline() != value["command"] or not value.get("create_time") or process.create_time() != value["create_time"]:
            return "changed_process_not_stopped"
        process.send_signal(signal.SIGINT)
        try:
            process.wait(timeout=5)
        except psutil.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=2)
            except psutil.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        return "stopped"
    except psutil.NoSuchProcess:
        return "already_stopped"
    except psutil.Error:
        return "stop_failed"


def cleanup_state(state, remove_ca=False, adapter_factory=adapter):
    if not isinstance(state, dict) or state.get("version") != 1 or not isinstance(state.get("receipts"), list):
        raise InventoryError("SETUP_STATE_INVALID", "Expected a capture setup session receipt")
    pending = state.get("pending_adapters", [])
    if not isinstance(pending, list):
        raise InventoryError("SETUP_STATE_INVALID", "Invalid pending platform receipts")
    for entry in [*state["receipts"], *pending]:
        if not isinstance(entry, dict) or entry.get("target") not in {"macos", "android", "ios", "ios-simulator"} or not isinstance(entry.get("options"), dict):
            raise InventoryError("SETUP_STATE_INVALID", "Invalid platform recovery entry")
    if any(not isinstance(entry.get("state"), dict) for entry in state["receipts"]):
        raise InventoryError("SETUP_STATE_INVALID", "Invalid platform recovery state")
    result = {"platforms": [], "proxy_process": "pending"}
    # Keep the proxy available until native routing is restored, including while
    # an OS authorization dialog is open during restoration.
    receipts = list(state.get("receipts", []))
    for receipt in reversed(receipts):
        try:
            checkpoint = Path(receipt["options"]["state_dir"]) / (receipt["target"] + "-state.json")
            if checkpoint.is_file() and not checkpoint.is_symlink() and checkpoint.stat().st_size <= 1024 * 1024:
                receipt["state"] = read_json(checkpoint)
            instance = adapter_factory(receipt["target"], receipt["options"])
            result["platforms"].append(instance.restore(receipt["state"], remove_ca=remove_ca))
        except Exception as error:
            result["platforms"].append({"status": "partial", "code": getattr(error, "code", "RESTORE_FAILED")})
    # Recover adapter checkpoints if an interrupted apply never returned a receipt.
    recorded = {entry["target"] for entry in receipts}
    for pending in state.get("pending_adapters", []):
        if pending["target"] in recorded:
            continue
        checkpoint = Path(pending["options"]["state_dir"]) / (pending["target"] + "-state.json")
        if checkpoint.is_file():
            try:
                result["platforms"].append(adapter_factory(pending["target"], pending["options"]).restore(read_json(checkpoint), remove_ca=remove_ca))
            except Exception as error:
                result["platforms"].append({"status": "partial", "code": getattr(error, "code", "RESTORE_FAILED")})
    result["proxy_process"] = stop_owned_proxy(state)
    state["cleanup"] = result
    return result


def messages(value):
    result = []
    localized = {"use_profile_portal_or_install_apple_tools": "可直接扫码安装配置；使用 Apple Configurator Automation Tools 可进一步减少真机操作。",
                 "select_or_boot_simulator": "请在此页选择 Simulator；选定后会自动启动。",
                 "connect_or_select_device": "请连接并解锁目标设备；多台设备时在此页选择一台。",
                 "unlock_and_trust_this_computer": "请在设备上同意信任此电脑，完成后自动继续。",
                 "Approve macOS certificate trust and administrator authorization dialogs when shown": "请同意 macOS 出现的证书信任和管理员授权弹窗。"}
    for field in ("manual_steps", "action_required"):
        for item in value.get(field, []):
            text = item if isinstance(item, str) else item.get("message", item.get("description", "")) if isinstance(item, dict) else ""
            if text and text not in result:
                result.append(localized.get(text, text))
    if value.get("platform") == "android" and value.get("ca", {}).get("status") == "manual_confirmation_required":
        result.append("在 Android 系统界面确认安装本项目测试 CA；完成后回到浏览器，本页自动检测。")
    return result


def cleanup_message(result):
    if any(item.get("status") in {"partial", "failed"} for item in result["platforms"]):
        return "部分恢复步骤需要处理，请使用终端给出的恢复命令重试；具体状态已保存在本地会话报告。"
    notes = [item["note"] for item in result["platforms"] if isinstance(item.get("note"), str)]
    return "本轮代理恢复已执行，项目 CA 保留以便下次复用。" + " ".join(notes)


def identity(plan, target):
    device = plan.get("device")
    if isinstance(device, dict):
        return device.get("id") or device.get("identifier")
    return device or (plan.get("cfg_device") or {}).get("ecid") or ("local" if target == "macos" else None)


def inventory_for(args, target, directory):
    inventory = args.inventory.expanduser().resolve() if args.inventory else None
    if args.artifact and target != "macos" and inventory is None:
        inventory = directory / "inventory"
        if target == "android":
            from .extract import extract_apk
            extract_apk(args.artifact, inventory)
        else:
            from .ios import extract_ios
            extract_ios(args.artifact, inventory)
    descriptor, static = None, []
    if inventory:
        from .reconcile import within
        descriptor = read_json(inventory / "source.json")
        if not isinstance(descriptor, dict) or not isinstance(descriptor.get("app"), dict):
            raise InventoryError("INVENTORY_INVALID", "Setup requires a valid inventory source descriptor")
        expected_kind = "apk" if target == "android" else "ios" if target in {"ios", "ios-simulator"} else "web"
        if descriptor.get("format") != "endpoint-inventory" or descriptor.get("kind") != expected_kind:
            raise InventoryError("INVENTORY_INVALID", "Source type does not match the selected setup target")
        if args.artifact and target != "macos":
            if target == "android":
                from .common import sha256_file
                digest, field = sha256_file(args.artifact), "apk_sha256"
            else:
                from .ios import artifact_hash
                digest, field = artifact_hash(args.artifact), "artifact_sha256"
            if descriptor["app"].get(field) != digest:
                raise InventoryError("ARTIFACT_MISMATCH", "Artifact identity does not match the selected inventory")
        static = read_json(within(inventory, descriptor.get("static_inventory", "endpoints.static.json")))
    return inventory, descriptor, load_scope(args.scope, static)


def run_setup(args, adapter_factory=adapter):
    from .setup_ca import ensure_authority
    from .setup_portal import SetupPortal
    target = select_target(args.target, args.artifact, args.adb)
    root = args.state_root.expanduser()
    if root.is_symlink():
        raise InventoryError("SETUP_PATH_INVALID", "Setup state directory cannot be a symlink")
    root = root.resolve()
    known = {"venv", "sessions", "authority", "portal-token", "latest.json", "verified-devices.json"}
    if root == Path.cwd().resolve() or root.is_dir() and any(item.name not in known for item in root.iterdir()):
        raise InventoryError("SETUP_PATH_INVALID", "Use a dedicated private state directory, not a source or document directory")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(root, 0o700)
    latest = root / "latest.json"
    if latest.is_file():
        old = load_receipt(latest)
        session_path = root / "sessions" / str(old.get("session_id", "")) / "session.json"
        if session_path.is_file() and str(session_path) == old.get("state_path"):
            current = load_receipt(session_path)
            if current.get("session_id") == old.get("session_id"):
                old = current
        if not cleanup_complete(old):
            cleanup_state(old, adapter_factory=adapter_factory)
            old["phase"] = "finished" if cleanup_complete(old) else "failed"
            save_recovery(latest, old)
            if not cleanup_complete(old):
                raise InventoryError("RECOVERY_REQUIRED", "Previous settings could not be fully restored; use the saved cleanup receipt")
    directory = root / "sessions" / uuid.uuid4().hex
    directory.mkdir(parents=True, mode=0o700)
    state_path = directory / "session.json"
    state = {"version": 1, "target": target, "session_id": directory.name, "owner_pid": os.getpid(),
             "phase": "preparing", "receipts": [], "pending_adapters": [], "state_path": str(state_path), "root": str(root)}
    def checkpoint():
        save(state_path, state)
        save(latest, state)
    checkpoint()
    authority = ensure_authority(args.ca_dir or root / "authority")
    token_path = root / "portal-token"
    if token_path.is_symlink():
        raise InventoryError("SETUP_PATH_INVALID", "Portal token cannot be a symlink")
    if token_path.exists():
        token = token_path.read_text().strip()
        if not re.fullmatch(r"[a-f0-9]{48}", token):
            raise InventoryError("SETUP_STATE_INVALID", "Portal token has an invalid format")
    else:
        token = secrets.token_hex(24)
        token_path.write_text(token)
        os.chmod(token_path, 0o600)
    host = args.proxy_host or (lan_address() if target == "ios" else "127.0.0.1")
    ipaddress.ip_address(host)
    if target == "ios" and ipaddress.ip_address(host).is_loopback:
        raise InventoryError("IOS_NETWORK_REQUIRED", "A physical iOS device needs this Mac's reachable LAN address; set --proxy-host")
    # Physical Android USB uses adb reverse; the host listener remains loopback.
    bind_host = host if target == "ios" or target == "android" and args.proxy_host else "127.0.0.1"
    proxy_port = available_port(bind_host, args.proxy)
    portal_bind = "0.0.0.0" if target == "ios" else "127.0.0.1"
    portal = SetupPortal(portal_bind, args.portal_port, public_host=host, token=token).start()
    state["portal_url"] = portal.local_url
    state["authority"] = authority
    state["proxy"] = {"host": host, "port": proxy_port}
    # A stable frontend URL lets an already open mobile guide resume next time;
    # the TLS challenge below remains unique to each capture session.
    front_host = "setup-" + token[:12] + ".capture.invalid"
    device_url = portal.url if target == "ios" else "http://" + front_host + "/" + token + "/" if target in {"android", "ios-simulator"} else portal.local_url
    portal.share_url = device_url
    frontend_origin = "http://" + front_host
    portal.origins.add(frontend_origin)
    canary_host = "check-" + directory.name[:12] + ".capture.invalid"
    canary_token = secrets.token_hex(16)
    canary_url = "https://" + canary_host + "/check/" + canary_token
    ca_result = directory / "canary.json"
    canary_config = directory / "canary-config.json"
    selected_origin = portal.url.split("/" + token)[0] if target == "ios" else frontend_origin if target in {"android", "ios-simulator"} else portal.local_url.split("/" + token)[0]
    save(canary_config, {"host": canary_host, "token": canary_token, "portal_token": token,
                        "portal_origins": [selected_origin], "front_host": front_host,
                        "portal_local_origin": portal.local_url.split("/" + token)[0],
                        "result": str(ca_result), "session_id": directory.name})
    portal.certificate(authority["certificate"])
    portal.pac_proxy = f"{host}:{proxy_port}"
    portal.pac_active = True
    portal.update(phase="preparing", summary=f"正在准备 {target} 测试环境", action="自动检查应用、设备和依赖",
                  proxy=f"{host}:{proxy_port}", ca_sha256=authority["sha256"], canary_url=canary_url)
    print("准备页面：" + portal.local_url, file=sys.stderr)
    if target == "ios":
        print("手机同网扫码/打开：" + device_url, file=sys.stderr)
    if not args.no_open:
        with contextlib.suppress(OSError):
            if sys.platform == "darwin":
                subprocess.Popen(["open", "-a", "Safari", portal.local_url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    child = None
    instances = []
    failure = None
    try:
        if target == "android" and adapter_factory is adapter:
            resolved_adb = discover_adb(args.adb)
            if not resolved_adb and args.adb == "adb":
                brew = shutil.which("brew")
                if brew:
                    portal.update(action="首次准备 Android platform-tools，完成后自动继续")
                    with open(os.open(directory / "tools-install.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as output:
                        result = subprocess.run([brew, "install", "--cask", "android-platform-tools"], stdout=output, stderr=output, timeout=600)
                    resolved_adb = discover_adb(args.adb) if result.returncode == 0 else None
            if not resolved_adb:
                raise InventoryError("ANDROID_TOOLS_REQUIRED", "需要 Android platform-tools；安装后在此页点击“重试准备”即可继续。")
            args.adb = resolved_adb
        inventory, descriptor, scope = inventory_for(args, target, directory)
        state["inventory"] = str(inventory) if inventory else None
        wifi_ssid = args.wifi_ssid or (current_ssid() if target == "ios" and not args.supervised else None)
        options = {"target": target, "adb": args.adb, "device": args.device, "proxy_port": proxy_port,
                   "ca_cert": authority["certificate"], "state_dir": str(directory / target), "keep_ca": True,
                   "artifact": str(args.artifact.expanduser().resolve()) if args.artifact else None,
                   "bundle_id": args.bundle_id or (descriptor or {}).get("app", {}).get("package_name"),
                   "onboarding_url": device_url, "ca_url": device_url + "ca.cer", "launch": False,
                   "service": args.service, "wifi_ssid": wifi_ssid, "supervised": args.supervised}
        if target == "ios":
            options.update(proxy_host=host, pac_url=portal.url + "proxy.pac")
            portal.update(pac_url=portal.url + "proxy.pac")
            portal.update(show_wifi=not args.supervised, wifi_ssid=wifi_ssid or "")
        elif target != "android":
            options["proxy_host"] = "127.0.0.1"
        elif args.proxy_host:
            options["proxy_host"] = args.proxy_host
        if target == "ios-simulator":
            # The simulator uses host network proxy settings; retain a separate
            # macOS snapshot and restore it independently of simulator trust.
            companion = {**options, "target": "macos", "artifact": None, "bundle_id": None, "state_dir": str(directory / "macos")}
            instances.append(("macos", companion, adapter_factory("macos", companion)))
        instance = adapter_factory(target, options)
        instances.append((target, options, instance))
        state["pending_adapters"] = [{"target": name, "options": opt} for name, opt, _ in instances]
        checkpoint()
        setup_deadline = time.monotonic() + args.setup_timeout
        plans = []
        # Resolve every device and capability before changing any host setting.
        for index, (name, opt, item) in enumerate(instances):
            while True:
                plan = item.plan()
                if plan.get("status") == "blocked" or plan.get("ready") is False:
                    reason = plan.get("code") or (plan.get("blocking_reasons") or ["SETUP_BLOCKED"])[0]
                    raise InventoryError(reason, "现有代理/PAC或认证配置无法安全自动接管；请选专用网络服务，现有设置未被修改。")
                if name == "ios-simulator":
                    if not plan.get("capabilities", {}).get("simctl"):
                        raise InventoryError("SIMULATOR_TOOLS_REQUIRED", "A complete Xcode Simulator installation is needed")
                    devices = plan.get("devices", [])
                    if not plan.get("device") and len(devices) == 1:
                        opt["device"] = devices[0]["id"]
                        item = adapter_factory(name, opt)
                        instances[index] = (name, opt, item)
                        continue
                    ready = bool(plan.get("device"))
                elif name == "ios" and (plan.get("devices") or (plan.get("capabilities", {}).get("cfgutil") or {}).get("devices")) and not plan.get("device") and not plan.get("cfg_device"):
                    ready = False
                else:
                    ready = plan.get("status") != "action_required"
                if ready:
                    break
                devices = plan.get("devices", []) or (plan.get("capabilities", {}).get("cfgutil") or {}).get("devices", [])
                choices = [{"id": d.get("id") or d.get("serial") or d.get("ecid"), "name": d.get("name") or d.get("serial") or d.get("id")} for d in devices]
                portal.update(action="请完成设备授权或选择设备，程序会自动继续", manual_steps=messages(plan) or plan.get("actions", []), devices=choices)
                selected = getattr(portal, "selected_device", None)
                if selected and selected in {d["id"] for d in choices}:
                    portal.selected_device = None
                    opt["device"] = selected
                    item = adapter_factory(name, opt)
                    instances[index] = (name, opt, item)
                    continue
                if portal.stop_requested.is_set() or time.monotonic() >= setup_deadline:
                    raise InventoryError("SETUP_AUTH_TIMEOUT", "Device authorization was not completed")
                time.sleep(1)
            plans.append(plan)
        portal.update(devices=[])
        for (name, opt, item), plan in zip(instances, plans):
            key = identity(plan, name)
            cache_path = root / "verified-devices.json"
            cache = read_json(cache_path) if cache_path.is_file() else {}
            profile_signature = (plan.get("profile") or {}).get("identifier", "")
            cache_identity = name + ":" + str(key) + (":" + profile_signature if profile_signature else "")
            cache_key = hashlib.sha256(cache_identity.encode()).hexdigest() if key else None
            known = bool(cache_key and cache.get(cache_key) == authority["sha256"] and not args.reinstall_ca)
            opt.update(ca_confirmed=known, ca_ready=known)
            item.options.update(ca_confirmed=known, ca_ready=known)
            portal.update(phase="applying", action="正在自动准备代理与测试证书；请同意出现的系统授权", manual_steps=messages(plan))
            state["phase"] = "applying"
            checkpoint()
            # Proxy must be listening before the adapter changes system routing.
            if child is None:
                ready = directory / "capture-ready.json"
                capture_config = directory / "capture-config.json"
                events = directory / "capture.events.jsonl"
                save(capture_config, {"output": str(events), "ready": str(ready), "session_id": directory.name,
                                      "origins": sorted(scope), "attribution": "isolated_session" if args.isolated_device else "unattributed",
                                      "body_limit": 32768})
                sibling = Path(sys.executable).with_name("mitmdump")
                binary = args.mitmdump or (str(sibling) if sibling.is_file() else shutil.which("mitmdump") or "mitmdump")
                command = [binary, "-q", "--mode", "regular", "--listen-host", bind_host, "--listen-port", str(proxy_port),
                           "-s", str(Path(__file__).with_name("setup_canary.py")), "-s", str(Path(__file__).with_name("mitm_addon.py")),
                           "--set", "setup_config=" + str(canary_config), "--set", "confdir=" + authority["directory"],
                           "--set", "connection_strategy=lazy", "--set", "store_streamed_bodies=false"]
                log_path = directory / "proxy.stderr.log"
                with open(os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as log:
                    child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log,
                                             env={**os.environ, "APK_VERIFY_CONFIG": str(capture_config)})
                # psutil observes an interpreter shebang expansion as well.
                import psutil
                time.sleep(.05)
                process = psutil.Process(child.pid)
                state["proxy_process"] = {"pid": child.pid, "command": process.cmdline(), "create_time": process.create_time()}
                state["events"] = str(events)
                checkpoint()
                deadline = time.monotonic() + 20
                while not ready.is_file():
                    if child.poll() is not None:
                        raise InventoryError("PROXY_START_FAILED", "Capture proxy could not start")
                    if time.monotonic() >= deadline:
                        raise InventoryError("PROXY_READY_TIMEOUT", "Capture proxy did not become ready")
                    time.sleep(.1)
            try:
                receipt = item.apply()
            except BaseException as error:
                interrupted_state = getattr(error, "state", None) or getattr(item, "state", None)
                if interrupted_state:
                    state["receipts"].append({"target": name, "options": opt, "state": interrupted_state})
                    checkpoint()
                raise
            state["receipts"].append({"target": name, "options": opt, "state": receipt, "cache_key": cache_key})
            checkpoint()
            if opt.get("artifact") and name in {"ios", "ios-simulator"} and receipt.get("app", {}).get("installed") is not True:
                raise InventoryError("APP_INSTALL_NOT_CONFIRMED", "本次 App 未确认安装成功，已停止以免采集旧版本；请完成签名/设备授权或安装所需 Apple 工具后重试。")
            profile = receipt.get("profile", {}).get("path")
            if profile:
                portal.profile(profile)
            portal.update(manual_steps=messages(receipt))
            if name == "android" and receipt.get("proxy_target"):
                portal.update(proxy=receipt["proxy_target"])
            if name == "android" and receipt.get("device") and known:
                # Reopen the continuing guide after the system installer, even
                # when a reused CA did not need the installer this time.
                with contextlib.suppress(OSError, subprocess.TimeoutExpired):
                    subprocess.run([args.adb, "-s", receipt["device"], "shell", shlex.join(["am", "start", "-a", "android.intent.action.VIEW", "-d", device_url])], capture_output=True, timeout=15)
        state["phase"] = "awaiting_consent"
        checkpoint()
        portal.update(phase="awaiting_consent", action="只需完成首次系统/设备授权，HTTPS 自测成功后自动继续")
        while not ca_result.is_file():
            if getattr(portal, "reinstall_requested", None) and portal.reinstall_requested.is_set():
                raise InventoryError("REINSTALL_CA_REQUESTED", "正在重新打开本项目证书/配置的系统授权")
            if target == "ios" and getattr(portal, "wifi_requested", None) and portal.wifi_requested.is_set():
                portal.wifi_requested.clear()
                if len(state.get("profile_history", [])) >= 8:
                    portal.update(error="本轮配置更新已达上限，请完成当前配置或结束后重试。")
                    continue
                from .setup_ios import build_profile
                selected_ssid = portal.requested_ssid
                options["wifi_ssid"] = selected_ssid
                raw, metadata = build_profile(options)
                profile_path = Path(options["state_dir"]) / (metadata["identifier"] + ".mobileconfig")
                if profile_path.exists():
                    if profile_path.is_symlink() or profile_path.read_bytes() != raw:
                        raise InventoryError("PROFILE_PATH_CONFLICT", "Existing profile output is not owned by this setup")
                else:
                    with os.fdopen(os.open(profile_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stream:
                        stream.write(raw)
                state.setdefault("profile_history", []).append({"target": "ios", "profile": state["receipts"][-1]["state"].get("profile", {})})
                metadata["path"] = str(profile_path)
                state["receipts"][-1]["state"]["profile"] = metadata
                state["receipts"][-1]["state"]["profile_history"] = [entry["profile"] for entry in state["profile_history"]]
                save(Path(options["state_dir"]) / "ios-state.json", state["receipts"][-1]["state"])
                portal.profile(profile_path)
                portal.update(wifi_ssid=selected_ssid, manual_steps=["请在手机点击安装更新后的配置描述文件；Wi-Fi 密码只在设备系统界面输入。"])
                checkpoint()
            if child.poll() is not None:
                raise InventoryError("PROXY_EXITED", "Capture proxy stopped before verification")
            if portal.stop_requested.is_set():
                raise InventoryError("SETUP_STOPPED", "Setup was stopped before HTTPS verification")
            if time.monotonic() >= setup_deadline:
                raise InventoryError("CA_CONFIRMATION_TIMEOUT", "HTTPS verification has not passed; finish the displayed trust/proxy steps")
            time.sleep(.2)
        proof = read_json(ca_result)
        if proof.get("session_id") != directory.name or not proof.get("ok"):
            raise InventoryError("CA_PROOF_INVALID", "HTTPS proof does not match this session")
        state["https_verification"] = proof
        state["phase"] = "capturing"
        state["capture_started_at"] = time.time()
        cache_path = root / "verified-devices.json"
        cache = read_json(cache_path) if cache_path.is_file() else {}
        for entry in state["receipts"]:
            if entry.get("cache_key"):
                cache[entry["cache_key"]] = authority["sha256"]
        save(cache_path, cache)
        remaining = []
        for (_, _, item), entry in zip(instances, state["receipts"]):
            entry["launch"] = item.launch(entry["state"])
            if entry["launch"].get("status") == "action_required":
                remaining.append(entry["launch"].get("message", "请在选定设备打开目标 App。"))
        checkpoint()
        portal.update(phase="capturing", action="HTTPS 自测通过，正在采集", manual_steps=remaining)
        deadline = time.monotonic() + args.duration
        while time.monotonic() < deadline and not portal.stop_requested.wait(.2):
            if child.poll() is not None:
                raise InventoryError("PROXY_EXITED", "Capture proxy stopped during the session")
        state["capture_completed"] = True
    except KeyboardInterrupt:
        failure = {"code": "SETUP_INTERRUPTED", "message": "Session interrupted; owned settings are being restored"}
    except Exception as error:
        failure = {"code": getattr(error, "code", "SETUP_FAILED"), "message": str(error)[:800] if getattr(error, "code", None) else "Setup could not be completed; see the session report"}
    finally:
        handlers = {name: signal.getsignal(name) for name in (signal.SIGINT, signal.SIGTERM)}
        for name in handlers:
            signal.signal(name, signal.SIG_IGN)
        portal.pac_active = False
        cleanup = cleanup_state(state, adapter_factory=adapter_factory)
        if child:
            if child.poll() is None:
                child.send_signal(signal.SIGINT)
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.terminate()
                    try:
                        child.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=2)
                cleanup["proxy_process"] = "stopped_via_live_handle"
        if not cleanup_complete(state) and failure is None:
            failure = {"code": "CLEANUP_INCOMPLETE", "message": "Some settings need the recovery action shown in the session report"}
        state["phase"] = "failed" if failure else "finished"
        state["error"] = failure
        checkpoint()
        for name, handler in handlers.items():
            signal.signal(name, handler)
        interactive_retry = failure and not args.no_open and failure["code"] not in {"SETUP_STOPPED", "SETUP_INTERRUPTED", "REINSTALL_CA_REQUESTED"}
        portal.update(phase="failed" if interactive_retry else "finished", error=(failure or {}).get("message", ""),
                      action="会话结束，已执行本轮恢复", cleanup_summary=cleanup_message(cleanup))
        if interactive_retry:
            portal.update(action="准备未完成；处理页面提示后点击“重试准备”，当前代理恢复已执行。")
            retry_deadline = time.monotonic() + args.setup_timeout
            try:
                while time.monotonic() < retry_deadline and not portal.stop_requested.wait(.2):
                    if portal.retry_requested.is_set() or portal.reinstall_requested.is_set():
                        failure = {"code": "SETUP_RETRY_REQUESTED", "message": "重新检查环境与设备授权"}
                        state["error"] = failure
                        checkpoint()
                        break
            except KeyboardInterrupt:
                failure = {"code": "SETUP_INTERRUPTED", "message": "环境恢复后结束了重试等待。"}
                state["error"] = failure
                checkpoint()
        time.sleep(args.finish_grace)
        portal.close()
        print("恢复/清理：" + shlex.join(["./capture-setup.sh", "--cleanup", str(state_path)]), file=sys.stderr)
        print("移除本项目 CA：" + shlex.join(["./capture-setup.sh", "--cleanup", str(state_path), "--remove-ca"]), file=sys.stderr)
    if state.get("capture_completed") and state.get("inventory") and args.artifact and target != "macos":
        from .reconcile import finalize_inventory, iter_jsonl
        try:
            state["verification"] = finalize_inventory(Path(state["inventory"]), args.artifact, iter_jsonl(Path(state["events"])),
                                                        session_id=directory.name, allowed_origins=scope,
                                                        source_kind="apk" if target == "android" else "ios", promote=failure is None,
                                                        extra_report={"capture_backend": "capture_setup", "setup_cleanup": state["cleanup"],
                                                                      "https_evidence_scope": "selected_browser_proxy_and_tls_path"})
        except Exception as error:
            failure = {"code": getattr(error, "code", "VERIFICATION_FAILED"), "message": "环境已恢复，但清单验证合并未完成；原清单指针保留。"}
            state.update(phase="failed", error=failure)
        checkpoint()
    return {"ok": failure is None, "target": target, "state": str(state_path), "report": str(latest),
            "https_verified": bool(state.get("https_verification")), "cleanup": state["cleanup"],
            **({"error": failure} if failure else {}), **({"verification": state["verification"]} if "verification" in state else {})}


def parser():
    result = argparse.ArgumentParser(description="Prepare macOS/iOS/Android capture with a local guided approval page")
    result.add_argument("artifact", nargs="?", type=Path)
    result.add_argument("--target", choices=["auto", "macos", "android", "ios", "ios-simulator"], default="auto")
    result.add_argument("--device")
    result.add_argument("--bundle-id")
    result.add_argument("--state-root", type=Path, default=Path(".capture-setup"))
    result.add_argument("--inventory", type=Path)
    result.add_argument("--scope", type=Path)
    result.add_argument("--ca-dir", type=Path)
    result.add_argument("--proxy", type=int, default=8080)
    result.add_argument("--proxy-host")
    result.add_argument("--portal-port", type=int, default=8766)
    result.add_argument("--service")
    result.add_argument("--wifi-ssid")
    result.add_argument("--supervised", action="store_true")
    result.add_argument("--duration", type=parse_duration, default=300.)
    result.add_argument("--setup-timeout", type=parse_duration, default=900.)
    result.add_argument("--mitmdump")
    result.add_argument("--adb", default="adb")
    result.add_argument("--no-open", action="store_true")
    result.add_argument("--reinstall-ca", action="store_true")
    result.add_argument("--isolated-device", action="store_true")
    result.add_argument("--dry-run", action="store_true")
    result.add_argument("--interactive", action="store_true")
    result.add_argument("--cleanup", type=Path, help="Restore a saved session receipt, without starting a new session")
    result.add_argument("--recover-only", action="store_true", help=argparse.SUPPRESS)
    result.add_argument("--remove-ca", action="store_true")
    result.add_argument("--finish-grace", type=float, default=2., help=argparse.SUPPRESS)
    result.add_argument("--lock-file", type=Path, help=argparse.SUPPRESS)
    return result


def interactive(args):
    if sys.platform != "darwin":
        return
    if args.target == "auto":
        script = 'set answer to choose from list {"macOS", "Android", "iPhone / iPad", "iOS Simulator"} with prompt "选择测试平台；系统授权后将自动继续" default items {"macOS"}\nif answer is false then return "cancel"\nreturn item 1 of answer'
        value = subprocess.run(["osascript", "-e", script], capture_output=True, text=True).stdout.strip()
        targets = {"macOS": "macos", "Android": "android", "iPhone / iPad": "ios", "iOS Simulator": "ios-simulator"}
        if value not in targets:
            raise InventoryError("SETUP_CANCELLED", "No setup target was selected")
        args.target = targets[value]
    if not args.artifact:
        script = 'try\nreturn POSIX path of (choose file with prompt "选择本地 .apk / .ipa / .app；取消则只准备环境，使用已有 App")\non error number -128\nreturn ""\nend try'
        selected = subprocess.run(["osascript", "-e", script], capture_output=True, text=True).stdout.strip()
        if selected:
            args.artifact = Path(selected)


def main(argv=None):
    args = parser().parse_args(argv)
    if args.remove_ca and not args.cleanup:
        print(json.dumps({"ok": False, "error": {"code": "ARGUMENT_INVALID", "message": "--remove-ca requires --cleanup and an owned session receipt"}}))
        return 2
    if not 1 <= args.proxy <= 65535 or not 0 <= args.portal_port <= 65535 or not 0 <= args.finish_grace <= 10:
        print(json.dumps({"ok": False, "error": {"code": "ARGUMENT_INVALID", "message": "Invalid proxy/portal port"}}))
        return 2
    old = signal.getsignal(signal.SIGTERM)
    def terminate(*_):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, terminate)
    try:
        if args.dry_run:
            summary = {"ok": True, "dry_run": True, "target": select_target(args.target, args.artifact, args.adb),
                       "actions": ["reuse_project_ca", "open_guided_approval", "configure_owned_proxy", "verify_browser_https", "restore_owned_settings"],
                       "system_settings_changed": False, "state_created": False}
        else:
            if args.interactive:
                interactive(args)
            with SessionLock(args.lock_file):
                if args.cleanup:
                    state = load_receipt(args.cleanup)
                    result = cleanup_state(state, remove_ca=args.remove_ca)
                    summary = {"ok": cleanup_complete(state), "cleanup": result}
                    state["phase"] = "finished" if summary["ok"] else "failed"
                    save_recovery(args.cleanup, state)
                elif args.recover_only:
                    latest = args.state_root.expanduser().resolve() / "latest.json"
                    if latest.is_file():
                        state = load_receipt(latest)
                        session_path = Path(state.get("state_path", ""))
                        expected = latest.parent / "sessions" / str(state.get("session_id", "")) / "session.json"
                        if session_path == expected and session_path.is_file():
                            state = load_receipt(session_path)
                        if not cleanup_complete(state):
                            cleanup_state(state)
                            state["phase"] = "finished" if cleanup_complete(state) else "failed"
                            save_recovery(latest, state)
                        summary = {"ok": cleanup_complete(state), "recovery_only": True, "cleanup": state.get("cleanup")}
                    else:
                        summary = {"ok": True, "recovery_only": True, "cleanup": "not_needed"}
                else:
                    summary = run_setup(args)
                    # A portal retry first restores the old session, then starts
                    # a fresh transaction so proxy snapshots are never replaced.
                    while summary.get("error", {}).get("code") in {"REINSTALL_CA_REQUESTED", "SETUP_RETRY_REQUESTED"}:
                        if summary["error"]["code"] == "REINSTALL_CA_REQUESTED":
                            args.reinstall_ca = True
                        summary = run_setup(args)
        print(json.dumps(summary, ensure_ascii=False, allow_nan=False))
        return 0 if summary["ok"] else 130 if summary.get("error", {}).get("code") == "SETUP_INTERRUPTED" else 6
    except (InventoryError, OSError, ValueError, TypeError) as error:
        print(json.dumps({"ok": False, "error": {"code": getattr(error, "code", "SETUP_FAILED"),
                                                    "message": str(error) if isinstance(error, InventoryError) else "Setup input or runtime could not be processed"}}, ensure_ascii=False))
        return 2
    except KeyboardInterrupt:
        print(json.dumps({"ok": False, "error": {"code": "SETUP_INTERRUPTED", "message": "Setup was interrupted"}}))
        return 130
    finally:
        signal.signal(signal.SIGTERM, old)


if __name__ == "__main__":
    raise SystemExit(main())
