#!/usr/bin/env bash
# 只在准备机打包；不连接用户侧，不包含真实配置、密钥或业务数据。
set -euo pipefail
umask 077
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
output=""; supplied_runtime=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) output="${2:?--output requires a filename}"; shift 2 ;;
    --runtime) supplied_runtime="${2:?--runtime requires a directory}"; shift 2 ;;
    *) echo 'bundle.sh --output ABSOLUTE_TAR_GZ [--runtime EXISTING_RUNTIME_DIR]' >&2; exit 2 ;;
  esac
done
[[ "$output" = /* && ! -e "$output" ]] || { echo 'Use an absolute, non-existing output filename' >&2; exit 1; }
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
runtime="$stage/runtime/node-22.22.0-aimock-1.46.0"
mkdir -p "$runtime" "$stage/app/examples" "$stage/config"
if [[ -n "$supplied_runtime" ]]; then
  cp -R "$supplied_runtime/node_modules" "$runtime/"
else
  command -v npm >/dev/null || { echo 'npm is required on the preparation machine' >&2; exit 1; }
  cp "$source_dir/package.json" "$source_dir/package-lock.json" "$runtime/"
  npm ci --prefix "$runtime" --omit=dev --no-audit --no-fund
fi
node_binary="$runtime/node_modules/node/bin/node"
[[ "$("$node_binary" --version)" == v22.22.0 ]] || { echo 'Require Node 22.22.0 runtime' >&2; exit 1; }
"$node_binary" -e 'if(JSON.parse(require("fs").readFileSync(process.argv[1])).version!=="1.46.0")process.exit(1)' "$runtime/node_modules/@copilotkit/aimock/package.json"
cp "$source_dir"/*.mjs "$source_dir"/pi-smoke.py "$source_dir"/README.md "$stage/app/"
cp "$source_dir/install-user-service.sh" "$stage/app/"
cp "$source_dir"/examples/* "$stage/app/examples/"
cp "$source_dir/launch.sh" "$stage/aimock"
cp "$source_dir/examples/gateway.env" "$stage/config/gateway.env"
chmod 755 "$stage/aimock"
chmod 600 "$stage/config/gateway.env"
ln -s ../runtime/node-22.22.0-aimock-1.46.0/node_modules "$stage/app/node_modules"
ln -s app "$stage/current"
"$node_binary" --input-type=module - "$stage" <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root=process.argv[2];
writeFileSync(root+'/bundle-manifest.json',JSON.stringify({aimock:'1.46.0',node:process.version,
  platform:process.platform,arch:process.arch,containsCredentials:false,
  nodeSha256:createHash('sha256').update(readFileSync(process.execPath)).digest('hex')},null,2));
JS
tar -czf "$output" -C "$stage" .
printf 'Bundle: %s\nNo deployment or user-side installation was performed.\n' "$output"
