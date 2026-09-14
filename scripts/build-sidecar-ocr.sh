#!/bin/zsh
# 构建随包的 Vision OCR 工具 sidecar-ocr(TripCut 自有代码，Apache-2.0)。
# 只用 Command Line Tools 的 swiftc 编译，不依赖 Xcode 工程。
# 固定输出目录：~/Library/Caches/tripcut-build/sidecar-ocr/out —— 不用 /tmp，
# 见 F-R0-7（重启会清空 /tmp，构建缓存必须跨重启存活）。
set -euo pipefail

for TOOL_DIR in /opt/homebrew/bin /usr/bin; do
  [ -d "$TOOL_DIR" ] && PATH="$TOOL_DIR:$PATH"
done
export PATH
for REQUIRED in swiftc shasum file otool date; do
  command -v "$REQUIRED" >/dev/null || { echo "ERROR: missing $REQUIRED"; exit 1; }
done
[ "$(uname -s)" = "Darwin" ] || { echo "ERROR: sidecar-ocr 只能在 macOS 上构建（依赖 Vision/AppKit）"; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/sidecar-ocr/main.swift"
[ -s "$SOURCE" ] || { echo "ERROR: 缺少源码：$SOURCE"; exit 1; }

# 最低系统版本(R16 车道 D):swiftc 不认 MACOSX_DEPLOYMENT_TARGET,要显式 -target。
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-14.0}"
OUTPUT_ROOT="${TRIPCUT_SIDECAR_OCR_OUT:-$HOME/Library/Caches/tripcut-build/sidecar-ocr/out}"
mkdir -p "$OUTPUT_ROOT"
BINARY="$OUTPUT_ROOT/sidecar-ocr"
rm -f "$BINARY"

echo "==> swiftc -O $SOURCE"
swiftc -O \
  -target "arm64-apple-macos$MACOSX_DEPLOYMENT_TARGET" \
  -framework Vision \
  -framework AppKit \
  -framework CoreImage \
  "$SOURCE" \
  -o "$BINARY"

[ -x "$BINARY" ] || { echo "ERROR: build did not produce $BINARY"; exit 1; }
file -b "$BINARY" | grep -q 'arm64' || { echo "ERROR: sidecar-ocr is not arm64"; exit 1; }
if otool -L "$BINARY" | grep -qE '/opt/homebrew|/usr/local'; then
  echo "ERROR: sidecar-ocr 链接了构建机路径依赖，拒绝产出"; otool -L "$BINARY"; exit 1
fi
MINOS="$(otool -l "$BINARY" | grep -A3 LC_BUILD_VERSION | awk '/minos/ {print $2; exit}')"
[ "$MINOS" = "$MACOSX_DEPLOYMENT_TARGET" ] || { echo "ERROR: sidecar-ocr minos=$MINOS，期望 $MACOSX_DEPLOYMENT_TARGET"; exit 1; }

SWIFTC_VERSION="$(swiftc --version 2>&1 | head -1)"
BINARY_SHA256="$(shasum -a 256 "$BINARY" | awk '{print $1}')"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

python3 - "$OUTPUT_ROOT/build-manifest.json" "$SWIFTC_VERSION" "$BINARY_SHA256" "$BUILD_DATE" "$MACOSX_DEPLOYMENT_TARGET" <<'PY'
import json, pathlib, sys
output, swiftc_version, binary_sha256, build_date, minimum_macos = sys.argv[1:]
payload = {
    "schemaVersion": 1,
    "component": "sidecar-ocr",
    "license": "Apache-2.0",
    "swiftcVersion": swiftc_version,
    "binarySha256": binary_sha256,
    "builtAt": build_date,
    "architecture": "arm64",
    "minimumMacOS": minimum_macos,
    "sourcePath": "sidecar-ocr/main.swift",
}
pathlib.Path(output).write_text(json.dumps(payload, indent=2) + "\n")
PY
echo "PASS: $BINARY"
shasum -a 256 "$BINARY"
