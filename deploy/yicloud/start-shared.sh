#!/usr/bin/env bash
# 从共享盘前台启动网关；不安装依赖、不使用 systemd、不修改现有工作机服务。
set -euo pipefail
umask 077
[[ "$#" == 0 ]] || { echo '通过 AIMOCK_* 环境变量配置，不接受位置参数。' >&2; exit 1; }
script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
export AIMOCK_DEPLOY_ROOT="${AIMOCK_DEPLOY_ROOT:-$script_directory}"
export AIMOCK_APP_DIR="${AIMOCK_APP_DIR:-${AIMOCK_DEPLOY_ROOT}/current}"
node_binary="${AIMOCK_NODE_BIN:-${AIMOCK_DEPLOY_ROOT}/runtime/node-22.22.0-aimock-1.45.1/bin/node}"
[[ -x "$node_binary" ]] || { echo "Node 运行时不可执行：$node_binary" >&2; exit 1; }
export PATH="$(dirname -- "$node_binary"):$PATH"
export AIMOCK_HOST="${AIMOCK_HOST:-0.0.0.0}"
export AIMOCK_PORT="${AIMOCK_PORT:-4010}"
export AIMOCK_WORKERS="${AIMOCK_WORKERS:-8}"
export AIMOCK_DATA_ROOT="${AIMOCK_DATA_ROOT:-/mnt/shared-storage-gpfs2/df4-hicache/aimock-v1}"
export AIMOCK_UPSTREAM_CONFIG="${AIMOCK_UPSTREAM_CONFIG:-${AIMOCK_DEPLOY_ROOT}/config/upstream.json}"
export AIMOCK_CLIENT_KEY_FILE="${AIMOCK_CLIENT_KEY_FILE:-${AIMOCK_DEPLOY_ROOT}/config/client-key}"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"
if ! ulimit -n "${AIMOCK_NOFILE_LIMIT:-131072}" 2>/dev/null; then
  ulimit -n "$(ulimit -Hn)" 2>/dev/null || true
  echo "[aimock] 使用容器允许的文件描述符上限：$(ulimit -n)" >&2
fi
cd -- "$AIMOCK_APP_DIR"
"$node_binary" ./preflight-shared.mjs
exec "$node_binary" ./gateway.mjs
