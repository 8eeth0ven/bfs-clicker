"""Owned W3C state machine, real local business POST; no physical device claim."""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import html
import json
import re
import threading
from urllib.request import Request, urlopen

APP = 'com.example.stages'


@contextmanager
def stage_app(platform='ios'):
    state = {'page': 'first', 'generation': 0, 'first': '', 'second': '', 'enabled': False,
             'mode': 'closed', 'result': '', 'business': [], 'calls': [], 'wrongEcho': False,
             'foreground': APP, 'duplicateOption': False, 'unknownSelection': False,
             'freezeResult': False, 'disconnectSearch': False, 'nextCount': 0, 'searchCount': 0}
    identify = lambda name: {'resourceId': APP + ':id/' + name} if platform == 'android' else {'accessibilityId': name}

    def source():
        def node(name, kind, text='', children='', **attrs):
            text = html.escape(str(text), quote=True)
            if platform == 'android':
                classes = {'form': 'android.widget.LinearLayout', 'type': 'android.widget.EditText', 'button': 'android.widget.Button', 'check': 'android.widget.Switch', 'select': 'android.widget.RadioGroup', 'option': 'android.widget.RadioButton', 'output': 'android.widget.TextView'}
                extra = ' '.join(k + '="' + html.escape(str(v), quote=True) + '"' for k, v in attrs.items())
                return '<node package="' + APP + '" resource-id="' + APP + ':id/' + name + '" class="' + classes[kind] + '" text="' + text + '" enabled="true" visible="true" bounds="[0,0][160,40]" clickable="' + str(kind in {'button','check','option'}).lower() + '" ' + extra + '>' + children + '</node>'
            classes = {'form': 'XCUIElementTypeOther', 'type': 'XCUIElementTypeTextField', 'button': 'XCUIElementTypeButton', 'check': 'XCUIElementTypeSwitch', 'select': 'XCUIElementTypeSegmentedControl', 'option': 'XCUIElementTypeButton', 'output': 'XCUIElementTypeStaticText'}
            extra = ' '.join(k + '="' + html.escape(str(v), quote=True) + '"' for k, v in attrs.items())
            return '<' + classes[kind] + ' type="' + classes[kind] + '" name="' + name + '" label="' + (name if kind == 'type' else text) + '" enabled="true" visible="true" x="0" y="0" width="160" height="40" ' + extra + '>' + children + '</' + classes[kind] + '>'
        def field(name):
            value = state[name] + ('-wrong' if state['wrongEcho'] and state[name] else '')
            return node(name, 'type', value if platform == 'android' else '', **({} if platform == 'android' else {'value': value}))
        if state['page'] == 'first':
            body = node('first_form', 'form', children=field('first') + node('next', 'button', 'Next' + (' ' + state['first'] if state.get('reflectButton') else '')))
        elif state['page'] == 'details':
            options = ''
            for name in ['open', 'closed'] + (['open'] if state['duplicateOption'] else []):
                selected = name == state['mode']
                options += node(name, 'option', name, **({'checkable': 'true', 'checked': 'mixed' if state['unknownSelection'] else str(selected).lower()} if platform == 'android' else {'selected': 'mixed' if state['unknownSelection'] else str(selected).lower()}))
            check = node('enabled', 'check', 'Enabled', **({'checkable': 'true', 'checked': str(state['enabled']).lower()} if platform == 'android' else {'value': str(int(state['enabled']))}))
            body = node('details_form', 'form', children=field('second') + check + node('mode', 'select', children=options) + node('search', 'button', 'Search'))
        else:
            body = node('result' + ('_' + state['first'] if state.get('reflectResultId') else ''), 'button' if state.get('resultControl') else 'output', state['result'])
        return '<hierarchy>' + body + '</hierarchy>' if platform == 'android' else '<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication">' + body + '</XCUIElementTypeApplication></AppiumAUT>'

    def visible():
        return {'first', 'next'} if state['page'] == 'first' else {'second', 'enabled', 'mode', 'open', 'closed', 'search'} if state['page'] == 'details' else {'result'}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            self.command_body()

        def do_POST(self):
            self.command_body()

        def reply(self, value, status=200):
            raw = json.dumps({'value': value}).encode()
            self.send_response(status)
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def command_body(self):
            raw = self.rfile.read(int(self.headers.get('Content-Length', '0')))
            body = json.loads(raw) if raw else {}
            state['calls'].append((self.command, self.path, body))
            if self.path == '/business/search':
                state['business'].append(body)
                return self.reply({'text': 'RESULT ' + body['first'] + ' / ' + body['second'] + ' / ' + str(body['enabled']).lower() + ' / ' + body['mode']})
            route = self.path.removeprefix('/session/stages')
            if route == '/source':
                return self.reply(source())
            if route == '/appium/device/current_package':
                return self.reply(state['foreground'])
            if route == '/execute/sync':
                return self.reply({'bundleId': state['foreground']})
            if route == '/elements':
                assert body['using'] == 'xpath' and body['value'].startswith('//*[')
                requested = {a or b for a, b in re.findall(r"@(?:resource-id|resourceId|content-desc|name)=(?:'([^']*)'|\"([^\"]*)\")", body['value'])}
                matches = [name for name in visible() if name in requested or APP + ':id/' + name in requested]
                return self.reply([{'element-6066-11e4-a52e-4f735466cecf': str(state['generation']) + '_' + name} for name in matches])
            if route == '/back':
                state['generation'] += 1
                state['page'] = 'details' if state['page'] == 'result' else 'first'
                if state['page'] == 'first':
                    state.update(first='', second='', enabled=False, mode='closed', result='')
                return self.reply(None)
            match = re.fullmatch(r'/element/(\d+)_([A-Za-z]+)/([^/]+)', route)
            if match:
                generation, name, command = match.groups()
                if int(generation) != state['generation'] or name not in visible():
                    return self.reply({'error': 'stale element reference'}, 404)
                if command == 'clear' and name in {'first', 'second'}:
                    state[name] = ''
                elif command == 'value' and name in {'first', 'second'}:
                    state[name] += body['text']
                    if name == 'second' and state.get('rewriteModeOnSecond'):
                        state['mode'] = 'closed'
                elif command == 'click' and name == 'next':
                    state['nextCount'] += 1
                    state.update(page='details', generation=state['generation'] + 1)
                elif command == 'click' and name == 'enabled':
                    state['enabled'] = not state['enabled']
                elif command == 'click' and name in {'open', 'closed'}:
                    state['mode'] = name
                elif command == 'click' and name == 'search':
                    state['searchCount'] += 1
                    values = {key: state[key] for key in ['first', 'second', 'enabled', 'mode']}
                    with urlopen(Request(state['url'] + '/business/search', data=json.dumps(values).encode(), headers={'Content-Type': 'application/json'}), timeout=3) as response:
                        reply = json.load(response)['value']
                    state.update(page='result', generation=state['generation'] + 1)
                    state['result'] = 'RESULT constant' if state['freezeResult'] else reply['text']
                    if state.get('resultControlAfterSearch') == state['searchCount']:
                        state['resultControl'] = True
                    if state['disconnectSearch']:
                        self.connection.shutdown(2)
                        self.connection.close()
                        return
                else:
                    return self.reply({'error': 'unknown command'}, 404)
                return self.reply(None)
            return self.reply({'error': 'unknown command'}, 404)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    state['url'] = 'http://127.0.0.1:' + str(server.server_port)
    state['source'] = source
    state['identify'] = identify
    fields = [('type', 'first', 'seed-first'), ('type', 'second', 'seed-second'), ('check', 'enabled', True), ('select', 'mode', 'open')]
    allow = [{'kind': kind, 'selector': identify(name), 'effect': 'read'} for kind, name, _ in fields]
    allow += [{'kind': 'click', 'selector': identify(name), 'effect': 'read'} for name in ['next', 'search']]
    allow += [{'kind': 'check', 'selector': identify(name), 'effect': 'read'} for name in ['open', 'closed']]
    state['config'] = {'source': {'id': 'stage_fixture', 'kind': 'apk' if platform == 'android' else 'ios'},
                       'backend': {'type': 'webdriver', 'platform': platform, 'url': state['url'], 'sessionId': 'stages', 'appId': APP},
                       'limits': {'maxActions': 60, 'maxDepth': 5, 'maxDurationMs': 30000}, 'actionAllowlist': allow,
                       'nativeStagePlanning': {'workflowId': 'native_lookup', 'seedInputs': [{'kind': kind, 'selector': identify(name), 'value': value} for kind, name, value in fields]}}
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(2)
