#!/bin/zsh
# 构建 TripCut 专用 libplacebo：只保留 OpenGL，关闭未使用的 Vulkan、shaderc、glslang。
# 所有网络输入固定版本并核对 SHA-256；产物供 build-lgpl-mpv.sh 使用。
set -euo pipefail

VERSION="${LIBPLACEBO_VERSION:-7.360.1}"
SOURCE_SHA256="${LIBPLACEBO_SOURCE_SHA256:-937aa5eeea596798b3274d362de2e3bd32bc537a66d149dd85043349c74dffb6}"
WORK="${WORK:-/tmp/libplacebo-tripcut}"
OUT="${OUT:-$WORK/out-v7.360.1-opengl}"
CACHE="$WORK/downloads"
STAGE="$(mktemp -d -t tripcut-libplacebo.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT HUP INT TERM

mkdir -p "$CACHE"
SOURCE_ARCHIVE="$CACHE/libplacebo-v$VERSION.tar.bz2"
if [ ! -f "$SOURCE_ARCHIVE" ]; then
  curl -fsSL "https://code.videolan.org/videolan/libplacebo/-/archive/v$VERSION/libplacebo-v$VERSION.tar.bz2" -o "$SOURCE_ARCHIVE"
fi
echo "$SOURCE_SHA256  $SOURCE_ARCHIVE" | shasum -a 256 -c -

python3 -m venv "$STAGE/venv"
"$STAGE/venv/bin/pip" download --only-binary=:all: --dest "$STAGE/wheels" \
  'glad2==2.0.8' 'jinja2==3.1.6' 'markupsafe==3.0.3' >/dev/null
echo "cfe84018233043554710aa747d0bf4be55015154f8bcd451765d1984bcc9d70b  $STAGE/wheels/glad2-2.0.8-py3-none-any.whl" | shasum -a 256 -c -
echo "85ece4451f492d0c13c5dd7c13a64681a86afae63a5f347908daf103ce6d2f67  $STAGE/wheels/jinja2-3.1.6-py3-none-any.whl" | shasum -a 256 -c -
MARKUPSAFE_WHEEL="$(find "$STAGE/wheels" -maxdepth 1 -name 'markupsafe-3.0.3-*.whl' -print -quit)"
[ -n "$MARKUPSAFE_WHEEL" ] || { echo "ERROR: 缺少 markupsafe 3.0.3 wheel"; exit 1; }
echo "c47a551199eb8eb2121d4f0f15ae0f923d31350ab9280078d1e5f12b249e0026  $MARKUPSAFE_WHEEL" | shasum -a 256 -c -
"$STAGE/venv/bin/pip" install --no-index --find-links "$STAGE/wheels" \
  'glad2==2.0.8' 'jinja2==3.1.6' 'markupsafe==3.0.3' >/dev/null
PYTHON_SITE="$($STAGE/venv/bin/python -c 'import site; print(site.getsitepackages()[0])')"

tar xf "$SOURCE_ARCHIVE" -C "$STAGE"
SOURCE_ROOT="$STAGE/libplacebo-v$VERSION"
BUILD="$STAGE/build"
PYTHONPATH="$PYTHON_SITE" PATH="/opt/homebrew/bin:$PATH" \
  meson setup "$BUILD" "$SOURCE_ROOT" \
    -Dvulkan=disabled -Dshaderc=disabled -Dglslang=disabled \
    -Dopengl=enabled -Dlcms=enabled -Ddemos=false -Dtests=false \
    -Dbench=false -Dfuzz=false -Dunwind=disabled \
    --prefix="$OUT" --buildtype=release
PYTHONPATH="$PYTHON_SITE" PATH="/opt/homebrew/bin:$PATH" \
  ninja -C "$BUILD" -j"$(sysctl -n hw.ncpu)"
PYTHONPATH="$PYTHON_SITE" PATH="/opt/homebrew/bin:$PATH" \
  ninja -C "$BUILD" install

LIB="$OUT/lib/libplacebo.360.dylib"
[ -f "$LIB" ] || { echo "ERROR: 缺少 $LIB"; exit 1; }
if otool -L "$LIB" | grep -qE 'libvulkan|libshaderc'; then
  echo "ERROR: TripCut libplacebo 仍链接 Vulkan/shaderc"; exit 1
fi
cp "$SOURCE_ROOT/LICENSE" "$OUT/LICENSE"
{
  echo "version=$VERSION"
  echo "source_sha256=$SOURCE_SHA256"
  echo "configuration=-Dvulkan=disabled -Dshaderc=disabled -Dglslang=disabled -Dopengl=enabled -Dlcms=enabled"
} > "$OUT/build-manifest.txt"
echo "==> 完成：$LIB"
