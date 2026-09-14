#!/bin/zsh
# 构建 libmpv 的字幕渲染依赖链(libass ← freetype/fribidi/harfbuzz/libunibreak),
# 全部以静态库形式产出,并以 MACOSX_DEPLOYMENT_TARGET=14.0 编译。
#
# 为什么需要它(R16 车道 D):以前这一串从 Homebrew bottle 拿,bottle 按当前大版本
# 编(minos 26.0),还把 glib/pcre2/libintl/graphite2/libpng 一并拖进包里,发布包在
# macOS 14–26 上 dyld 直接拒绝加载。这里从源码按 14.0 目标构建为 .a,由
# build-lgpl-mpv.sh 用 -Dprefer_static=true 静态链进 libmpv.2.dylib,包里不再出现
# 任何 Homebrew 产物。
#
# 产物:$OUT/lib/*.a + $OUT/lib/pkgconfig/*.pc + $OUT/legal/<component>/<license files>
# (许可证物料由 package-dmg.sh 复制进 .app 的 legal/native/,与 native-sbom 对应)。
set -euo pipefail

for TOOL_DIR in /opt/homebrew/bin /usr/bin; do
  [ -d "$TOOL_DIR" ] && PATH="$TOOL_DIR:$PATH"
done
export PATH
for REQUIRED in meson ninja pkg-config curl shasum tar otool clang; do
  command -v "$REQUIRED" >/dev/null || { echo "ERROR: missing $REQUIRED"; exit 1; }
done
[ "$(uname -s)" = "Darwin" ] || { echo "ERROR: 只能在 macOS 上构建"; exit 1; }

export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-14.0}"
WORK="${WORK:-$HOME/Library/Caches/tripcut-build/native/mpv-deps}"
OUT="${OUT:-$WORK/out}"
DOWNLOADS="$WORK/downloads"
SRC="$WORK/src"
LOGS="$WORK/logs"
mkdir -p "$DOWNLOADS" "$SRC" "$LOGS"
rm -rf "$OUT"
mkdir -p "$OUT/legal"

# 编译器旗标:deployment target 同时走环境变量(clang/ld 都认)和显式旗标,
# 不依赖任何一个构建系统"恰好"转发。
export CFLAGS="-mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET -O2"
export CXXFLAGS="$CFLAGS"
export LDFLAGS="-mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET"
# 只看本目录的 .pc,不让 Homebrew 的 freetype/harfbuzz 混进来。
export PKG_CONFIG_LIBDIR="$OUT/lib/pkgconfig"
unset PKG_CONFIG_PATH

fetch() {  # name url sha256
  local file="$DOWNLOADS/$1"
  if [ ! -f "$file" ]; then
    curl --fail --location --proto '=https' --tlsv1.2 -o "$file.part" "$2"
    mv "$file.part" "$file"
  fi
  echo "$3  $file" | shasum -a 256 -c - >/dev/null || { echo "ERROR: sha256 mismatch: $1"; exit 1; }
}

unpack() {  # archive dir
  rm -rf "$SRC/$2"
  tar xf "$DOWNLOADS/$1" -C "$SRC"
  [ -d "$SRC/$2" ] || { echo "ERROR: 解包后没有 $SRC/$2"; exit 1; }
}

meson_build() {  # dir ...options
  local dir="$1"; shift
  local log="$LOGS/$(basename "$dir").log"
  rm -rf "$dir/_build"
  meson setup "$dir/_build" "$dir" \
    --prefix="$OUT" --libdir=lib --buildtype=release \
    --default-library=static -Dprefer_static=true \
    "$@" > "$log" 2>&1
  ninja -C "$dir/_build" -j"$(sysctl -n hw.ncpu)" >> "$log" 2>&1
  ninja -C "$dir/_build" install >> "$log" 2>&1
}

autotools_build() {  # dir ...options
  local dir="$1"; shift
  local log="$LOGS/$(basename "$dir").log"
  ( cd "$dir" && PKG_CONFIG="pkg-config --static" ./configure --prefix="$OUT" \
      --disable-shared --enable-static "$@" > "$log" 2>&1 \
    && make -j"$(sysctl -n hw.ncpu)" >> "$log" 2>&1 \
    && make install >> "$log" 2>&1 )
}

legal() {  # component dir files...
  local component="$1" dir="$2"; shift 2
  mkdir -p "$OUT/legal/$component"
  for f in "$@"; do
    [ -f "$dir/$f" ] || { echo "ERROR: 缺少许可证物料 $dir/$f"; exit 1; }
    cp "$dir/$f" "$OUT/legal/$component/$(basename "$f")"
  done
}

FREETYPE_VERSION=2.13.3
FRIBIDI_VERSION=1.0.16
HARFBUZZ_VERSION=11.4.1
LIBUNIBREAK_VERSION=6.1
LIBASS_VERSION=0.17.4

echo "==> 下载并校验源码"
fetch "freetype-$FREETYPE_VERSION.tar.xz" "https://download.savannah.gnu.org/releases/freetype/freetype-$FREETYPE_VERSION.tar.xz" \
  0550350666d427c74daeb85d5ac7bb353acba5f76956395995311a9c6f063289
fetch "fribidi-$FRIBIDI_VERSION.tar.xz" "https://github.com/fribidi/fribidi/releases/download/v$FRIBIDI_VERSION/fribidi-$FRIBIDI_VERSION.tar.xz" \
  1b1cde5b235d40479e91be2f0e88a309e3214c8ab470ec8a2744d82a5a9ea05c
fetch "harfbuzz-$HARFBUZZ_VERSION.tar.xz" "https://github.com/harfbuzz/harfbuzz/releases/download/$HARFBUZZ_VERSION/harfbuzz-$HARFBUZZ_VERSION.tar.xz" \
  7aafab93115eb56cdc9a931ab7d19ff60d7f2937b599d140f17236f374e32698
fetch "libunibreak-$LIBUNIBREAK_VERSION.tar.gz" "https://github.com/adah1972/libunibreak/releases/download/libunibreak_${LIBUNIBREAK_VERSION//./_}/libunibreak-$LIBUNIBREAK_VERSION.tar.gz" \
  cc4de0099cf7ff05005ceabff4afed4c582a736abc38033e70fdac86335ce93f
fetch "libass-$LIBASS_VERSION.tar.xz" "https://github.com/libass/libass/releases/download/$LIBASS_VERSION/libass-$LIBASS_VERSION.tar.xz" \
  78f1179b838d025e9c26e8fef33f8092f65611444ffa1bfc0cfac6a33511a05a

echo "==> freetype $FREETYPE_VERSION(静态;不带 png/brotli/bzip2/harfbuzz,zlib 用系统的)"
unpack "freetype-$FREETYPE_VERSION.tar.xz" "freetype-$FREETYPE_VERSION"
meson_build "$SRC/freetype-$FREETYPE_VERSION" \
  -Dharfbuzz=disabled -Dpng=disabled -Dbrotli=disabled -Dbzip2=disabled -Dzlib=system -Dtests=disabled
legal freetype "$SRC/freetype-$FREETYPE_VERSION" LICENSE.TXT docs/FTL.TXT

echo "==> fribidi $FRIBIDI_VERSION(静态)"
unpack "fribidi-$FRIBIDI_VERSION.tar.xz" "fribidi-$FRIBIDI_VERSION"
meson_build "$SRC/fribidi-$FRIBIDI_VERSION" -Ddocs=false -Dtests=false -Dbin=false
legal fribidi "$SRC/fribidi-$FRIBIDI_VERSION" COPYING AUTHORS

echo "==> harfbuzz $HARFBUZZ_VERSION(静态;只带 freetype,不带 glib/graphite2/icu/cairo)"
unpack "harfbuzz-$HARFBUZZ_VERSION.tar.xz" "harfbuzz-$HARFBUZZ_VERSION"
meson_build "$SRC/harfbuzz-$HARFBUZZ_VERSION" \
  -Dfreetype=enabled -Dglib=disabled -Dgobject=disabled -Dcairo=disabled -Dicu=disabled \
  -Dgraphite2=disabled -Dchafa=disabled -Dcoretext=disabled -Dtests=disabled -Ddocs=disabled \
  -Dutilities=disabled -Dintrospection=disabled -Dbenchmark=disabled
legal harfbuzz "$SRC/harfbuzz-$HARFBUZZ_VERSION" COPYING AUTHORS

echo "==> libunibreak $LIBUNIBREAK_VERSION(静态)"
unpack "libunibreak-$LIBUNIBREAK_VERSION.tar.gz" "libunibreak-$LIBUNIBREAK_VERSION"
autotools_build "$SRC/libunibreak-$LIBUNIBREAK_VERSION"
legal libunibreak "$SRC/libunibreak-$LIBUNIBREAK_VERSION" LICENCE AUTHORS

echo "==> libass $LIBASS_VERSION(静态;CoreText 字体提供者,不用 fontconfig)"
unpack "libass-$LIBASS_VERSION.tar.xz" "libass-$LIBASS_VERSION"
autotools_build "$SRC/libass-$LIBASS_VERSION" \
  --disable-fontconfig --enable-coretext --enable-libunibreak --disable-require-system-font-provider
legal libass "$SRC/libass-$LIBASS_VERSION" COPYING

echo "==> 自检"
FAIL=0
for LIB in libfreetype libfribidi libharfbuzz libunibreak libass; do
  A="$OUT/lib/$LIB.a"
  [ -f "$A" ] || { echo "ERROR: 缺少 $A"; FAIL=1; continue; }
  # 任何一个目标文件的 minos 高于目标版本即拒绝
  BAD="$(otool -l "$A" | grep -A3 'LC_BUILD_VERSION' | awk '/minos/ {print $2}' | sort -u | grep -v "^$MACOSX_DEPLOYMENT_TARGET$" || true)"
  if [ -n "$BAD" ]; then echo "ERROR: $A 含 minos=$BAD 的目标文件"; FAIL=1; fi
done
[ -z "$(find "$OUT/lib" -maxdepth 1 -name "*.dylib" -print -quit)" ] || { echo "ERROR: 出现了动态库,应全部为静态"; FAIL=1; }
for PC in freetype2 fribidi harfbuzz libunibreak libass; do
  pkg-config --exists "$PC" || { echo "ERROR: pkg-config 找不到 $PC"; FAIL=1; }
done
[ "$FAIL" -eq 0 ] || exit 1
{
  echo "deployment_target=$MACOSX_DEPLOYMENT_TARGET"
  echo "freetype=$FREETYPE_VERSION"
  echo "fribidi=$FRIBIDI_VERSION"
  echo "harfbuzz=$HARFBUZZ_VERSION"
  echo "libunibreak=$LIBUNIBREAK_VERSION"
  echo "libass=$LIBASS_VERSION"
  echo "linkage=static (linked into libmpv.2.dylib)"
} > "$OUT/build-manifest.txt"
echo "==> 完成:$OUT"
cat "$OUT/build-manifest.txt"
