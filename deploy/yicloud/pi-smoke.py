#!/usr/bin/env python3
"""用少量真实 pi 会话验证读写代码、工具回传与会话隔离；不调用或修改 dsec suites。"""
import concurrent.futures
import datetime
import json
import os
import subprocess
import time
from pathlib import Path

STAMP = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
ROOT = Path('/mnt/shared-storage-gpfs2/df4-hicache/aimock-v1')
OUT = ROOT / 'receipts' / ('pi-smoke-' + STAMP)
RUNTIME = Path('/opt/aimock/runtime/node_modules')
NODE = RUNTIME / 'node/bin/node'
PI = RUNTIME / '@earendil-works/pi-coding-agent/dist/cli.js'
CONFIG = json.loads(Path('/etc/aimock/upstream.json').read_text())
KEY = Path('/etc/aimock/client-key').read_text().strip()
OUT.mkdir(parents=True, exist_ok=True)


def run_session(index):
    """每个 Agent 使用独立 cwd、配置、日志、任务标记和模型代理 base URL。"""
    session = f'pi-smoke-{STAMP}-{index}'
    work = OUT / session
    agent = work / 'agent-config'
    agent.mkdir(parents=True)
    (work / 'calc.py').write_text('def add(a, b):\n    return a - b\n')
    (work / 'test_calc.py').write_text(f'from calc import add\nassert add({index+5}, 3) == {index+8}\nassert add(-2, 2) == 0\nprint("PASS_{session}")\n')
    provider = {
        'baseUrl': f'http://127.0.0.1:4010/record/{session}/v1',
        'api': 'openai-completions', 'apiKey': '$AIMOCK_SMOKE_KEY',
        'compat': {'supportsDeveloperRole': False, 'supportsReasoningEffort': False, 'supportsStore': False},
        'models': [{'id': CONFIG['YICLOUD_QWEN_MODEL'], 'name': 'Qwen recording test', 'reasoning': False, 'input': ['text'], 'contextWindow': 40960, 'maxTokens': 4096, 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}}],
    }
    (agent / 'models.json').write_text(json.dumps({'providers': {'aimock': provider}}, indent=2))
    (agent / 'settings.json').write_text(json.dumps({'autoCompaction': False, 'retry': {'enabled': False}}))
    env = dict(os.environ, PI_CODING_AGENT_DIR=str(agent), AIMOCK_SMOKE_KEY=KEY, PI_OFFLINE='1', PATH=str(NODE.parent) + ':' + os.environ['PATH'])
    prompt = f'Session marker {session}. In this directory, read calc.py and test_calc.py using the read tool, fix add using the edit or write tool, and run python3 test_calc.py using bash. Do not edit the tests. Finish with the test result and the session marker. Use only this directory.'
    command = [str(NODE), str(PI), '--provider', 'aimock', '--model', CONFIG['YICLOUD_QWEN_MODEL'], '--thinking', 'off', '--mode', 'json', '--print', '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes', '--session-dir', str(work/'sessions'), prompt]
    start = time.monotonic()
    with (work/'pi.jsonl').open('w') as stdout, (work/'stderr.log').open('w') as stderr:
        result = subprocess.run(command, cwd=work, env=env, stdout=stdout, stderr=stderr, timeout=240)
    verified = subprocess.run(['python3', 'test_calc.py'], cwd=work, text=True, capture_output=True)
    source_check = subprocess.run(['python3', '-c', 'import runpy; add=runpy.run_path("calc.py")["add"]; assert add(5,3)==8 and add(-2,2)==0'], cwd=work, capture_output=True)
    tools = []
    for line in (work/'pi.jsonl').read_text().splitlines():
        try:
            event = json.loads(line)
            if event.get('type') == 'tool_execution_start': tools.append(event.get('toolName'))
        except json.JSONDecodeError:
            pass
    return {'session': session, 'pi_exit': result.returncode, 'verifier_exit': verified.returncode, 'verifier_stdout': verified.stdout, 'source_check_exit': source_check.returncode, 'tools': tools, 'elapsed_s': round(time.monotonic()-start, 3), 'directory': str(work), 'passed': result.returncode == 0 and verified.returncode == 0 and source_check.returncode == 0 and 'read' in tools and 'bash' in tools and any(tool in tools for tool in ('edit', 'write'))}


with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
    results = list(executor.map(run_session, range(3)))
(OUT / 'results.json').write_text(json.dumps(results, indent=2))
print(json.dumps({'receipt': str(OUT), 'results': results}, indent=2))
