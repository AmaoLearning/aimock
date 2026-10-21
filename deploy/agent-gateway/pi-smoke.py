#!/usr/bin/env python3
"""在网关所在开发机运行少量真实 pi 会话；不修改任何 dsec suite。"""
import argparse
import concurrent.futures
import datetime
import hashlib
import json
import os
import subprocess
import threading
import time
import uuid
from pathlib import Path

os.umask(0o077)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--concurrency', type=int, default=3)
args = parser.parse_args()
if not 1 <= args.concurrency <= 32:
    parser.error('--concurrency must be between 1 and 32')
HOME_DIR = Path(os.environ.get('AIMOCK_HOME', Path.home()/'.local/share/aimock-gateway'))
APP = Path(__file__).resolve().parent
ROOT = Path(os.environ['AIMOCK_DATA_ROOT'])
NODE = os.environ.get('AIMOCK_NODE_BIN', str(HOME_DIR/'runtime/node-22.22.0-aimock-1.46.0/node_modules/node/bin/node'))
PI = Path(os.environ.get('AIMOCK_PI_CLI', HOME_DIR/'pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'))
if not PI.is_file():
    raise SystemExit('Missing pi 0.81.1: rerun install.sh --with-pi, or set AIMOCK_PI_CLI')
config = json.loads(Path(os.environ['AIMOCK_UPSTREAM_CONFIG']).read_text())
MODEL = config.get('model', config.get('YICLOUD_QWEN_MODEL'))
KEY = Path(os.environ['AIMOCK_CLIENT_KEY_FILE']).read_text().strip()
BASE = os.environ.get('AIMOCK_BASE_URL', 'http://127.0.0.1:'+os.environ.get('AIMOCK_PORT', '4010')).rstrip('/')
STAMP = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
OUT = ROOT/'receipts'/('pi-smoke-'+STAMP+'-'+uuid.uuid4().hex[:6])
OUT.mkdir(parents=True)
tasks = []
for index in range(args.concurrency):
    session = str(uuid.uuid4())
    work = OUT/('agent-'+str(index))
    agent = work/'agent-config'
    agent.mkdir(parents=True)
    source = 'def add(a, b):\n    return a - b\n'
    tests = f'from calc import add\nassert add({index+5},3)=={index+8}\nassert add(-2,2)==0\nprint("PASS_{session}")\n'
    (work/'calc.py').write_text(source)
    (work/'test_calc.py').write_text(tests)
    prompt = f'Session marker {session}. In this directory, read calc.py and test_calc.py using the read tool, fix add using the edit or write tool, and run python3 test_calc.py using bash. Do not edit the tests. Finish with the test result and the session marker. Use only this directory.'
    provider = {'baseUrl':BASE+'/v1','api':'openai-completions','apiKey':'$AIMOCK_SMOKE_KEY',
        'compat':{'supportsDeveloperRole':False,'supportsReasoningEffort':False,'supportsStore':False,
                  'sendSessionAffinityHeaders':True,'maxTokensField':'max_tokens',
                  'requiresReasoningContentOnAssistantMessages':True},
        'models':[{'id':MODEL,'name':'Recorded coding task','reasoning':False,'input':['text'],
                   'contextWindow':40960,'maxTokens':4096,'cost':{'input':0,'output':0,'cacheRead':0,'cacheWrite':0}}]}
    (agent/'models.json').write_text(json.dumps({'providers':{'aimock':provider}},indent=2))
    (agent/'settings.json').write_text(json.dumps({'autoCompaction':False,'retry':{'enabled':False}}))
    tasks.append({'index':index,'session':session,'work':str(work),'source':source,'tests':tests,'prompt':prompt})


def control(action, task):
    return json.loads(subprocess.check_output([NODE,str(APP/'ctl.mjs'),action,'--session',task['session']],text=True))


def run(task, phase):
    work = Path(task['work'])
    agent = work/'agent-config'
    if phase == 'replay':
        manifest = control('export',task)
        model_config = json.loads((agent/'models.json').read_text())
        model_config['providers']['aimock']['baseUrl'] = BASE+'/replay/'+manifest['id']+'/v1'
        model_config['providers']['aimock']['headers'] = {'X-AIMock-Strict':'1'}
        (agent/'models.json').write_text(json.dumps(model_config,indent=2))
        (work/'calc.py').write_text(task['source'])
    sessions = work/(phase+'-sessions')
    sessions.mkdir()
    seed = sessions/'seed.jsonl'
    seed.write_text(json.dumps({'type':'session','version':3,'id':task['session'],
        'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(),'cwd':str(work)})+'\n')
    env = dict(os.environ,PI_CODING_AGENT_DIR=str(agent),AIMOCK_SMOKE_KEY=KEY,PI_OFFLINE='1',
               PATH=str(Path(NODE).parent)+':'+os.environ['PATH'])
    command = [NODE,str(PI),'--provider','aimock','--model',MODEL,'--thinking','off','--mode','json',
        '--print','--no-extensions','--no-skills','--no-context-files','--no-prompt-templates','--no-themes',
        '--session-dir',str(sessions),'--session',str(seed),task['prompt']]
    started = time.time()
    with (work/(phase+'-pi.jsonl')).open('w') as stdout, (work/(phase+'-stderr.log')).open('w') as stderr:
        try: status = subprocess.run(command,cwd=work,env=env,stdout=stdout,stderr=stderr,timeout=240).returncode
        except subprocess.TimeoutExpired: status = 124
    ended = time.time()
    verified = subprocess.run(['python3','test_calc.py'],cwd=work,text=True,capture_output=True)
    source_check = subprocess.run(['python3','-c','import runpy; f=runpy.run_path("calc.py")["add"]; assert f(5,3)==8 and f(-2,2)==0'],cwd=work,capture_output=True)
    tools = []; errors = []; final = ''
    for line in (work/(phase+'-pi.jsonl')).read_text().splitlines():
        try: event = json.loads(line)
        except json.JSONDecodeError: continue
        if event.get('type') == 'tool_execution_start': tools.append(event.get('toolName'))
        if event.get('type') == 'message_end':
            message = event.get('message',{})
            if message.get('errorMessage') or message.get('stopReason') in ('error','aborted'):
                errors.append(message.get('errorMessage',message.get('stopReason')))
            if message.get('role') == 'assistant':
                final = ''.join(c.get('text','') for c in message.get('content',[]) if c.get('type') == 'text')
    tests_unchanged = (work/'test_calc.py').read_text() == task['tests']
    passed = status == 0 and verified.returncode == 0 and source_check.returncode == 0 and tests_unchanged and not errors and {'read','bash'}.issubset(tools) and bool({'edit','write'}.intersection(tools)) and task['session'] in final
    result = {'index':task['index'],'session':task['session'],'phase':phase,'pi_exit':status,
        'verifier_exit':verified.returncode,'source_check_exit':source_check.returncode,'tests_unchanged':tests_unchanged,
        'tools':tools,'errors':errors,'started':started,'ended':ended,'elapsed_s':round(ended-started,3),
        'passed':passed,**({'trace':manifest['id']} if phase == 'replay' else {})}
    (work/(phase+'-result.json')).write_text(json.dumps(result,indent=2))
    print(json.dumps({'phase':phase,'session':task['session'],'passed':passed,'elapsed_s':result['elapsed_s']}),flush=True)
    return result


stop = threading.Event()
def observe():
    previous = None
    with (OUT/'data-changes.jsonl').open('w') as log:
        while not stop.is_set():
            rows = []
            for task in tasks:
                digest = hashlib.sha256(task['session'].encode()).hexdigest()
                for day in (ROOT/'records').glob('*'):
                    for p in (day/digest).glob('*/metadata.json'):
                        m = json.loads(p.read_text())
                        raw = p.parent/'response.raw'
                        rows.append((m['id'],m['complete'],raw.stat().st_size if raw.exists() else 0))
            snapshot = {'records':len(rows),'complete':sum(row[1] for row in rows),'raw_bytes':sum(row[2] for row in rows)}
            if snapshot != previous:
                log.write(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),**snapshot})+'\n'); log.flush()
                previous = snapshot
            stop.wait(.2)


observer = threading.Thread(target=observe,daemon=True)
observer.start()
try:
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        recorded = list(executor.map(lambda task:run(task,'record'),tasks))
    audit = []
    for task in tasks:
        rows = control('list',task)
        isolated = True; history_results = 0
        for row in rows:
            p = ROOT/row['relative']
            request = json.loads((p/'request.json').read_text())
            combined = json.dumps(request)+(p/'response.raw').read_text()
            isolated &= task['session'] in combined and all(other['session'] not in combined for other in tasks if other != task)
            history_results += sum(message['role']=='tool' for message in request['messages'])
        audit.append({'session':task['session'],'recorded_requests':len(rows),'isolated':isolated,
            'tool_results_in_histories':history_results,
            'passed':bool(rows) and all(row['complete'] and row.get('status')==200 for row in rows) and isolated and history_results>0})
    replayed = []
    if all(row['passed'] for row in recorded+audit):
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as executor:
            replayed = list(executor.map(lambda task:run(task,'replay'),tasks))
    unchanged = all(len(control('list',task))==row['recorded_requests'] for task,row in zip(tasks,audit))
finally:
    stop.set(); observer.join(timeout=5)
acceptance = {'aimock':'1.46.0','pi':'0.81.1','base_url':BASE,'model':MODEL,'concurrency':args.concurrency,
    'native_session_headers':True,'strict_replay':True,'records':sum(row['recorded_requests'] for row in audit),
    'recorded':recorded,'audit':audit,'replayed':replayed,'replay_record_count_unchanged':unchanged,
    'passed':len(replayed)==args.concurrency and all(row['passed'] for row in recorded+audit+replayed) and unchanged}
(OUT/'replay-results.json').write_text(json.dumps(replayed,indent=2))
(OUT/'tasks.json').write_text(json.dumps(tasks,indent=2))
(OUT/'acceptance.json').write_text(json.dumps(acceptance,indent=2))
print(json.dumps({'receipt':str(OUT),'passed':acceptance['passed'],'records':acceptance['records']}),flush=True)
raise SystemExit(0 if acceptance['passed'] else 1)
