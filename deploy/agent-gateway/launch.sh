#!/usr/bin/env bash
# 单行前台入口。已导出的 AIMOCK_* 参数优先于 gateway.env。
set -euo pipefail
umask 077
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
export AIMOCK_HOME="${AIMOCK_HOME:-$script_dir}"
node_binary="${AIMOCK_NODE_BIN:-$AIMOCK_HOME/runtime/node-22.22.0-aimock-1.46.0/node_modules/node/bin/node}"
[[ -x "$node_binary" ]] || { echo "Missing runtime: $node_binary; run install.sh" >&2; exit 1; }
env_file="${AIMOCK_ENV_FILE:-$AIMOCK_HOME/config/gateway.env}"
"$node_binary" -e 'const fs=require("fs"),s=fs.statSync(process.argv[1]); if(!s.isFile()||(s.mode&63))throw Error("gateway.env must be a private regular file (600)")' "$env_file"
names=(); values=()
for name in AIMOCK_HOME AIMOCK_APP_DIR AIMOCK_HOST AIMOCK_PORT AIMOCK_WORKERS AIMOCK_DATA_ROOT \
  AIMOCK_UPSTREAM_CONFIG AIMOCK_CLIENT_KEY_FILE AIMOCK_REQUIRED_MOUNTS AIMOCK_STORAGE_BOUNDARY \
  AIMOCK_BASE_URL AIMOCK_PI_CLI AIMOCK_MAX_REQUEST_BYTES AIMOCK_MAX_RESPONSE_BYTES AIMOCK_FIXTURE_CACHE \
  AIMOCK_TIMEOUT_MS AIMOCK_REPLAY_TTFT_MS AIMOCK_REPLAY_CHUNKS_PER_SECOND NODE_OPTIONS; do
  if [[ -n "${!name+x}" ]]; then names+=("$name"); values+=("${!name}"); fi
done
set -a
source "$env_file"
set +a
for ((index=0; index<${#names[@]}; index++)); do export "${names[$index]}=${values[$index]}"; done
export AIMOCK_APP_DIR="${AIMOCK_APP_DIR:-$AIMOCK_HOME/current}"
export AIMOCK_NODE_BIN="$node_binary"
export PATH="$(dirname -- "$node_binary"):$PATH"
cd -- "$AIMOCK_APP_DIR"
action="${1:-start}"
[[ $# == 0 ]] || shift
case "$action" in
  start)
    [[ $# == 0 ]] || { echo 'start takes no positional arguments' >&2; exit 2; }
    ulimit -n 131072 2>/dev/null || true
    "$node_binary" ./preflight.mjs
    exec "$node_binary" ./gateway.mjs ;;
  list|export) exec "$node_binary" ./ctl.mjs "$action" "$@" ;;
  pi-smoke) exec python3 ./pi-smoke.py "$@" ;;
  replay-bench) exec "$node_binary" ./replay-bench.mjs "$@" ;;
  health)
    exec "$node_binary" --input-type=module -e 'const u=process.env.AIMOCK_BASE_URL||`http://127.0.0.1:${process.env.AIMOCK_PORT}/`; const r=await fetch(new URL("healthz",u.endsWith("/")?u:u+"/")); console.log(await r.text()); if(!r.ok)process.exit(1)' ;;
  *) echo 'Usage: aimock start|health|list|export|pi-smoke|replay-bench' >&2; exit 2 ;;
esac
