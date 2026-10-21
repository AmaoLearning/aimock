#!/usr/bin/env bash
# 可选：普通 Linux 开发机的 systemd user service。默认只安装，不启动。
set -euo pipefail
umask 077
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
detected_home="$script_dir"
while [[ ! -f "$detected_home/aimock" && "$detected_home" != / ]]; do
  detected_home=$(dirname -- "$detected_home")
done
export AIMOCK_HOME="${AIMOCK_HOME:-$detected_home}"
[[ -f "$AIMOCK_HOME/aimock" ]] || { echo 'Run install.sh first' >&2; exit 1; }
systemctl --user show-environment >/dev/null
unit_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
mkdir -p "$unit_dir"
export AIMOCK_USER_UNIT="$unit_dir/aimock-gateway.service"
node_binary="$AIMOCK_HOME/runtime/node-22.22.0-aimock-1.46.0/node_modules/node/bin/node"
"$node_binary" --input-type=module - <<'JS'
import { writeFileSync } from 'node:fs';
const quote = (value) => '"'+value.replaceAll('%','%%').replaceAll('\\','\\\\').replaceAll('"','\\"')+'"';
const entry = process.env.AIMOCK_HOME+'/aimock';
if (/[\r\n]/.test(entry)) throw new Error('Invalid AIMOCK_HOME');
writeFileSync(process.env.AIMOCK_USER_UNIT, `[Unit]
Description=AIMock 1.46.0 agent recording and replay gateway
After=network-online.target

[Service]
Type=simple
ExecStart=/bin/bash ${quote(entry)} start
Restart=on-failure
RestartSec=3
TimeoutStopSec=35
UMask=0077
LimitNOFILE=65536

[Install]
WantedBy=default.target
`);
JS
systemctl --user daemon-reload
if [[ "${1:-}" == --enable ]]; then
  systemctl --user enable --now aimock-gateway.service
else
  echo 'Installed. Start with: systemctl --user enable --now aimock-gateway.service'
fi
