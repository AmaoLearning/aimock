#!/usr/bin/env python3
"""验证真实 OpenAI Chat 工具调用；只保存模型响应，不保存鉴权。"""
import json
import time
import urllib.request
from pathlib import Path

config = json.loads(Path('/etc/aimock/upstream.json').read_text())
out = Path('/opt/aimock/receipts')
out.mkdir(parents=True, exist_ok=True)
messages = [{'role': 'user', 'content': 'Use the read tool to read /tmp/probe.txt. Do not guess its contents.'}]
tool = {'type': 'function', 'function': {'name': 'read', 'description': 'Read a text file', 'parameters': {'type': 'object', 'properties': {'path': {'type': 'string'}}, 'required': ['path']}}}
results = []
for streaming in (False, True):
    body = {'model': config['YICLOUD_QWEN_MODEL'], 'messages': messages, 'tools': [tool], 'tool_choice': 'auto', 'temperature': 0, 'max_tokens': 1024, 'stream': streaming, 'chat_template_kwargs': {'enable_thinking': False}}
    if streaming:
        body['stream_options'] = {'include_usage': True}
    request = urllib.request.Request(config['YICLOUD_MODEL_URL'], data=json.dumps(body).encode(), headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config['YICLOUD_API_KEY']})
    start = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            raw = response.read().decode()
        (out / ('upstream-stream.sse' if streaming else 'upstream-json.json')).write_text(raw)
        calls = {}
        if streaming:
            for line in raw.splitlines():
                if not line.startswith('data: ') or line == 'data: [DONE]':
                    continue
                event = json.loads(line[6:])
                for choice in event.get('choices', []):
                    for call in choice.get('delta', {}).get('tool_calls', []):
                        item = calls.setdefault(call['index'], {'name': '', 'arguments': ''})
                        item['name'] += call.get('function', {}).get('name', '')
                        item['arguments'] += call.get('function', {}).get('arguments', '')
        else:
            for index, call in enumerate(json.loads(raw)['choices'][0]['message'].get('tool_calls', [])):
                calls[index] = call['function']
        valid = any(call['name'] == 'read' and json.loads(call['arguments']).get('path') == '/tmp/probe.txt' for call in calls.values())
        results.append({'stream': streaming, 'passed': valid, 'tool_calls': list(calls.values()), 'elapsed_s': round(time.monotonic()-start, 3)})
    except Exception as error:
        results.append({'stream': streaming, 'passed': False, 'error': str(error), 'elapsed_s': round(time.monotonic()-start, 3)})
(out / 'upstream-probe.json').write_text(json.dumps(results, indent=2))
print(json.dumps(results))
