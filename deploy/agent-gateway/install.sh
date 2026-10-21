#!/usr/bin/env bash
# 普通用户安装；所有运行时、配置和代码均放在 AIMOCK_HOME，不修改系统 Node。
set -euo pipefail
umask 077
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
with_pi=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --home) export AIMOCK_HOME="${2:?--home requires a path}"; shift 2 ;;
    --data-root) export AIMOCK_DATA_ROOT="${2:?--data-root requires a path}"; shift 2 ;;
    --with-pi) with_pi=1; shift ;;
    -h|--help)
      echo 'install.sh [--home ABSOLUTE_PATH] [--data-root ABSOLUTE_PATH] [--with-pi]'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
export AIMOCK_HOME="${AIMOCK_HOME:-${HOME}/.local/share/aimock-gateway}"
[[ "$AIMOCK_HOME" = /* ]] || { echo 'AIMOCK_HOME must be absolute' >&2; exit 1; }
command -v node >/dev/null || { echo 'Install Node.js >=20.15 and npm first' >&2; exit 1; }
command -v npm >/dev/null || { echo 'Install npm first' >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<20 || (a===20 && b<15)) process.exit(1)' || {
  echo 'Bootstrap requires Node.js >=20.15; the gateway will use its private Node 22.22.0' >&2
  exit 1
}
runtime="$AIMOCK_HOME/runtime/node-22.22.0-aimock-1.46.0"
mkdir -p "$runtime"
node_binary="$runtime/node_modules/node/bin/node"
if [[ -x "$node_binary" ]] && [[ "$("$node_binary" --version)" == v22.22.0 ]] && \
   "$node_binary" -e 'if(JSON.parse(require("fs").readFileSync(process.argv[1])).version!=="1.46.0")process.exit(1)' \
     "$runtime/node_modules/@copilotkit/aimock/package.json" 2>/dev/null; then
  echo 'Using existing Node 22.22.0 / AIMock 1.46.0 runtime'
else
  cp "$source_dir/package.json" "$source_dir/package-lock.json" "$runtime/"
  npm ci --prefix "$runtime" --omit=dev --no-audit --no-fund
fi
export PATH="$(dirname -- "$node_binary"):$PATH"
"$node_binary" "$source_dir/setup.mjs" "$source_dir"
if [[ "$with_pi" == 1 ]]; then
  npm install --prefix "$AIMOCK_HOME/pi-runtime" --no-audit --no-fund --save-exact \
    @earendil-works/pi-coding-agent@0.81.1
fi
printf '\nStart in foreground: /bin/bash %q start\n' "$AIMOCK_HOME/aimock"
printf 'Configuration: %s\n' "$AIMOCK_HOME/config/gateway.env"
