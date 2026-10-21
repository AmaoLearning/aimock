#!/usr/bin/env python3
"""从共享盘前台启动独立端口，验证真实工具录制、严格回放、启动失败和优雅退出。"""
import datetime
import hashlib
import json
import os
import signal
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

deploy = Path('/mnt/shared-storage-gpfs3/yicheng-deploy/aimock')
data = Path('/mnt/shared-storage-gpfs2/df4-hicache/aimock-v1')
node = deploy/'runtime/node-22.22.0-aimock-1.45.1/bin/node'
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
session = 'shared-start-smoke-'+stamp
receipt = data/'receipts'/session
receipt.mkdir(mode=0o700)
config = json.loads((deploy/'config/upstream.json').read_text())
key = (deploy/'config/client-key').read_text().strip()
environment = dict(os.environ, AIMOCK_PORT='14010', AIMOCK_WORKERS='2', AIMOCK_HOST='0.0.0.0')
command = ['/bin/bash', str(deploy/'start.sh')]
base = 'http://127.0.0.1:14010'
report = {'receipt': str(receipt), 'release': str((deploy/'current').resolve()), 'launch_command': command, 'port': 14010, 'workers': 2}


def request(route, body):
    """只向本测试启动的端口发送带 key 的请求，不将 key 放到命令行或报告。"""
    req = urllib.request.Request(base+route, data=json.dumps(body).encode(), headers={'Authorization': 'Bearer '+key, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as response:
        return response.status, dict(response.headers), json.load(response)


with (receipt/'gateway.log').open('w') as log:
    process = subprocess.Popen(command, cwd='/tmp', env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        for index in range(150):
            if process.poll() is not None:
                raise RuntimeError('Shared launcher exited before ready; inspect gateway.log')
            try:
                with urllib.request.urlopen(base+'/healthz', timeout=1) as response:
                    if response.status == 200:
                        break
            except (urllib.error.URLError, TimeoutError):
                pass
            time.sleep(.1)
        else:
            raise RuntimeError('Shared gateway readiness timeout')
        report['process_executable'] = os.readlink(f'/proc/{process.pid}/exe')
        assert report['process_executable'] == str(node)
        resolved = subprocess.check_output([str(node), '--input-type=module', '-e', 'console.log(import.meta.resolve("@copilotkit/aimock"))'], cwd=deploy/'current', text=True).strip()
        assert resolved.startswith('file://'+str(deploy)+'/runtime/')
        report['aimock_module'] = resolved
        try:
            urllib.request.urlopen(base+'/v1/models', timeout=5)
            raise AssertionError('Expected unauthenticated 401')
        except urllib.error.HTTPError as error:
            assert error.code == 401
            report['unauthenticated_status'] = error.code
        body = {'model': config['YICLOUD_QWEN_MODEL'], 'messages': [{'role': 'user', 'content': f'Session {session}. Use the read tool to read /tmp/shared-start-probe.txt. Do not guess its contents.'}], 'tools': [{'type': 'function', 'function': {'name': 'read', 'description': 'Read a text file', 'parameters': {'type': 'object', 'properties': {'path': {'type': 'string'}}, 'required': ['path']}}}], 'stream': False, 'temperature': 0, 'max_tokens': 1024, 'chat_template_kwargs': {'enable_thinking': False}}
        status, headers, captured = request(f'/record/{session}/v1/chat/completions', body)
        assert status == 200
        calls = captured['choices'][0]['message']['tool_calls']
        assert calls and calls[0]['function']['name'] == 'read'
        assert json.loads(calls[0]['function']['arguments']) == {'path': '/tmp/shared-start-probe.txt'}
        manifest = json.loads(subprocess.check_output([str(node), str(deploy/'current/ctl.mjs'), 'export', '--session', session], env=environment, text=True))
        status, _, replayed = request(f'/replay/{manifest["id"]}/v1/chat/completions', body)
        assert status == 200
        actual = replayed['choices'][0]['message']['tool_calls']
        assert [(item['id'], item['function']['name'], json.loads(item['function']['arguments'])) for item in actual] == [(item['id'], item['function']['name'], json.loads(item['function']['arguments'])) for item in calls]
        record_id = {name.lower(): value for name, value in headers.items()}['x-aimock-record-id']
        metadata_file = data/'records'/record_id[:10]/hashlib.sha256(session.encode()).hexdigest()/record_id/'metadata.json'
        metadata = json.loads(metadata_file.read_text())
        assert metadata['complete'] and metadata['session'] == session
        report.update({'record_status': 200, 'replay_status': 200, 'trace': manifest['id'], 'metadata_file': str(metadata_file), 'tools': metadata['tools']})
        for name, changes, expected in [('occupied-port', {}, 'EADDRINUSE'), ('missing-config', {'AIMOCK_UPSTREAM_CONFIG': str(deploy/'config/does-not-exist.json')}, 'ENOENT')]:
            checked = subprocess.run(command, cwd='/tmp', env=dict(environment, **changes), text=True, capture_output=True, timeout=10)
            assert checked.returncode != 0 and expected in checked.stderr
            (receipt/(name+'.log')).write_text(checked.stdout+checked.stderr)
            report[name] = {'exit': checked.returncode, 'expected_error': expected}
        report['passed'] = True
    except Exception as error:
        report['passed'] = False
        report['error'] = str(error)
        raise
    finally:
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
            try:
                report['shutdown_exit'] = process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                report['shutdown_exit'] = 'forced-kill'
                report['passed'] = False
        report['passed'] = report.get('passed', False) and report.get('shutdown_exit') == 0
        (receipt/'acceptance.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, indent=2))
