#!/bin/zsh
# 构建 LGPL 版 ffmpeg/ffprobe,供 .app 内嵌分发。
#
# 为什么需要它:Homebrew 的 ffmpeg 带 --enable-gpl --enable-version3 --enable-libx264/x265,
# 把它们打包进 .app 分发会让整个软件被 GPLv3 传染(必须开源全部代码)。
# 本项目用到的滤镜(signalstats/blurdetect/entropy/vmafmotion/scdet/thumbnail 等)
# 全在 LGPL 部分,编码走 macOS 自带的 videotoolbox,不需要 libx264/x265。
#
# 产物:$OUT/bin/{ffmpeg,ffprobe} + $OUT/lib/*.dylib,由 package-dmg.sh 内嵌进 .app。
#
# --disable-avdevice/network/xlib/libxcb:本项目只做本地文件的解码与分析,
# 不需要采集设备、网络协议或 X11。去掉它们能砍掉一大串依赖(xcb/SDL 等),
# 也避免 install_name_tool 因 load command 过长而无法重写依赖路径。
# --disable-sdl2:libavdevice 的 SDL 输出设备会把 libSDL2 拖进依赖树,
# 而 SDL2 在无窗口环境初始化时会 abort(实测导致 .app 启动即崩)。
# 本项目的播放走 libmpv + NSOpenGLView,完全不需要 SDL 输出。
set -euo pipefail

FFMPEG_VERSION="${FFMPEG_VERSION:-7.1.5}"
FFMPEG_SOURCE_SHA256="${FFMPEG_SOURCE_SHA256:-de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f}"
WORK="${WORK:-/tmp/ffmpeg-lgpl}"
OUT="$WORK/out"

echo "==> 准备源码 ffmpeg-$FFMPEG_VERSION"
mkdir -p "$WORK"
cd "$WORK"
if [ ! -f ffmpeg.tar.xz ]; then
  curl -fsSL "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" -o ffmpeg.tar.xz
fi
echo "$FFMPEG_SOURCE_SHA256  ffmpeg.tar.xz" | shasum -a 256 -c -
if [ ! -d "ffmpeg-$FFMPEG_VERSION" ]; then
  tar xf ffmpeg.tar.xz
fi
cd "ffmpeg-$FFMPEG_VERSION"

echo "==> configure(LGPL:显式关掉全部 GPL/nonfree 组件)"
export PATH="/opt/homebrew/bin:$PATH"
./configure \
  --prefix="$OUT" \
  --enable-shared --disable-static \
  --disable-gpl --disable-nonfree --disable-version3 \
  --disable-doc --disable-debug \
  --enable-videotoolbox --enable-audiotoolbox \
  --disable-sdl2 \
  --disable-avdevice --disable-network --disable-xlib --disable-libxcb \
  > "$WORK/configure.log" 2>&1

LICENSE_LINE=$(grep -E "^License:" "$WORK/configure.log" || true)
echo "    $LICENSE_LINE"
if ! echo "$LICENSE_LINE" | grep -q "LGPL"; then
  echo "ERROR: configure 结果不是 LGPL,拒绝继续"; exit 1
fi

echo "==> 编译(约 5-10 分钟)"
make -j"$(sysctl -n hw.ncpu)" > "$WORK/build.log" 2>&1
make install >> "$WORK/build.log" 2>&1

echo "==> 自检:关键滤镜与编码器"
MISSING=0
for FILTER in signalstats blurdetect entropy vmafmotion scdet thumbnail blackdetect freezedetect; do
  if ! "$OUT/bin/ffmpeg" -hide_banner -filters 2>/dev/null | grep -q " $FILTER "; then
    echo "ERROR: 缺少滤镜 $FILTER"; MISSING=1
  fi
done
if ! "$OUT/bin/ffmpeg" -hide_banner -encoders 2>/dev/null | grep -q h264_videotoolbox; then
  echo "ERROR: 缺少 h264_videotoolbox 编码器"; MISSING=1
fi
if "$OUT/bin/ffmpeg" -version 2>/dev/null | grep -qE "\-\-enable-(gpl|version3|libx264|libx265)"; then
  echo "ERROR: 构建里仍含 GPL 组件"; MISSING=1
fi
[ "$MISSING" -eq 0 ] || exit 1

echo "==> 完成:$OUT"
"$OUT/bin/ffmpeg" -version 2>/dev/null | head -1
echo "    滤镜与 videotoolbox 编码器齐全,零 GPL 组件"
