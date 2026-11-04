"""Private test process wrapper for the shared W3C fixture, JSON-lines control."""
import json
import sys
from native_stage_fixture import stage_app

with stage_app(sys.argv[1]) as app:
    print(json.dumps({'config': app['config']}), flush=True)
    for line in sys.stdin:
        request = json.loads(line)
        if request['action'] == 'quit':
            break
        if request['action'] == 'set':
            app.update(request['values'])
        print(json.dumps({key: app[key] for key in ['business', 'nextCount', 'searchCount', 'calls', 'page']}), flush=True)
