import json,sys
from pathlib import Path
from apk_inventory.mobile_ui import MobileSession,DeviceLease,MobileError
from apk_inventory.mobile_visual import capture_locked
from apk_inventory.mobile_visual_workflow import observe_locked,ground_anchor,region_text,unchanged_locked
args=json.load(sys.stdin);session=MobileSession(args['config'],args['output']);result={}
try:
    try: capture_locked(session,Path(args['output'])/'no-lease',None)
    except MobileError as error: result['withoutLease']=error.code
    with DeviceLease(session.backend) as lease:
        try:
            with DeviceLease(session.backend): pass
        except MobileError as error: result['competingLease']=error.code
        observation=observe_locked(session,lease,Path(args['output'])/'snapshots',node=args['node'],engine={'type':'tesseract'})
        result['tokens']=[token['text'] for token in observation['tokens']]
        contract=ground_anchor(observation,'Search');result['contract']=contract
        result['resultText']=region_text(observation,{'x':.01,'y':.6,'width':.98,'height':.35})
        unchanged_locked(session,lease,Path(args['output'])/'same',observation);result['sameFrame']=True
        try: unchanged_locked(session,lease,Path(args['output'])/'changed',observation)
        except MobileError as error: result['changedFrame']=error.code
    try: capture_locked(session,Path(args['output'])/'expired',lease)
    except MobileError as error: result['expiredLease']=error.code
    print(json.dumps(result,ensure_ascii=False))
finally: session.budget.close() if hasattr(session.budget,'close') else None
