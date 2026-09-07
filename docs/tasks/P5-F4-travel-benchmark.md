# 任务卡 P5-F4:旅行原生 Benchmark 与回归装置(大验收骨架)

状态:排队(F1-F3 后,大验收前)。实施:Codex(装置)+Claude(执行与判定)。依据:附录 E.3。

## 范围
- `benchmark/` 目录:场景七组(A-G)夹具清单 manifest(现有 97 条归入 Seed;G 组"坏素材但重要"用 ffmpeg 合成:强抖动+高价值转写口播/欠曝+异常事件标签等,每组 ≥5 条,合成方式写脚本可复现)
- **Golden Moments 标注**:manifest 里人工标 `golden: true` 的条目(G 组全部+各组代表),装置断言全部出现在推荐/保留侧——**Critical Recall=100% 是发布门禁,低于即 FAIL**
- 回归 runner `benchmark/run.sh`:对干净临时库执行 导入→全分析→Stack→(可选L3编排跳过)→导出;产出 metrics.json:Scene 边界 P/R(对 manifest 期望)/Stack 精度/重要事件召回/Safety 三项(原始删除=0 用目录 hash 前后比对断言)/VFR 同步误差(PTS 比对)/Proxy 映射误差/Routine 重复率
- 结果落 `benchmark/results/<日期>.json`;`compare.sh` 对比上一版,回归项标红
- CI 化留待有证书流水线时;本地一条命令可跑
## 验收
装置对当前 main 跑通并产出首版基线;Golden Moments 100%;我(主审)对 metrics 逐项人工复核一次。
## 纪律
夹具生成脚本入库,媒体文件不入库(manifest 记生成命令);不碰应用代码(只加 benchmark/)。
