#!/bin/zsh
# R18 AI 评测的「语义可判」合成夹具(视频不入库,脚本入库)。
#
# 为什么要它:`make-analysis-fixtures.sh` 那 20 条只能测画质/运镜 —— 里面没有一个字、
# 没有一句话,所以 OCR 与转写这两条真模型链路**一条断言都没有**。这 8 条把那个洞补上:
# 中文招牌(测 OCR)、中文口播(测转写与口播判定)、静音/无字对照组(测**不该**误报),
# 外加两条主体色块(构图/主体存在)。真值是构造出来的,天然确定,不需要人工标。
#
# 用法: scripts/qa/make-ai-fixtures.sh [输出目录,默认 ~/Library/Caches/tripcut-qa/ai-fixtures]
# 对应回归: src-tauri/tests/ai_labels.rs(读 TRIPCUT_AI_EVAL_FIXTURES=<输出目录>)。
# 依赖: ffmpeg(带 lavfi)、ImageMagick(magick)、macOS 的 say。
#   —— 文字**不是**用 ffmpeg drawtext 画的:Homebrew 的 ffmpeg 9 没编 freetype,drawtext 直接不存在。
#      改成 magick 先把中文渲成 PNG,再用 overlay 贴上去,顺带不依赖 ffmpeg 的字体配置。
set -euo pipefail
out=${1:-$HOME/Library/Caches/tripcut-qa/ai-fixtures}
ffmpeg=${FFMPEG_BIN:-${FFMPEG_PATH:-$(command -v ffmpeg)}}
[[ -x $ffmpeg ]] || { echo "缺 ffmpeg(FFMPEG_BIN / FFMPEG_PATH)" >&2; exit 2 }
command -v magick >/dev/null || { echo "缺 ImageMagick(brew install imagemagick):中文牌匾要它渲染" >&2; exit 2 }
command -v say    >/dev/null || { echo "缺 macOS 的 say:中文口播要它合成" >&2; exit 2 }
font=${TRIPCUT_QA_CJK_FONT:-/System/Library/Fonts/STHeiti Medium.ttc}
[[ -f $font ]] || { echo "缺中文字体 $font(可用 TRIPCUT_QA_CJK_FONT 覆盖)" >&2; exit 2 }
voice=${TRIPCUT_QA_ZH_VOICE:-Tingting}
say -v '?' | grep -q "^${voice} " || { echo "系统没有中文语音 $voice(系统设置 › 辅助功能 › 朗读内容 里下载)" >&2; exit 2 }
mkdir -p "$out"
work="$out/_work"; mkdir -p "$work"

dur=10
if "$ffmpeg" -hide_banner -encoders 2>/dev/null | grep -q h264_videotoolbox; then
  venc=(-c:v h264_videotoolbox -b:v 10M)
else
  venc=(-c:v mpeg4 -q:v 2)
fi
enc=($venc -pix_fmt yuv420p -c:a aac -b:a 128k -shortest -movflags +faststart)

# 底图:1080p perlin(5 个八度,几秒就好;analysis 夹具那张 4K 9 octaves 要 4 分钟,这里用不上那么细)。
# 要有纹理,不能用平色 —— 平色区 blurdetect 给 NaN,整条素材会被判成"不可分析"而不是"没有文字"。
base="perlin=s=1920x1080:r=30:octaves=5:persistence=0.55:xscale=26:yscale=26:tscale=0.12:random_mode=seed:random_seed=18"
tile="format=yuv420p,eq=contrast=1.9:brightness=-0.02,unsharp=5:5:2.0"
mezz="$work/_base.mp4"
if [[ ! -f $mezz ]]; then
  echo "  _base(底图)"
  "$ffmpeg" -v error -y -f lavfi -i "$base" -t $dur -filter_complex "[0:v]${tile}[v]" -map "[v]" -an \
    $venc -b:v 30M -pix_fmt yuv420p "$mezz"
fi

# 环境底噪:−30 dBFS 粉噪。有音轨、不静音、也绝不会被当成人声。
amb="anoisesrc=c=pink:r=44100:d=${dur}:a=0.03"

# --- 牌匾:白底黑字,四周留白,尺寸够大(1080p 上字高 ≥110 px,OCR 才有机会) ---
sign() { # 输出png, 宽, 高, 字号, 文字...(每个参数一行)
  local png=$1 w=$2 h=$3 pt=$4; shift 4
  local text="$1"; shift
  for line in "$@"; do text="$text
$line"; done
  magick -size "${w}x${h}" xc:white -bordercolor '#101010' -border 6 \
    -font "$font" -pointsize "$pt" -fill '#101010' -gravity center -annotate +0+0 "$text" "$png"
}
sign "$work/sign_shop.png"   1000 300 150 "城南面馆"
sign "$work/sign_street.png" 1100 420 110 "解放路 128 号" "营业中"
sign "$work/sign_book.png"   1000 300 150 "山海书店"

# --- 中文口播 ---
speak() { # 输出wav, 文本
  local wav=$1
  local text=$2
  local aiff="${wav%.wav}.aiff"
  [[ -f $wav ]] && return 0
  say -v "$voice" -o "$aiff" "$text"
  "$ffmpeg" -v error -y -i "$aiff" -ac 1 -ar 44100 "$wav"
}
# vo_full ≈6.1 s、vo_short ≈1.9 s,下面 manifest 的 best_window 就是按这两个长度写的。
speak "$work/vo_full.wav"  "今天我们从城南面馆出发，沿着解放路一直走到山海书店。"
speak "$work/vo_short.wav" "这一段有人在说话。"

# ---- 生成 ----
# 1/2/7/8:无口播,音轨只有粉噪;3/4/5:口播叠在粉噪上;6:对照组。
gen_v() { # name, 贴图/滤镜表达式(对底图)
  local name=$1 vf=$2 target="$out/$1.mp4"
  [[ -f $target ]] && return 0
  echo "  $name"
  "$ffmpeg" -v error -y -i "$mezz" -f lavfi -i "$amb" \
    -filter_complex "$vf" -map "[v]" -map 1:a $enc "$target"
}
gen_vo() { # name, 贴图/滤镜表达式, 口播wav, 口播起点秒(可多个,逗号分隔)
  local name=$1 vf=$2 wav=$3 starts=$4 target="$out/$1.mp4"
  [[ -f $target ]] && return 0
  echo "  $name"
  local inputs=(-i "$mezz" -f lavfi -i "$amb") n=2 mix="[1:a]"
  local delays=()
  for s in ${(s:,:)starts}; do
    inputs+=(-i "$wav")
    delays+=("[${n}:a]adelay=$((s*1000))|$((s*1000))[d${n}];")
    mix="${mix}[d${n}]"
    n=$((n+1))
  done
  "$ffmpeg" -v error -y $inputs \
    -filter_complex "${vf};${delays}${mix}amix=inputs=$((n-1)):duration=first:normalize=0,volume=2.0[a]" \
    -map "[v]" -map "[a]" $enc "$target"
}

echo "生成到 $out"
# 招牌固定在画面上三分之一(真实招牌的位置),底图本身静止。
overlay_c="[1:v]null[sig];[0:v][sig]overlay=(W-w)/2:(H-h)/3[v]"
# 带缓慢横移的招牌:招牌跟着画面一起走,测 OCR 对轻微运动的鲁棒性。
overlay_pan="[1:v]null[sig];[0:v][sig]overlay='(W-w)/2+60*sin(2*PI*t/10)':(H-h)/3[v]"

png_gen() { # name, png, overlay表达式, [口播wav 起点]
  local name=$1 png=$2 ov=$3 wav=${4:-} starts=${5:-}
  local target="$out/$name.mp4"
  [[ -f $target ]] && return 0
  echo "  $name"
  if [[ -z $wav ]]; then
    "$ffmpeg" -v error -y -i "$mezz" -i "$png" -f lavfi -i "$amb" \
      -filter_complex "$ov" -map "[v]" -map 2:a $enc "$target"
  else
    local inputs=(-i "$mezz" -i "$png" -f lavfi -i "$amb") n=3 mix="[2:a]" delays=()
    for s in ${(s:,:)starts}; do
      inputs+=(-i "$wav")
      delays+=("[${n}:a]adelay=$((s*1000))|$((s*1000))[d${n}];")
      mix="${mix}[d${n}]"
      n=$((n+1))
    done
    "$ffmpeg" -v error -y $inputs \
      -filter_complex "${ov};${delays}${mix}amix=inputs=$((n-2)):duration=first:normalize=0,volume=2.0[a]" \
      -map "[v]" -map "[a]" $enc "$target"
  fi
}

png_gen zh_sign_shop   "$work/sign_shop.png"   "$overlay_c"
png_gen zh_sign_street "$work/sign_street.png" "$overlay_pan"
png_gen zh_sign_speech "$work/sign_book.png"   "$overlay_c" "$work/vo_full.wav" "1"
gen_vo  zh_speech_only "[0:v]null[v]"          "$work/vo_full.wav" "1"
gen_vo  zh_speech_gap  "[0:v]null[v]"          "$work/vo_short.wav" "0,7"
gen_v   silent_control "[0:v]null[v]"
# 主体色块:灰底 + 正中一块大红(单一主体)/ 上下分色(两段式构图)。不含文字、不含人声。
gen_v subject_red_block  "[0:v]drawbox=660:290:600:500:red@1:t=fill[v]"
# 分色块只占中间 1152x648,四周留出底图纹理 —— 满屏平色会让 blurdetect 给 NaN,
# 那样整条会被判成"不可分析"而不是"没有文字",负控就失效了。
gen_v subject_split_tone "[0:v]drawbox=384:216:1152:324:#2f6fd0@1:t=fill,drawbox=384:540:1152:324:#2f8f3a@1:t=fill[v]"

# 真值表:列与 qa/ai-eval/manifest.tsv 逐字相同(同一个 harness 读两边)。
#   quick_hash/byte_size 写 `*` —— 合成片每次重编码都不一样,哈希对不上是正常的。
#   ocr_expect 的 `-` = **期望 OCR 认不出任何字**(负控);speech=0 同理是"不该判有人说话"。
cat > "$out/manifest.tsv" <<'EOF'
# make-ai-fixtures.sh 生成的语义可判合成夹具(真值是构造出来的)。
# `*` = 不判;`a|b` = 任一;ocr_expect 的 `-` = 期望**没有**任何 OCR 文字(负控)。
file	quick_hash	byte_size	subject	shot_size	viewpoint	function	person_state	ocr_expect	speech	has_audio	best_window
zh_sign_shop	*	*	*	*	*	Information	*	城南面馆	0	1	*
zh_sign_street	*	*	*	*	*	Information	*	解放路|128|营业中	0	1	*
zh_sign_speech	*	*	*	*	*	Information	*	山海书店	1	1	1.0-6.0
zh_speech_only	*	*	*	*	*	*	*	-	1	1	1.0-6.0
zh_speech_gap	*	*	*	*	*	*	*	-	1	1	0.0-2.0
silent_control	*	*	*	*	*	*	*	-	0	1	*
subject_red_block	*	*	*	*	*	*	*	-	0	1	*
subject_split_tone	*	*	*	*	*	*	*	-	0	1	*
EOF
echo "完成:$(ls "$out"/*.mp4 | wc -l | tr -d ' ') 条 + manifest.tsv"
