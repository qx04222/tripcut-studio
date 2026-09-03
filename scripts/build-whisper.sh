#!/bin/zsh
# Build a distributable whisper-cli from a pinned upstream archive. The binary
# owns its ggml implementation and does not discover Homebrew backend plugins.
set -euo pipefail

for TOOL_DIR in /opt/homebrew/bin /usr/bin; do
  [ -d "$TOOL_DIR" ] && PATH="$TOOL_DIR:$PATH"
done
export PATH
for REQUIRED in cmake curl shasum tar file otool python3 patch rg; do
  command -v "$REQUIRED" >/dev/null || { echo "ERROR: missing $REQUIRED"; exit 1; }
done
[ "$(uname -s)" = "Darwin" ] || { echo "ERROR: whisper release binary must be built on macOS"; exit 1; }
[ "$(uname -m)" = "arm64" ] || { echo "ERROR: current release baseline is arm64"; exit 1; }

VERSION="1.9.2"
SOURCE_URL="https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${VERSION}.tar.gz"
SOURCE_SHA256="a6abd064fcca8b85e794d205abf328c522e9451db43a3eadc178b883b7d0e9cd"
BUILD_ROOT="${TRIPCUT_WHISPER_BUILD_ROOT:-/tmp/whisper-static}"
ARCHIVE="$BUILD_ROOT/whisper.cpp-v${VERSION}.tar.gz"
SOURCE_ROOT="$BUILD_ROOT/whisper.cpp-${VERSION}"
BUILD_DIR="$BUILD_ROOT/build"
OUTPUT_ROOT="$BUILD_ROOT/out"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_PATCH="$ROOT/scripts/patches/whisper-no-external-backend.patch"
[ -s "$SOURCE_PATCH" ] || { echo "ERROR: missing $SOURCE_PATCH"; exit 1; }

mkdir -p "$BUILD_ROOT"
if [ ! -f "$ARCHIVE" ] || ! echo "$SOURCE_SHA256  $ARCHIVE" | shasum -a 256 -c -s; then
  PART="$ARCHIVE.part.$$"
  trap 'rm -f "$PART"' EXIT HUP INT TERM
  curl --fail --location --proto '=https' --tlsv1.2 --output "$PART" "$SOURCE_URL"
  echo "$SOURCE_SHA256  $PART" | shasum -a 256 -c -s
  mv "$PART" "$ARCHIVE"
  trap - EXIT HUP INT TERM
fi

rm -rf "$SOURCE_ROOT" "$BUILD_DIR" "$OUTPUT_ROOT"
tar -xzf "$ARCHIVE" -C "$BUILD_ROOT"
patch -d "$SOURCE_ROOT" -p1 --forward --batch < "$SOURCE_PATCH"
cmake -S "$SOURCE_ROOT" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_INSTALL_PREFIX="$OUTPUT_ROOT" \
  -DBUILD_SHARED_LIBS=OFF \
  -DWHISPER_USE_SYSTEM_GGML=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF \
  -DWHISPER_SDL2=OFF \
  -DWHISPER_CURL=OFF \
  -DGGML_BACKEND_DL=OFF \
  -DGGML_NATIVE=OFF \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON
cmake --build "$BUILD_DIR" --config Release --parallel "$(sysctl -n hw.logicalcpu)"
cmake --install "$BUILD_DIR" --config Release

BINARY="$OUTPUT_ROOT/bin/whisper-cli"
[ -x "$BINARY" ] || { echo "ERROR: build did not produce $BINARY"; exit 1; }
file -b "$BINARY" | grep -q 'arm64' || { echo "ERROR: whisper-cli is not arm64"; exit 1; }
if otool -L "$BINARY" | grep -qE '/opt/homebrew|/usr/local'; then
  echo "ERROR: whisper-cli retains a build-machine dependency"; otool -L "$BINARY"; exit 1
fi
if rg -a -q '/opt/homebrew/Cellar/ggml|GGML_BACKEND_PATH' "$BINARY"; then
  echo "ERROR: whisper-cli can discover an external ggml backend"; exit 1
fi

python3 - "$OUTPUT_ROOT/build-manifest.json" "$VERSION" "$SOURCE_URL" "$SOURCE_SHA256" "$SOURCE_PATCH" "$BINARY" <<'PY'
import hashlib, json, pathlib, sys
output, version, source_url, source_sha256, source_patch, binary = sys.argv[1:]
binary_sha256 = hashlib.sha256(pathlib.Path(binary).read_bytes()).hexdigest()
patch_sha256 = hashlib.sha256(pathlib.Path(source_patch).read_bytes()).hexdigest()
payload = {
    "schemaVersion": 1,
    "component": "whisper.cpp",
    "version": version,
    "sourceUrl": source_url,
    "sourceSha256": source_sha256,
    "sourcePatch": pathlib.Path(source_patch).name,
    "sourcePatchSha256": patch_sha256,
    "binarySha256": binary_sha256,
    "architecture": "arm64",
    "sharedLibraries": False,
    "dynamicBackendLoading": False,
}
pathlib.Path(output).write_text(json.dumps(payload, indent=2) + "\n")
PY
echo "PASS: $BINARY"
shasum -a 256 "$BINARY"
