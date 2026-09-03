#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

echo "build-dmg.sh 已合并到唯一发行入口 package-dmg.sh。" >&2
exec "$SCRIPT_DIR/package-dmg.sh" "$@"
