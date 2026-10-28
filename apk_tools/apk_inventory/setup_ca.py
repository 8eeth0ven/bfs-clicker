"""Project-local CA bootstrap. Only public certificate bytes leave this module."""
from __future__ import annotations

import os
from pathlib import Path

from .common import InventoryError


def ensure_authority(directory: str | Path) -> dict:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from mitmproxy.certs import CertStore

    directory = Path(directory).expanduser()
    if directory.is_symlink():
        raise InventoryError("SETUP_PATH_INVALID", "CA directory cannot be a symlink")
    if directory.is_dir() and any(directory.iterdir()) and not (directory / "mitmproxy-ca.pem").is_file():
        raise InventoryError("SETUP_PATH_INVALID", "Choose an empty dedicated CA directory or an existing mitmproxy authority")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory, 0o700)
    for child in directory.iterdir():
        if child.is_symlink():
            raise InventoryError("SETUP_PATH_INVALID", "CA files cannot be symlinks")
    private = directory / "mitmproxy-ca.pem"
    if not private.exists():
        CertStore.create_store(directory, "mitmproxy", 2048, organization="bfs-clicker local testing", cn="bfs-clicker Test CA")
    store = CertStore.from_store(directory, "mitmproxy", 2048)
    public = directory / "mitmproxy-ca-cert.pem"
    raw = public.read_bytes()
    if b"PRIVATE KEY" in raw or len(raw) > 65536:
        raise InventoryError("CA_INVALID", "CA download must contain a public certificate only")
    cert = x509.load_pem_x509_certificate(raw)
    signing_ca = x509.load_pem_x509_certificate(store.default_ca.to_pem())
    if cert.public_bytes(serialization.Encoding.DER) != signing_ca.public_bytes(serialization.Encoding.DER):
        raise InventoryError("CA_MISMATCH", "Public CA does not match the proxy's signing authority")
    if not cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
        raise InventoryError("CA_INVALID", "Expected a CA certificate")
    # DER is preferred by profile payloads and Android's certificate installer.
    der_path = directory / "bfs-clicker-ca.cer"
    der_path.write_bytes(cert.public_bytes(serialization.Encoding.DER))
    generated = {"mitmproxy-ca.pem", "mitmproxy-ca.p12", "mitmproxy-ca-cert.pem", "mitmproxy-ca-cert.cer", "mitmproxy-ca-cert.p12", "mitmproxy-dhparam.pem", "bfs-clicker-ca.cer", "macos-ca-ownership.json"}
    for child in directory.iterdir():
        if child.is_file() and child.name in generated:
            os.chmod(child, 0o600)
    return {"directory": str(directory.resolve()), "certificate": str(public.resolve()),
            "der_certificate": str(der_path.resolve()), "sha256": cert.fingerprint(hashes.SHA256()).hex(),
            "label": "bfs-clicker Test CA"}
