#!/usr/bin/env python3
"""把已验证的专用运行时和源文件发布到 gpfs3；不拷贝 pi、不更改 gpfs2 录制数据。"""
import argparse
import datetime
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--release', required=True, help='本次源码版本，例如 Git commit')
parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parent)
args = parser.parse_args()
if not args.release or any(character not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for character in args.release):
    raise SystemExit('release 只能包含字母、数字、短横线和下划线')
root = Path('/mnt/shared-storage-gpfs3/yicheng-deploy/aimock')
for required_mount in ['/mnt/shared-storage-gpfs3/yicheng-deploy', '/mnt/shared-storage-gpfs2/df4-hicache']:
    if not os.path.ismount(required_mount):
        raise SystemExit('打包前必须挂载共享盘：'+required_mount)
runtime = root/'runtime/node-22.22.0-aimock-1.45.1'
release = root/'releases'/args.release
if release.exists():
    raise SystemExit('已有 release 不覆盖：'+str(release))
root.mkdir(exist_ok=True)
runtime.mkdir(parents=True, exist_ok=True)
(runtime/'bin').mkdir(exist_ok=True)
source_node = Path('/opt/aimock/runtime/node_modules/node/bin/node')
if not (runtime/'bin/node').exists():
    shutil.copy2(source_node, runtime/'bin/node')
assert subprocess.check_output([str(runtime/'bin/node'), '--version'], text=True).strip() == 'v22.22.0'
package_source = Path('/opt/aimock/runtime/node_modules/@copilotkit/aimock')
package_target = runtime/'node_modules/@copilotkit/aimock'
if not package_target.exists():
    package_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(package_source, package_target)
assert json.loads((package_target/'package.json').read_text())['version'] == '1.45.1'
config = root/'config'
config.mkdir(mode=0o700, exist_ok=True)
config.chmod(0o700)
for name in ['upstream.json', 'client-key']:
    destination = config/name
    if not destination.exists():
        # 先以 600 创建，避免拷贝过程中出现临时宽权限凭据。
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'wb') as output:
            output.write((Path('/etc/aimock')/name).read_bytes())
    destination.chmod(0o600)
release.mkdir(parents=True)
for source in args.source.iterdir():
    if source.is_file() and source.suffix in ['.mjs', '.py', '.sh', '.json', '.md', '.service', '.conf']:
        shutil.copy2(source, release/source.name)
shutil.copytree(args.source/'tests', release/'tests', ignore=shutil.ignore_patterns('__pycache__'))
(release/'node_modules').symlink_to('../../runtime/node-22.22.0-aimock-1.45.1/node_modules')
hashes = {}
for filename in sorted(release.rglob('*')):
    if filename.is_file() and 'node_modules' not in filename.parts:
        hashes[str(filename.relative_to(release))] = hashlib.sha256(filename.read_bytes()).hexdigest()
manifest = {'created': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'release': args.release, 'node': '22.22.0', 'aimock': '1.45.1', 'platform': 'linux-x64', 'node_sha256': hashlib.sha256((runtime/'bin/node').read_bytes()).hexdigest(), 'source_sha256': hashes, 'data_root': '/mnt/shared-storage-gpfs2/df4-hicache/aimock-v1'}
(release/'release-manifest.json').write_text(json.dumps(manifest, indent=2))
# current 使用同目录临时 symlink 原子切换；已有进程继续持有已经加载的源码。
temporary = root/('.current-'+args.release)
temporary.symlink_to('releases/'+args.release)
temporary.replace(root/'current')
shutil.copy2(release/'start-shared.sh', root/'start.sh')
(root/'start.sh').chmod(0o755)
print(json.dumps({'root': str(root), 'release': str(release), 'start': str(root/'start.sh'), 'data_root': manifest['data_root']}))
