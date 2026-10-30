"""Opt-in, hash-bound shell-only IME transport; never selects or installs an IME."""
import base64
import hashlib
import re
import uuid

COMPONENT = 'com.bfs.mcp.ime/.UnicodeIme'
ACTION = 'com.bfs.mcp.ime.COMMIT'

def validate(config, error):
    if config is None:
        return None
    if not isinstance(config, dict) or set(config) != {'component', 'apkSha256'} or config['component'] != COMPONENT or not isinstance(config['apkSha256'], str) or not re.fullmatch('[a-f0-9]{64}', config['apkSha256']):
        raise error('UNICODE_IME_CONFIG_INVALID', 'blocked')
    return dict(config)

def preflight(backend):
    config = backend.unicode_input
    package = COMPONENT.split('/')[0]
    located = backend.shell('pm', 'path', package).splitlines()
    if len(located) != 1 or not located[0].startswith('package:'):
        raise backend.unicode_error('UNICODE_IME_ARTIFACT_UNVERIFIED', 'blocked')
    remote = located[0][8:]
    if not re.fullmatch(r'/data/app/[A-Za-z0-9_~.+/=-]+/base\.apk', remote) or '..' in remote.split('/'):
        raise backend.unicode_error('UNICODE_IME_ARTIFACT_UNVERIFIED', 'blocked')
    hashed = backend.shell('sha256sum', remote)
    if not re.fullmatch(re.escape(config['apkSha256']) + r'[ \t]+\*?' + re.escape(remote), hashed):
        raise backend.unicode_error('UNICODE_IME_ARTIFACT_MISMATCH', 'blocked')
    if backend.shell('settings', 'get', 'secure', 'default_input_method') != COMPONENT:
        raise backend.unicode_error('UNICODE_IME_NOT_SELECTED', 'blocked')
    if backend.shell('pm', 'path', package).splitlines() != located:
        raise backend.unicode_error('UNICODE_IME_ARTIFACT_UNVERIFIED', 'blocked')

def commit(backend, value, replace, append_at=0):
    nonce = uuid.uuid4().hex
    encoded = base64.b64encode(value.encode('utf-8')).decode('ascii')
    args = ('am', 'broadcast', '--receiver-foreground', '-a', ACTION, '-p', COMPONENT.split('/')[0], '--es', 'nonce', nonce, '--es', 'app', backend.app_id, '--es', 'data', encoded, '--ez', 'replace', str(replace).lower(), '--ei', 'appendAt', str(append_at))
    callback = getattr(backend, '_before_workflow_ui_command', None)
    if callback:
        callback()
    # This command may have changed the input even if its acknowledgement is lost.
    # Do not retry, including after an ADB transport exception.
    reply = backend.shell(*args)
    expected = 'BFS_IME:' + nonce + ':' + hashlib.sha256(value.encode('utf-8')).hexdigest()
    if not re.search(r'Broadcast completed: result=-1, data="' + re.escape(expected) + r'"(?:,|$)', reply):
        raise backend.unicode_error('UNICODE_IME_RESULT_UNKNOWN', 'failed')
