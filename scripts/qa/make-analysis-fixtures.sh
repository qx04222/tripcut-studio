#!/bin/zsh
# R14 画面/运镜分析算法的带标签合成夹具(视频不入库,脚本入库)。
# 每条 10 s、1080p30、带音轨(除 no_audio);文件名即人工标签,期望值见 manifest.tsv。
# 用法: scripts/qa/make-analysis-fixtures.sh [输出目录,默认 ~/Library/Caches/tripcut-qa/analysis-fixtures]
# 对应回归测试: src-tauri/tests/analysis_labels.rs(读 TRIPCUT_ANALYSIS_FIXTURES=<输出目录>)。
set -euo pipefail
out=${1:-$HOME/Library/Caches/tripcut-qa/analysis-fixtures}
ffmpeg=${FFMPEG_BIN:-${FFMPEG_PATH:-$(command -v ffmpeg)}}
[[ -x $ffmpeg ]] || { echo "缺 ffmpeg(FFMPEG_BIN / FFMPEG_PATH)" >&2; exit 2 }
mkdir -p "$out"

dur=10
# 4K 底图:perlin 云纹(自然纹理)+ 加对比与锐化 + 黑格线(建筑直边)+ 几块白/黑面(窗户/阴影),
# 裁 1080p 窗口模拟运镜。实测 1080p 裁窗:YAVG≈104、YHIGH≈155、YLOW≈43、blur≈6.3、entropy≈7.3,
# 与真实街景(YAVG 74–87、YHIGH 122–151、blur 5.1–5.9、entropy 6.8–7.1)同量级;
# testsrc2 之类的色条底图纹理太少(平色区 blurdetect 给 NaN),不能当「正常素材」用。
base4k="perlin=s=3840x2160:r=30:octaves=9:persistence=0.62:xscale=20:yscale=20:tscale=0.15:random_mode=seed:random_seed=7"
tile4k="format=yuv420p,eq=contrast=2.2:brightness=-0.05,unsharp=5:5:2.5,drawgrid=w=213:h=120:t=4:c=black@0.8,drawbox=1260:740:400:260:white@0.9:t=fill,drawbox=2160:1140:300:300:black@0.9:t=fill,drawbox=400:300:350:200:white@0.9:t=fill,drawbox=3000:400:260:260:black@0.9:t=fill,drawbox=600:1700:300:180:black@0.9:t=fill,drawbox=2900:1750:380:220:white@0.9:t=fill"
center="crop=1920:1080:960:540"
# 默认音轨:-10 dBFS 正弦(有声音、不削波)。
tone="sine=f=440:d=$dur,volume=-10dB"
# 生成要用带 lavfi 输入设备的 ffmpeg(Homebrew 版即可;仓库自带的 LGPL 版没有 lavfi,只用来跑分析)。
# 视频编码:优先 VideoToolbox,没有时退回 mpeg4。
if "$ffmpeg" -hide_banner -encoders 2>/dev/null | grep -q h264_videotoolbox; then
  venc=(-c:v h264_videotoolbox -b:v 12M)
else
  venc=(-c:v mpeg4 -q:v 2)
fi
enc=($venc -pix_fmt yuv420p -c:a aac -b:a 128k -shortest -movflags +faststart)

# perlin 9 个八度在 4K 上每帧要 1 s 左右,底图只渲一次存成中间片(高码率 h264),其余夹具都从它裁。
mezz="$out/_base4k.mp4"
if [[ ! -f $mezz ]]; then
  echo "  _base4k(底图,约 4 分钟)"
  "$ffmpeg" -v error -y -f lavfi -i "$base4k" -t $dur -filter_complex "[0:v]${tile4k}[v]" -map "[v]" -an \
    $venc -b:v 60M -pix_fmt yuv420p "$mezz"
fi

gen() { # name, video-filter(对底图), [audio lavfi]
  local name=$1 vf=$2 audio=${3:-$tone} target="$out/$1.mp4"
  [[ -f $target ]] && return 0
  echo "  $name"
  "$ffmpeg" -v error -y -i "$mezz" -f lavfi -i "$audio" \
    -filter_complex "[0:v]${vf}[v]" -map "[v]" -map 1:a $enc "$target"
}

echo "生成到 $out"
# ---- 曝光 ----
gen normal          "$center"
gen underexposed    "$center,eq=brightness=-0.35"
gen overexposed     "$center,eq=brightness=0.4"
gen crushed_blacks  "$center,curves=all='0/0 0.2/0 0.5/0.5 1/1'"
# 正确曝光的低调夜景:整体压暗,但保留几处真实高光(路灯/窗户)——不得判欠曝。
gen night_correct   "$center,eq=brightness=-0.32:contrast=0.9,drawbox=200:150:70:70:white@1:t=fill,drawbox=1500:300:90:60:white@1:t=fill,drawbox=900:800:60:60:white@1:t=fill,drawbox=1700:900:50:50:white@1:t=fill"
# ---- 对焦 / 运动模糊 ----
gen soft_focus      "$center,gblur=sigma=3"
gen soft_focus_heavy "$center,gblur=sigma=8"
# 摇镜 + 帧间混合 = 运动模糊(不是虚焦)。
gen motion_blur     "crop=1920:1080:x='t*192':y=540,tblend=all_mode=average,tblend=all_mode=average"
# ---- 运镜 ----
# 真三脚架:锁定一帧循环(没有任何画面运动)。
gen static          "$center,select='eq(n,0)',loop=loop=$((dur*30-1)):size=1:start=0,setpts=N/30/TB"
# 手持抖动:2–5 Hz 多正弦叠加、幅度 ±1.7%(连续运动,像真手持;缩放到 160px 分析分辨率后 ±5 px,
# 明显大于整像素量化);handheld_strong 是每帧独立随机 ±3% 的猛抖(每 0.1 s 跳 3% 画幅,
# 比真实手持猛得多,场景切点不判)。
gen handheld        "crop=1920:1080:x='960+20*sin(2*PI*2.3*t)+12*sin(2*PI*4.1*t+1)':y='540+12*sin(2*PI*3.1*t)+8*sin(2*PI*5.3*t+2)'"
gen handheld_strong "crop=1920:1080:x='960+57*(random(0)*2-1)':y='540+32*(random(1)*2-1)'"
gen pan_slow        "crop=1920:1080:x='t*96':y=540"
gen pan_fast        "crop=1920:1080:x='t*192':y=540"
gen tilt_slow       "crop=1920:1080:x=960:y='t*54'"
gen tilt_fast       "crop=1920:1080:x=960:y='t*108'"
gen zoom            "zoompan=z='min(1+0.0012*on,1.4)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30"
# 弱光 + 手持:两个缺陷叠加,但夜景本身曝光是对的。
gen night_handheld  "crop=1920:1080:x='960+20*sin(2*PI*2.3*t)+12*sin(2*PI*4.1*t+1)':y='540+12*sin(2*PI*3.1*t)+8*sin(2*PI*5.3*t+2)',eq=brightness=-0.32:contrast=0.9,drawbox=200:150:70:70:white@1:t=fill,drawbox=1500:300:90:60:white@1:t=fill,drawbox=900:800:60:60:white@1:t=fill"
# ---- 场景切换:三段不同内容硬切(3.33 s / 6.67 s)。 ----
if [[ ! -f $out/scene_cuts.mp4 ]]; then
  echo "  scene_cuts"
  "$ffmpeg" -v error -y \
    -f lavfi -i "testsrc2=s=1920x1080:r=30:d=3.34" \
    -f lavfi -i "smptehdbars=s=1920x1080:r=30:d=3.33" \
    -f lavfi -i "testsrc=s=1920x1080:r=30:d=3.33" \
    -f lavfi -i "$tone" \
    -filter_complex "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]" -map "[v]" -map 3:a $enc "$out/scene_cuts.mp4"
fi
# ---- 声音 ----
gen silent_track    "$center" "anullsrc=r=48000:cl=stereo"
gen clipped_audio   "$center" "sine=f=440:d=$dur,volume=20dB"
if [[ ! -f $out/no_audio.mp4 ]]; then
  echo "  no_audio"
  "$ffmpeg" -v error -y -i "$mezz" -filter_complex "[0:v]${center}[v]" -map "[v]" -an \
    $venc -pix_fmt yuv420p -movflags +faststart "$out/no_audio.mp4"
fi

# 期望标签(测试读这张表;`*` = 不判,运镜类可写 a|b):
# 列 = 文件 欠曝 过曝 过暗(已退场,只记录) 虚焦 疑似失焦 抖动 运镜类 切点数 削波 有音轨 时刻曝光正常占比下限 废片旗 运动适中占比下限/上限
cat > "$out/manifest.tsv" <<'EOF'
file	under	over	dark	oof	soft	shaky	motion	cuts	clipped	has_audio	exposure_ok_min	safety	moderate_min	moderate_max
normal	0	0	0	0	0	0	static	0	0	1	0.9	normal	*	*
underexposed	1	0	*	0	*	0	static	0	0	1	0.0	*	*	*
overexposed	0	1	0	0	*	0	static	0	0	1	0.0	*	*	*
crushed_blacks	0	0	0	0	0	0	static	0	0	1	0.9	normal	*	*
night_correct	0	0	*	0	0	0	static	0	0	1	0.9	normal	*	*
soft_focus	0	0	0	*	*	0	static	0	0	1	0.9	normal	*	*
soft_focus_heavy	0	0	0	1	*	0	static	0	0	1	0.9	*	*	*
motion_blur	0	0	0	0	*	0	pan	0	0	1	0.9	normal	0.9	*
static	0	0	0	0	0	0	static	0	0	1	0.9	normal	*	0.1
handheld	0	0	0	0	0	1	handheld	0	0	1	0.9	normal	0.9	*
handheld_strong	0	0	0	0	0	1	handheld	*	0	1	0.9	normal	0.9	*
pan_slow	0	0	0	0	0	0	pan	0	0	1	0.9	normal	0.9	*
pan_fast	0	0	0	0	0	0	pan	0	0	1	0.9	normal	0.9	*
tilt_slow	0	0	0	0	0	0	tilt	0	0	1	0.9	normal	0.9	*
tilt_fast	0	0	0	0	0	0	tilt	0	0	1	0.9	normal	0.9	*
zoom	0	0	0	0	0	0	zoom	0	0	1	0.9	normal	*	*
night_handheld	0	0	*	0	0	1	handheld	0	0	1	0.9	normal	0.9	*
scene_cuts	0	0	0	0	*	0	*	2	0	1	0.9	normal	*	*
silent_track	0	0	0	0	0	0	static	0	0	1	0.9	normal	*	*
clipped_audio	0	0	0	0	0	0	static	0	1	1	0.9	normal	*	*
no_audio	0	0	0	0	0	0	static	0	0	0	0.9	normal	*	*
EOF
echo "完成:$(ls "$out"/[a-z]*.mp4 | wc -l | tr -d ' ') 条 + manifest.tsv"
