#!/usr/bin/env bash
set -euo pipefail

readonly CONFIG_PATH="/opt/1panel/www/conf.d/termflow.jianglan.online.conf"
readonly MARKER="# termflow-custom-403"

if ! grep -Fq "${MARKER}" "${CONFIG_PATH}"; then
  cp "${CONFIG_PATH}" "${CONFIG_PATH}.bak-$(date +%Y%m%d-%H%M%S)"
  sed -i "/    root \/www\/sites\/termflow.jianglan.online\/index;/a\\    ${MARKER}\\n    error_page 403 /403.html;\\n    location = /403.html {\\n        internal;\\n    }" "${CONFIG_PATH}"
fi

docker exec 1Panel-openresty-XeW8 openresty -t
docker kill -s HUP 1Panel-openresty-XeW8 >/dev/null
