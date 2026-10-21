#!/usr/bin/env python3
"""审计 pi 录制隔离，再将真实 pi 指向离线回放；只重置本测试创建的 calc.py。"""
import concurrent.futures
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path('/mnt/shared-storage-gpfs2/df4-hicache/aimock-v1')
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else sorted((ROOT/'receipts').glob('pi-smoke-*'))[-1]
RESULTS = json.loads((OUT/'results.json').read_text())
RUNTIME = Path('/opt/aimock/runtime/node_modules')
NODE = RUNTIME/'node/bin/node'
KEY = Path('/etc/aimock/client-key').read_text().strip()


def replay_one(result):
    session = result['session']
    work = Path(result['directory'])
    listed = subprocess.check_output([str(NODE), '/opt/aimock/deploy/ctl.mjs', 'list', '--session', session], text=True)
    records = json.loads(listed)
    assert records and all(row['complete'] for row in records)
    tool_results = 0
    offered = set()
    for row in records:
        request = json.loads((ROOT/row['relative']/'request.json').read_text())
        serialized = json.dumps(request)
        assert session in serialized
        assert all(other['session'] not in serialized for other in RESULTS if other['session'] != session)
        raw_response = (ROOT/row['relative']/'response.raw').read_text()
        assert all(other['session'] not in raw_response for other in RESULTS if other['session'] != session)
        tool_results += sum(message['role'] == 'tool' for message in request['messages'])
        offered.update(row['tools'])
    assert {'read', 'bash'}.issubset(offered) and offered.intersection({'edit', 'write'}) and tool_results
    manifest = json.loads(subprocess.check_output([str(NODE), '/opt/aimock/deploy/ctl.mjs', 'export', '--session', session], text=True))
    config_file = work/'agent-config/models.json'
    model_config = json.loads(config_file.read_text())
    model_config['providers']['aimock']['baseUrl'] = f'http://127.0.0.1:4010/replay/{manifest["id"]}/v1'
    model_config['providers']['aimock']['headers'] = {'X-AIMock-Strict': '1'}
    config_file.write_text(json.dumps(model_config, indent=2))
    # 只恢复测试自己创建的代码文件，使回放工具有同样的起始状态。
    (work/'calc.py').write_text('def add(a, b):\n    return a - b\n')
    prompt = f'Session marker {session}. In this directory, read calc.py and test_calc.py using the read tool, fix add using the edit or write tool, and run python3 test_calc.py using bash. Do not edit the tests. Finish with the test result and the session marker. Use only this directory.'
    model = model_config['providers']['aimock']['models'][0]['id']
    env = dict(os.environ, PI_CODING_AGENT_DIR=str(work/'agent-config'), AIMOCK_SMOKE_KEY=KEY, PI_OFFLINE='1', PATH=str(NODE.parent)+':'+os.environ['PATH'])
    start = time.monotonic()
    with (work/'replay-pi.jsonl').open('w') as stdout, (work/'replay-stderr.log').open('w') as stderr:
        process = subprocess.run([str(NODE), str(RUNTIME/'@earendil-works/pi-coding-agent/dist/cli.js'), '--provider', 'aimock', '--model', model, '--thinking', 'off', '--mode', 'json', '--print', '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes', '--session-dir', str(work/'replay-sessions'), prompt], cwd=work, env=env, stdout=stdout, stderr=stderr, timeout=120)
    verifier = subprocess.run(['python3', 'test_calc.py'], cwd=work, text=True, capture_output=True)
    source_check = subprocess.run(['python3', '-c', 'import runpy; add=runpy.run_path("calc.py")["add"]; assert add(5,3)==8 and add(-2,2)==0'], cwd=work, capture_output=True)
    errors = [json.loads(line) for line in (work/'replay-pi.jsonl').read_text().splitlines() if line.startswith('{') and 'errorMessage' in line]
    return {'session': session, 'trace': manifest['id'], 'recorded_requests': len(records), 'recorded_tools': sorted(offered), 'tool_results_in_histories': tool_results, 'pi_exit': process.returncode, 'verifier_exit': verifier.returncode, 'source_check_exit': source_check.returncode, 'verifier_stdout': verifier.stdout, 'errors': errors, 'elapsed_s': round(time.monotonic()-start, 3), 'passed': process.returncode == 0 and verifier.returncode == 0 and source_check.returncode == 0 and not errors}


with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
    outcomes = list(executor.map(replay_one, RESULTS))
(OUT/'replay-results.json').write_text(json.dumps(outcomes, indent=2))
print(json.dumps({'receipt': str(OUT), 'results': outcomes}, indent=2))
