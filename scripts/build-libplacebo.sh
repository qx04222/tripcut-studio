#!/bin/zsh
# 构建 TripCut 专用 libplacebo：只保留 OpenGL，关闭未使用的 Vulkan、shaderc、glslang。
# 所有网络输入固定版本并核对 SHA-256；产物供 build-lgpl-mpv.sh 使用。
set -euo pipefail

# 最低系统版本(R16 车道 D):meson 的 C 编译器与链接器都认这个环境变量,
# 再显式带 -mmacosx-version-min 兜底。
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-14.0}"
export CFLAGS="-mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET"
export CXXFLAGS="$CFLAGS"
export LDFLAGS="-mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET"
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

# 两个仅头文件的 3rdparty(GitLab 的 tar 不带 submodule):
# - fast_float:以 14.0 为目标时 libc++ 的浮点 std::from_chars 被 availability 标成
#   macOS 15+ 才可用,libplacebo 的 convert.cc 就退回 fast_float(SDK 27 默认目标时不需要)。
# - Vulkan-Headers:vulkan 后端关着,但 vulkan/stubs.c 仍要 vulkan.h;以前从 Homebrew 的
#   vulkan.pc 取,这里改成固定版本,不再看 Homebrew。
FAST_FLOAT_VERSION="${FAST_FLOAT_VERSION:-8.0.2}"
FAST_FLOAT_SHA256="${FAST_FLOAT_SHA256:-0883786faf4d98a2ffe97f29d839e2651ac29464a84c24f075a1d4fac8151711}"
VULKAN_HEADERS_VERSION="${VULKAN_HEADERS_VERSION:-1.4.328}"
VULKAN_HEADERS_SHA256="${VULKAN_HEADERS_SHA256:-3ad56d387179b47dd632432ccf989bbb69773e1d732692b7bbad9c4d36aa1304}"
FAST_FLOAT_HEADER="$CACHE/fast_float-v$FAST_FLOAT_VERSION.h"
VULKAN_HEADERS_ARCHIVE="$CACHE/Vulkan-Headers-v$VULKAN_HEADERS_VERSION.tar.gz"
[ -f "$FAST_FLOAT_HEADER" ] || curl -fsSL "https://github.com/fastfloat/fast_float/releases/download/v$FAST_FLOAT_VERSION/fast_float.h" -o "$FAST_FLOAT_HEADER"
echo "$FAST_FLOAT_SHA256  $FAST_FLOAT_HEADER" | shasum -a 256 -c -
[ -f "$VULKAN_HEADERS_ARCHIVE" ] || curl -fsSL "https://github.com/KhronosGroup/Vulkan-Headers/archive/refs/tags/v$VULKAN_HEADERS_VERSION.tar.gz" -o "$VULKAN_HEADERS_ARCHIVE"
echo "$VULKAN_HEADERS_SHA256  $VULKAN_HEADERS_ARCHIVE" | shasum -a 256 -c -
mkdir -p "$SOURCE_ROOT/3rdparty/fast_float/include/fast_float"
cp "$FAST_FLOAT_HEADER" "$SOURCE_ROOT/3rdparty/fast_float/include/fast_float/fast_float.h"
mkdir -p "$SOURCE_ROOT/3rdparty/Vulkan-Headers"
tar xf "$VULKAN_HEADERS_ARCHIVE" -C "$SOURCE_ROOT/3rdparty/Vulkan-Headers" --strip-components=1
[ -f "$SOURCE_ROOT/3rdparty/Vulkan-Headers/include/vulkan/vulkan.h" ] || { echo "ERROR: Vulkan-Headers 解包失败"; exit 1; }
BUILD="$STAGE/build"
# 不给 Homebrew 的 .pc 任何机会:lcms2/vulkan/glslang 全关,libplacebo 剩余依赖只有系统框架。
export PKG_CONFIG_LIBDIR="$STAGE/empty-pkgconfig"
mkdir -p "$PKG_CONFIG_LIBDIR"
PYTHONPATH="$PYTHON_SITE" PATH="/opt/homebrew/bin:$PATH" \
  meson setup "$BUILD" "$SOURCE_ROOT" \
    -Dvulkan=disabled -Dshaderc=disabled -Dglslang=disabled \
    -Dopengl=enabled -Dlcms=disabled -Ddemos=false -Dtests=false \
    -Dbench=false -Dfuzz=false -Dunwind=disabled \
    --prefix="$OUT" --buildtype=release
PYTHONPATH="$PYTHON_SITE" PATH="/opt/homebrew/bin:$PATH" \
  ninja -C "$BUILD" -j"$(sysctl -n hw.ncpu)"
PYTHONPATH="$PYTHON_SITE" PATH="/opt/homebrew/bin:$PATH" \
  ninja -C "$BUILD" install

LIB="$OUT/lib/libplacebo.360.dylib"
[ -f "$LIB" ] || { echo "ERROR: 缺少 $LIB"; exit 1; }
if otool -L "$LIB" | grep -qE 'libvulkan|libshaderc|/opt/homebrew|/usr/local'; then
  echo "ERROR: TripCut libplacebo 仍链接 Vulkan/shaderc 或 Homebrew 库"; otool -L "$LIB"; exit 1
fi
MINOS="$(otool -l "$LIB" | grep -A3 LC_BUILD_VERSION | awk '/minos/ {print $2; exit}')"
[ "$MINOS" = "$MACOSX_DEPLOYMENT_TARGET" ] || { echo "ERROR: $LIB minos=$MINOS,期望 $MACOSX_DEPLOYMENT_TARGET"; exit 1; }
cp "$SOURCE_ROOT/LICENSE" "$OUT/LICENSE"
# fast_float 是编进 libplacebo 的仅头文件库(Apache-2.0 OR MIT OR BSL-1.0),许可证随包;
# Vulkan-Headers 只在编译期提供声明,产物不含其代码,不进 SBOM。
sed -n '1,/^$/p' "$FAST_FLOAT_HEADER" | sed 's#^// \{0,1\}##' > "$OUT/LICENSE-fast_float"
grep -q 'MIT License' "$OUT/LICENSE-fast_float" || { echo "ERROR: fast_float 头文件里没有许可证声明"; exit 1; }
{
  echo "version=$VERSION"
  echo "source_sha256=$SOURCE_SHA256"
  echo "configuration=-Dvulkan=disabled -Dshaderc=disabled -Dglslang=disabled -Dopengl=enabled -Dlcms=disabled"
  echo "deployment_target=$MACOSX_DEPLOYMENT_TARGET"
  echo "fast_float=$FAST_FLOAT_VERSION (header-only, compiled in)"
  echo "vulkan_headers=$VULKAN_HEADERS_VERSION (compile-time only)"
} > "$OUT/build-manifest.txt"
echo "==> 完成：$LIB"
