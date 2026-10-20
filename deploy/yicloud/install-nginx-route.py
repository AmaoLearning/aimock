#!/usr/bin/env python3
"""在现有 YiCloud 8000 server 内添加 /aimock/；先备份，校验失败恢复，不更改其他路由。"""
import datetime
import subprocess
from pathlib import Path

target = Path('/etc/nginx/conf.d/vscode.conf')
snippet = Path('/etc/nginx/snippets/aimock-location.conf')
source = Path(__file__).with_name('nginx-location.conf')
original = target.read_bytes()
include = b'    include /etc/nginx/snippets/aimock-location.conf;\n'
if b'listen 8000;' not in original or original.count(b'server {') != 1:
    raise SystemExit('Expected exactly one existing server listening on 8000; inspect manually')
snapshot = Path('/opt/aimock/receipts')
snapshot.mkdir(parents=True, exist_ok=True)
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
(snapshot/f'nginx-vscode-before-{stamp}.conf').write_bytes(original)
snippet.write_bytes(source.read_bytes())
if include not in original:
    position = original.rfind(b'}')
    target.write_bytes(original[:position] + include + original[position:])
result = subprocess.run(['nginx', '-t'], capture_output=True, text=True)
if result.returncode:
    target.write_bytes(original)
    raise SystemExit(result.stderr)
subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
print('Added /aimock/ route on existing port 8000; preserved other routes')
