#!/bin/zsh
# 生成性能验收夹具:以仓库内两条 4K HEVC 母本 -c copy 切 10/30/120 s,再加 lavfi 合成的 1080p H.264。
# 用法: scripts/qa/make-perf-fixtures.sh [数量,默认 500] [输出目录]
set -euo pipefail
count=${1:-500}
out=${2:-$HOME/Library/Caches/tripcut-perf/fixtures}
repo=${0:A:h:h:h}
ffmpeg=${FFMPEG_BIN:-$(command -v ffmpeg)}
[[ -x $ffmpeg ]] || { echo "缺 ffmpeg" >&2; exit 2 }
mkdir -p "$out"
masters=("$repo/spikes/s2-libmpv/media/test-4k-hevc-10bit.mp4" "$repo/spikes/s2-libmpv/media/test-4k-hevc.mp4")
durations=(10 30 120)
manifest="$out/manifest.json"
i=0
while (( i < count )); do
  kind=$(( i % 4 ))
  name=$(printf 'perf_%04d.mp4' $i)
  target="$out/$name"
  if [[ ! -f $target ]]; then
    if (( kind == 3 )); then
      "$ffmpeg" -v error -y -f lavfi -i "testsrc2=size=1920x1080:rate=30" -f lavfi -i "sine=frequency=440" \
        -t 20 -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -metadata title="perf-$i" "$target" \
        2>/dev/null || "$ffmpeg" -v error -y -f lavfi -i "testsrc2=size=1920x1080:rate=30" -f lavfi -i "sine=frequency=440" \
        -t 20 -c:v h264_videotoolbox -pix_fmt yuv420p -c:a aac -metadata title="perf-$i" "$target"
    else
      src=${masters[$(( kind % 2 + 1 ))]}
      dur=${durations[$(( (i / 4) % 3 + 1 ))]}
      "$ffmpeg" -v error -y -ss 0 -t $dur -i "$src" -c copy -metadata title="perf-$i" -movflags +faststart "$target"
    fi
  fi
  (( ++i ))
done

entries=()
i=0
while (( i < count )); do
  kind=$(( i % 4 ))
  name=$(printf 'perf_%04d.mp4' $i)
  target="$out/$name"
  if (( kind == 3 )); then
    src="lavfi-1080p"; dur=20
  else
    src=${masters[$(( kind % 2 + 1 ))]}
    dur=${durations[$(( (i / 4) % 3 + 1 ))]}
  fi
  size=$(stat -f %z "$target")
  entries+=("{\"file\":\"$name\",\"source\":\"${src:t}\",\"duration_s\":$dur,\"bytes\":$size}")
  (( ++i ))
done
print -- "[${(j:,:)entries}]" > "$manifest"
echo "fixtures=$count dir=$out bytes=$(du -sk "$out" | cut -f1)K"
