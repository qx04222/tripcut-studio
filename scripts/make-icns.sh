#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SOURCE_ICON=${1:-"$PROJECT_ROOT/src-tauri/icons/icon.png"}
OUTPUT_ICON=${2:-"$PROJECT_ROOT/src-tauri/icons/icon.icns"}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少 macOS 工具：$1" >&2
    exit 1
  fi
}

require_command sips
require_command iconutil
require_command mktemp

if [ ! -f "$SOURCE_ICON" ]; then
  echo "图标源文件不存在：$SOURCE_ICON" >&2
  exit 1
fi

SOURCE_WIDTH=$(sips -g pixelWidth "$SOURCE_ICON" 2>/dev/null | awk '/pixelWidth/ { print $2 }')
SOURCE_HEIGHT=$(sips -g pixelHeight "$SOURCE_ICON" 2>/dev/null | awk '/pixelHeight/ { print $2 }')
if [ "$SOURCE_WIDTH" != "1024" ] || [ "$SOURCE_HEIGHT" != "1024" ]; then
  echo "图标源文件必须是 1024x1024 PNG，当前为 ${SOURCE_WIDTH:-未知}x${SOURCE_HEIGHT:-未知}：$SOURCE_ICON" >&2
  exit 1
fi

TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/tripcut-icon.XXXXXX")
ICONSET_DIR="$TEMP_ROOT/TripCut.iconset"
mkdir -p "$ICONSET_DIR" "$(dirname -- "$OUTPUT_ICON")"

cleanup() {
  rm -rf -- "$TEMP_ROOT"
}
trap cleanup EXIT HUP INT TERM

make_icon() {
  size=$1
  name=$2
  sips -z "$size" "$size" "$SOURCE_ICON" --out "$ICONSET_DIR/$name" >/dev/null
}

make_icon 16 icon_16x16.png
make_icon 32 icon_16x16@2x.png
make_icon 32 icon_32x32.png
make_icon 64 icon_32x32@2x.png
make_icon 128 icon_128x128.png
make_icon 256 icon_128x128@2x.png
make_icon 256 icon_256x256.png
make_icon 512 icon_256x256@2x.png
make_icon 512 icon_512x512.png
make_icon 1024 icon_512x512@2x.png

iconutil --convert icns "$ICONSET_DIR" --output "$OUTPUT_ICON"
echo "已生成：$OUTPUT_ICON"
