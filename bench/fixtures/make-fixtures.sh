#!/bin/zsh
# R19 E-02:固定 100 条性能基准夹具。复用 scripts/qa/make-perf-fixtures.sh 的确定性生成
# 逻辑(下标 i 决定素材来源与时长,无随机数,天然锁种子),只是把数量钉死在 100、
# 输出目录钉死在本目录下的 cache/,并把 manifest.json 落进 bench/fixtures/(入库,
# 视频本身不入库——由 .gitignore 排除)。
set -euo pipefail
repo=${0:A:h:h:h}
out="${0:A:h}/cache"
"$repo/scripts/qa/make-perf-fixtures.sh" 100 "$out"
cp "$out/manifest.json" "${0:A:h}/manifest.json"
echo "manifest -> ${0:A:h}/manifest.json"
