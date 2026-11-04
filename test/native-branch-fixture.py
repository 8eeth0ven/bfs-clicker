"""JSON-lines owner for the local two-arm W3C fixture; no physical device."""
import json
import sys
from native_branch_fixture import branch_app

with branch_app(sys.argv[1]) as app:
    print(json.dumps({'config': app['config']}), flush=True)
    for line in sys.stdin:
        request = json.loads(line)
        if request['action'] == 'quit':
            break
        if request['action'] == 'set':
            app.update(request['values'])
        print(json.dumps({key: app[key] for key in ['business', 'nextCount', 'searchCount', 'calls', 'page', 'context']}), flush=True)
