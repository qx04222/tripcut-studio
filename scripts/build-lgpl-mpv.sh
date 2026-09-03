#!/bin/zsh
# 构建 LGPL 版 libmpv,供 .app 内嵌进程内播放(NSOpenGLView + mpv_render_context)。
#
# 为什么需要它:Homebrew 的 libmpv(/opt/homebrew/opt/mpv/lib/libmpv.2.dylib)
# 链接的是 Homebrew 的 GPL 版 ffmpeg(--enable-gpl --enable-libx264 --enable-libx265),
# 打包 Homebrew libmpv 会把 libx264/libx265 一起拖进 .app,整个软件被 GPLv3 传染。
# 必须自编一个链到项目自建 LGPL ffmpeg(build-lgpl-ffmpeg.sh 产物)的 libmpv。
#
# mpv 自身也有 GPL/LGPL 双重构建模式:-Dgpl=false 关掉 mpv 内部的 GPL 专属代码路径
# (与"链接的 ffmpeg 是不是 GPL"是两件独立的事,必须同时满足)。
#
# 依赖:先跑过 build-lgpl-ffmpeg.sh,产出在 $FFMPEG_OUT/lib/pkgconfig 下有
# libavcodec.pc 等文件。本脚本靠 PKG_CONFIG_PATH 把它排在 Homebrew 前面,
# 让 mpv 的 meson 依赖探测优先找到 LGPL ffmpeg,而不是 Homebrew 的 GPL ffmpeg。
#
# 产物:$OUT/lib/libmpv.*.dylib + $OUT/include/mpv/*.h,由 package-dmg.sh 内嵌进 .app。
set -euo pipefail

MPV_TAG="${MPV_TAG:-v0.41.0}"
MPV_COMMIT="${MPV_COMMIT:-41f6a645068483470267271e1d09966ca3b9f413}"
WORK="${WORK:-/tmp/mpv-lgpl}"
OUT="$WORK/out"
FFMPEG_OUT="${FFMPEG_OUT:-/tmp/ffmpeg-lgpl/out}"
LIBPLACEBO_OUT="${LIBPLACEBO_OUT:-/tmp/libplacebo-tripcut/out-v7.360.1-opengl}"

export PATH="/opt/homebrew/bin:$PATH"

echo "==> 检查前置条件:LGPL ffmpeg 必须已经编译好"
if [ ! -f "$FFMPEG_OUT/lib/pkgconfig/libavcodec.pc" ]; then
  echo "ERROR: 找不到 $FFMPEG_OUT/lib/pkgconfig/libavcodec.pc"
  echo "       先跑 build-lgpl-ffmpeg.sh"
  exit 1
fi
[ -f "$LIBPLACEBO_OUT/lib/libplacebo.360.dylib" ] || {
  echo "ERROR: 找不到 TripCut 专用 libplacebo；先跑 scripts/build-libplacebo.sh"; exit 1
}
if otool -L "$LIBPLACEBO_OUT/lib/libplacebo.360.dylib" | grep -qE 'libvulkan|libshaderc'; then
  echo "ERROR: libplacebo 仍含未使用的 Vulkan/shaderc 依赖"; exit 1
fi
if ! grep -q "^License: LGPL" "/tmp/ffmpeg-lgpl/configure.log" 2>/dev/null; then
  echo "WARN: 没找到 ffmpeg configure.log 里的 License: LGPL 记录,继续但请自行确认"
fi

echo "==> 检查构建工具(meson/ninja/pkg-config)"
for TOOL in meson ninja pkg-config; do
  if ! command -v "$TOOL" >/dev/null 2>&1; then
    echo "==> 缺 $TOOL,用 brew 安装"
    brew install meson ninja pkg-config
    break
  fi
done

echo "==> 准备源码 mpv $MPV_TAG"
mkdir -p "$WORK"
cd "$WORK"
if [ ! -d mpv ]; then
  git clone --depth 1 --branch "$MPV_TAG" https://github.com/mpv-player/mpv.git
else
  echo "    已存在,跳过 clone(如需换版本请先删除 $WORK/mpv)"
fi
cd mpv
ACTUAL_MPV_COMMIT="$(git rev-parse HEAD)"
[ "$ACTUAL_MPV_COMMIT" = "$MPV_COMMIT" ] || {
  echo "ERROR: mpv 源码提交不符：期望 $MPV_COMMIT，实际 $ACTUAL_MPV_COMMIT"; exit 1
}

# ---- 上游补丁:CoreAudio 热插拔监听器的 use-after-free ----
#
# v0.41.0 的 ao_coreaudio.c 在 init 失败时不调 uninit,已经注册的 hotplug 监听器
# 就留在一个马上要被释放的 struct ao 上。之后任何音频设备变更事件都会打进
# hotplug_cb → MP_VERBOSE(ao,...) → mp_msg,踩到已释放的 ao->log。
# 历史候选实测崩溃栈（退出时 SIGSEGV，崩在 HALC 通知队列上）：
#   mp_msg_va ← mp_msg ← hotplug_cb ← HALObject::PropertiesChanged ← HALC_ProxyNotifications
# 注意 AudioObjectRemovePropertyListener 不会等待在途回调,所以这个竞态只能靠
# "不留下悬挂监听器"来根治,不能靠销毁时序绕开。
#
# 上游已在 0.41.0 之后修复,这里 cherry-pick 那两个提交:
#   af067b5 ao_coreaudio: cleanup ao on init failure
#   c5d391a ao_coreaudio: register hotplug after succesful audiounit init
# 换 MPV_TAG 时如果这两个提交已经进了发布版,下面的 is-ancestor 判断会自动跳过。
MPV_FIXES=(af067b5ea8e5fe396ebd9d3f895e51a7e75b3c09 c5d391a)
if grep -q "uninit(ao);" audio/out/ao_coreaudio.c \
  && grep -q "if (p->audio_unit) {" audio/out/ao_coreaudio.c; then
  echo "    ao_coreaudio hotplug 修复已存在,保持幂等"
else
  NEED_FETCH=1
  for FIX in "${MPV_FIXES[@]}"; do
    if git merge-base --is-ancestor "$FIX" HEAD 2>/dev/null; then
      echo "    上游修复 ${FIX:0:7} 已含在 $MPV_TAG,跳过"
      continue
    fi
    if [ "$NEED_FETCH" = 1 ]; then
      echo "==> 拉取上游 master 以取修复提交"
      git fetch --quiet --depth=200 origin master
      NEED_FETCH=0
    fi
    echo "==> cherry-pick 上游修复 ${FIX:0:7}"
    git -c user.name=build -c user.email=build@local cherry-pick --no-commit "$FIX" \
      || { echo "ERROR: cherry-pick ${FIX:0:7} 失败(源码版本可能已变),请人工核对"; exit 1; }
  done
fi
# 自检:补丁必须真的落到文件里,否则后面编出来的还是会崩的版本。
grep -q "uninit(ao);" audio/out/ao_coreaudio.c \
  && grep -q "if (p->audio_unit) {" audio/out/ao_coreaudio.c \
  || { echo "ERROR: ao_coreaudio.c 里没看到修复痕迹,拒绝继续"; exit 1; }
echo "    ao_coreaudio hotplug 修复已就位"

echo "==> meson setup(LGPL:-Dgpl=false,只要 libmpv,不要 cplayer 命令行程序)"
# PKG_CONFIG_PATH 顺序很关键:LGPL ffmpeg 的 pkgconfig 目录放最前面,
# 这样 libavcodec/libavformat/... 这些包名会先命中我们自编的 LGPL 版本,
# 而不是 /opt/homebrew/lib/pkgconfig 里被 symlink 进去的 Homebrew GPL ffmpeg。
# libass/libplacebo 等非 ffmpeg 依赖仍然从 Homebrew 拿(它们本身不是 GPL)。
export PKG_CONFIG_PATH="$FFMPEG_OUT/lib/pkgconfig:$LIBPLACEBO_OUT/lib/pkgconfig:/opt/homebrew/lib/pkgconfig:/opt/homebrew/share/pkgconfig"

rm -rf build
meson setup build \
  -Dgpl=false \
  -Dcplayer=false \
  -Dlibmpv=true \
  -Dgl=enabled \
  -Dplain-gl=enabled \
  -Dvideotoolbox-gl=enabled \
  -Dvideotoolbox-pl=disabled \
  -Dvulkan=disabled \
  -Dshaderc=disabled \
  -Dzimg=disabled \
  -Dcdda=disabled \
  -Ddvdnav=disabled \
  -Ddvbin=disabled \
  -Djavascript=disabled \
  -Drubberband=disabled \
  -Dlibarchive=disabled \
  -Dlibbluray=disabled \
  -Dvapoursynth=disabled \
  -Dlua=disabled \
  -Dmanpage-build=disabled \
  -Dhtml-build=disabled \
  -Dpdf-build=disabled \
  -Dtests=false \
  --prefix="$OUT" \
  --buildtype=release \
  > "$WORK/meson-setup.log" 2>&1

# meson 配置阶段就会把 gpl 选项的实际生效值打印出来,这里直接抓取核对,
# 不要等编译完才发现选错了。
if ! grep -qE "^\s*gpl\s+: false" "$WORK/meson-setup.log"; then
  echo "ERROR: meson 里 gpl 选项没有生效为 false"; exit 1
fi
if ! grep -qE "^\s*libmpv\s+: true" "$WORK/meson-setup.log"; then
  echo "ERROR: libmpv 选项没有生效为 true"; exit 1
fi
if ! grep -qE "^\s*rubberband\s+: (false|disabled)" "$WORK/meson-setup.log"; then
  echo "ERROR: rubberband 选项没有生效为 false"; exit 1
fi
for DISABLED_OPTION in vulkan shaderc zimg videotoolbox-pl; do
  if ! grep -qE "^[[:space:]]*${DISABLED_OPTION}[[:space:]]*:[[:space:]]+disabled" "$WORK/meson-setup.log"; then
    echo "ERROR: $DISABLED_OPTION 没有被明确禁用"; exit 1
  fi
done

echo "==> 编译(约 3-8 分钟)"
ninja -C build -j"$(sysctl -n hw.ncpu)" > "$WORK/build.log" 2>&1

echo "==> 安装到 $OUT"
ninja -C build install >> "$WORK/build.log" 2>&1

LIBMPV=$(find "$OUT/lib" -maxdepth 1 -name 'libmpv.*.dylib' ! -type l | head -1)
if [ -z "$LIBMPV" ]; then
  echo "ERROR: 没找到 libmpv.*.dylib 产物"; exit 1
fi

echo "==> 自检 1/3:链接的 ffmpeg 必须来自 $FFMPEG_OUT,不能有 /opt/homebrew/opt/ffmpeg"
if otool -L "$LIBMPV" | grep -q "/opt/homebrew/opt/ffmpeg"; then
  echo "ERROR: 仍然链接了 Homebrew 的 ffmpeg"; exit 1
fi
if ! otool -L "$LIBMPV" | grep -q "$FFMPEG_OUT/lib"; then
  echo "ERROR: 没有链接到期望的 LGPL ffmpeg ($FFMPEG_OUT/lib)"; exit 1
fi
echo "    OK: $(otool -L "$LIBMPV" | grep -c "$FFMPEG_OUT/lib") 个 ffmpeg 库来自 $FFMPEG_OUT"

echo "==> 自检 2/3:递归展开整棵依赖树,查有没有 x264/x265/dvdnav 等 GPL 库"
SEEN_FILE=$(mktemp)
QUEUE_FILE=$(mktemp)
echo "$LIBMPV" >> "$QUEUE_FILE"
while [ -s "$QUEUE_FILE" ]; do
  LIB=$(head -1 "$QUEUE_FILE")
  sed -i '' '1d' "$QUEUE_FILE"
  grep -qxF "$LIB" "$SEEN_FILE" 2>/dev/null && continue
  echo "$LIB" >> "$SEEN_FILE"
  [ -f "$LIB" ] || continue
  otool -L "$LIB" 2>/dev/null | tail -n +2 | awk '{print $1}' | while read -r dep; do
    case "$dep" in @*) continue ;; esac
    echo "$dep" >> "$QUEUE_FILE"
  done
done
if sort -u "$SEEN_FILE" | grep -iE 'x264|x265|libdvdread|libdvdnav|libdvdcss|libcdio|libSDL|librubberband|libvulkan|libshaderc|libzimg'; then
  echo "ERROR: 依赖树里发现 GPL 风险库(上面列出)"
  rm -f "$SEEN_FILE" "$QUEUE_FILE"
  exit 1
fi
echo "    OK: 依赖树里($( wc -l < "$SEEN_FILE" | tr -d ' ') 个库)未发现 GPL/不批准依赖"
rm -f "$SEEN_FILE" "$QUEUE_FILE"

echo "==> 自检 3/3:render API 符号必须齐全(mpv_render_context_create 等)"
MISSING=0
for SYM in mpv_render_context_create mpv_render_context_render mpv_render_context_report_swap \
           mpv_render_context_set_parameter mpv_render_context_free mpv_render_context_set_update_callback; do
  if ! nm -gU "$LIBMPV" | grep -q "_${SYM}\$"; then
    echo "ERROR: 缺少符号 $SYM"; MISSING=1
  fi
done
[ "$MISSING" -eq 0 ] || exit 1

echo "==> 完成:$OUT"
echo "    $LIBMPV"
otool -L "$LIBMPV" | head -1
echo "    LGPL ffmpeg 链接正确,零 GPL 风险库,render API 齐全"
