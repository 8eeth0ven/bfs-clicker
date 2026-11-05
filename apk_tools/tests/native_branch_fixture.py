"""Owned two-arm W3C app with independent local business submissions."""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import html
import json
import re
import threading
from urllib.request import Request, urlopen

APP = 'com.example.branches'


@contextmanager
def branch_app(platform='ios', fork_kind='select'):
    if fork_kind not in {'select', 'check'}:
        raise ValueError('Unsupported fixture fork kind')
    route_value = lambda arm: arm == 'right' if fork_kind == 'check' else arm
    state = {'page': 'first', 'generation': 0, 'query': '', 'detail': '', 'route': route_value('left'),
             'result': '', 'business': [], 'calls': [], 'context': 'NATIVE_APP',
             'foreground': APP, 'nextCount': 0, 'searchCount': 0}
    identify = lambda name: {'resourceId': APP + ':id/' + name} if platform == 'android' else {'accessibilityId': name}

    def node(name, kind, text='', children='', **attrs):
        text = html.escape(str(text), quote=True)
        extra = ' '.join(key + '="' + html.escape(str(value), quote=True) + '"' for key, value in attrs.items())
        if platform == 'android':
            classes = {'form': 'android.widget.LinearLayout', 'type': 'android.widget.EditText',
                       'button': 'android.widget.Button', 'select': 'android.widget.RadioGroup', 'check': 'android.widget.Switch',
                       'option': 'android.widget.RadioButton', 'output': 'android.widget.TextView'}
            return ('<node package="' + APP + '" resource-id="' + APP + ':id/' + name + '" class="' + classes[kind] +
                    '" text="' + text + '" enabled="true" visible="true" bounds="[0,0][160,40]" clickable="' +
                    str(kind in {'button', 'option', 'check'}).lower() + '" ' + extra + '>' + children + '</node>')
        classes = {'form': 'XCUIElementTypeOther', 'type': 'XCUIElementTypeTextField',
                   'button': 'XCUIElementTypeButton', 'select': 'XCUIElementTypeSegmentedControl', 'check': 'XCUIElementTypeSwitch',
                   'option': 'XCUIElementTypeButton', 'output': 'XCUIElementTypeStaticText'}
        return ('<' + classes[kind] + ' type="' + classes[kind] + '" name="' + name + '" label="' +
                (name if kind == 'type' else text) + '" enabled="true" visible="true" x="0" y="0" width="160" height="40" ' +
                extra + '>' + children + '</' + classes[kind] + '>')

    def field(name, slot):
        value = state[slot] + ('-wrong' if state.get('wrongEcho') and state[slot] else '')
        return node(name, 'type', value if platform == 'android' else '',
                    **({} if platform == 'android' else {'value': value}))

    def details(arm):
        name = 'detail' if arm == 'left' else 'alternate_detail'
        return node(arm + '_form', 'form', children=field(name, 'detail') + node(arm + '_search', 'button', 'Search ' + arm))

    def source():
        if state['page'] == 'first':
            options = ''
            for value in ['left', 'right'] + (['left'] if state.get('duplicateOption') else []) + (['third'] if state.get('thirdOption') else []):
                selected = value == state['route']
                attrs = ({'checkable': 'true', 'checked': str(selected).lower()} if platform == 'android'
                         else {'selected': str(selected).lower()})
                options += node(value, 'option', value, **attrs)
            fork = (node('route', 'check', 'Route', **({'checkable': 'true', 'checked': str(state['route']).lower()} if platform == 'android' else {'value': str(int(state['route']))}))
                    if fork_kind == 'check' else node('route', 'select', children=options))
            body = node('entry_form', 'form', children=field('query', 'query') + fork + node('next', 'button', 'Next'))
        elif state['page'] in {'left', 'right'}:
            body = details(state['page'])
            if state.get('ambiguousBranch'):
                body = details('left') + details('right')
        elif state['page'] in {'left_result', 'right_result'}:
            body = node('common_result' if state.get('commonTerminal') else state['page'], 'button' if state.get('resultControl') else 'output', state['result'])
        else:
            body = node('unknown_result', 'output', 'Unknown screen')
        xml = ('<hierarchy>' + body + '</hierarchy>' if platform == 'android' else
               '<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication">' + body + '</XCUIElementTypeApplication></AppiumAUT>')
        transform = state.get('sourceTransform')
        return transform(xml) if transform else xml

    def visible():
        if state['page'] == 'first':
            return {'query', 'route', 'next'} | ({'left', 'right'} if fork_kind == 'select' else set()) | ({'third'} if state.get('thirdOption') else set())
        if state['page'] == 'left':
            return {'detail', 'left_search'}
        if state['page'] == 'right':
            return {'alternate_detail', 'right_search'}
        return {'common_result' if state.get('commonTerminal') else state['page']} if state['page'] in {'left_result', 'right_result'} else {'unknown_result'}

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
                return self.reply({'text': 'RESULT ' + body['query'] + ' / ' + body['detail'] + ' / ' + str(body['route']).lower() + ' ;COUNT:' + str(len(state['business']))})
            route = self.path.removeprefix('/session/branches')
            if route == '/source':
                return self.reply(source())
            if route == '/context':
                return self.reply(state['context'])
            if route == '/appium/device/current_package':
                return self.reply(state['foreground'])
            if route == '/execute/sync':
                return self.reply({'bundleId': state['foreground']})
            if route == '/elements':
                assert body['using'] == 'xpath' and body['value'].startswith('//*[')
                wanted = {a or b for a, b in re.findall(r"@(?:resource-id|resourceId|content-desc|name)=(?:'([^']*)'|\"([^\"]*)\")", body['value'])}
                matches = [name for name in visible() if name in wanted or APP + ':id/' + name in wanted]
                return self.reply([{'element-6066-11e4-a52e-4f735466cecf': str(state['generation']) + '_' + name} for name in matches])
            if route == '/back':
                state['generation'] += 1
                if state['page'] in {'left_result', 'right_result'}:
                    state['page'] = state['page'].removesuffix('_result')
                else:
                    state.update(page='first', query='', detail='', route=route_value('left'), result='')
                return self.reply(None)
            match = re.fullmatch(r'/element/(\d+)_([A-Za-z_]+)/([^/]+)', route)
            if match:
                generation, name, command = match.groups()
                if int(generation) != state['generation'] or name not in visible():
                    return self.reply({'error': 'stale element reference'}, 404)
                slot = 'query' if name == 'query' else 'detail'
                if command == 'clear' and name in {'query', 'detail', 'alternate_detail'}:
                    state[slot] = ''
                elif command == 'value' and name in {'query', 'detail', 'alternate_detail'}:
                    state[slot] += body['text']
                elif command == 'click' and name in {'left', 'right'}:
                    state['route'] = name
                elif command == 'click' and name == 'route' and fork_kind == 'check':
                    state['route'] = not state['route']
                elif command == 'click' and name == 'next':
                    state['nextCount'] += 1
                    actual = ('right' if state['route'] else 'left') if fork_kind == 'check' else state['route']
                    if state.get('wrongRoute'):
                        actual = 'right' if actual == 'left' else 'left'
                    state.update(page='unknown' if state.get('unknownBranch') else actual, generation=state['generation'] + 1)
                    if state.get('contextAfterNext'):
                        state['context'] = state['contextAfterNext']
                    if state.get('disconnectNext'):
                        self.connection.shutdown(2)
                        self.connection.close()
                        return
                elif command == 'click' and name in {'left_search', 'right_search'}:
                    state['searchCount'] += 1
                    values = {key: state[key] for key in ['query', 'detail', 'route']}
                    with urlopen(Request(state['url'] + '/business/search', data=json.dumps(values).encode(), headers={'Content-Type': 'application/json'}), timeout=3) as response:
                        reply = json.load(response)['value']
                    state.update(page=state['page'] + '_result', generation=state['generation'] + 1)
                    state['result'] = 'RESULT constant' if state.get('freezeResult') else reply['text']
                    if state.get('resultControlAfterSearch') == state['searchCount']:
                        state['resultControl'] = True
                    if state.get('disconnectSearch'):
                        self.connection.shutdown(2)
                        self.connection.close()
                        return
                else:
                    return self.reply({'error': 'unknown command'}, 404)
                return self.reply(None)
            return self.reply({'error': 'unknown command'}, 404)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    state['url'] = 'http://127.0.0.1:' + str(server.server_port)
    state['source'], state['identify'] = source, identify
    seeds = lambda arm: [{'kind': 'type', 'selector': identify('query'), 'value': 'seed-query'},
                         {'kind': fork_kind, 'selector': identify('route'), 'value': route_value(arm)},
                         {'kind': 'type', 'selector': identify('detail' if arm == 'left' else 'alternate_detail'), 'value': 'seed-' + arm + '-detail'}]
    actions = [('type', 'query'), (fork_kind, 'route'), ('type', 'detail'), ('type', 'alternate_detail'),
               ('check', 'left'), ('check', 'right'), ('click', 'next'), ('click', 'left_search'), ('click', 'right_search')]
    state['config'] = {'source': {'id': 'branch_fixture', 'kind': 'apk' if platform == 'android' else 'ios'},
                       'backend': {'type': 'webdriver', 'platform': platform, 'url': state['url'], 'sessionId': 'branches', 'appId': APP},
                       'limits': {'maxActions': 120, 'maxDepth': 5, 'maxDurationMs': 30000},
                       'actionAllowlist': [{'kind': kind, 'selector': identify(name), 'effect': 'read'} for kind, name in actions],
                       'nativeBranchPlanning': {'workflowId': 'branch_lookup', 'forkInput': {'kind': fork_kind, 'selector': identify('route')},
                                                'arms': [{'id': arm, 'value': route_value(arm), 'seedInputs': seeds(arm)} for arm in ['left', 'right']]}}
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(2)
