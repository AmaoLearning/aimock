#!/usr/bin/env bash
# 在专用目录安装固定版本，不替换系统 Node，不更改已有 nginx 或模型服务。
set -euo pipefail
test "$(id -u)" = 0
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
install -d -m 700 /etc/aimock
install -d /opt/aimock/runtime /opt/aimock/deploy
install -d -m 700 /mnt/shared-storage-gpfs2/df4-hicache/aimock-v1
if [[ ! -s /etc/aimock/upstream.json ]]; then
  echo '先将 YICLOUD_API_KEY / YICLOUD_MODEL_URL / YICLOUD_QWEN_MODEL 写入 /etc/aimock/upstream.json，权限 600。' >&2
  exit 1
fi
if [[ ! -s /etc/aimock/client-key ]]; then
  python3 -c 'import secrets; print(secrets.token_hex(32))' > /etc/aimock/client-key
fi
chmod 600 /etc/aimock/upstream.json /etc/aimock/client-key
cd /opt/aimock/runtime
if [[ -x /opt/aimock/runtime/node_modules/node/bin/node ]]; then
  export PATH="/opt/aimock/runtime/node_modules/node/bin:$PATH"
fi
npm install --no-audit --no-fund --save-exact node@22.22.0 @copilotkit/aimock@1.45.1
cp "$source_dir"/*.mjs "$source_dir"/package.json /opt/aimock/deploy/
ln -sfn /opt/aimock/runtime/node_modules /opt/aimock/deploy/node_modules
install -m 644 "$source_dir/aimock-gateway.service" /etc/systemd/system/aimock-gateway.service
systemctl daemon-reload
systemctl enable aimock-gateway.service
systemctl restart aimock-gateway.service
curl --fail --retry 8 --retry-connrefused --retry-delay 1 http://127.0.0.1:4010/healthz
