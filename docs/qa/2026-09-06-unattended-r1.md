# 无人值守 R1 性能 — 2026-09-06

## 1. 目标与工作项
目标：16 GB Apple Silicon 全流程不进 swap，整机峰值 < 4 GB，首屏缩略图 < 30 s。计划 `docs/superpowers/plans/2026-09-06-r1-performance.md`。
工作项（全部合入 main）：
- Task 1 硬解优先/软解回退公共执行器（b50b9cb）
- Task 2 封面缩略图先缩放再选帧 + 硬解（caa4ffe）
- Task 3 L1 分析场景检测后置到 2fps/640 + 硬解，流水线 v4（52fb952）
- Task 4 胶片条/运镜硬解，>60 s 且 GOP 探测通过时只解关键帧（4d635f9, 44dc822）
- Task 6 内存档位与预算/压力探针（9110a2d, 8094ed3）
- Task 7 解码/大模型资源许可、同素材串行、压力暂停不挡导出（3e52d3f, 0bf9b56）
- Task 8 CLIP sidecar 空闲卸载、按帧数超时、冷启动 600 s（c514160, b26c6a3, 8f659f3, e1c6958）
- Task 9 mpv 缓存上限、代理磁盘水位、省内存档代理参数（25fb0f1）
迁移号：本轮无。

## 2. 快照与测量
起始 main 64f6df0 → 本轮代码结束 25fb0f1（之后 R2/R3 合并继续推进）。装置：`scripts/qa/perf-harness.mjs`，500 条夹具（`~/Library/Caches/tripcut-perf/fixtures`），4 worker，M5/32 GB。两次测量都没有 Chinese-CLIP 模型（基线 clip_embed p50 3 ms，本轮 500 条 blocked 并单列），可比。

| 指标 | 基线（R0，54.6 min 跑） | 批次 1+2（R1 全部合入） | 变化 |
|---|---|---|---|
| 整机峰值 RSS | 7.42 GB | 3.80 GB | −49% |
| 整机 p95 RSS | 3.59 GB | 3.07 GB | −14% |
| 总耗时 | 54.6 min | 34.8 min | −36% |
| 首屏 24 张封面 | 55.6 s | 43.5 s | −22%（目标 30 s 未达） |
| swapouts | 0 | 0 | — |
| thumbnail p50 | 5.57 s | 3.82 s | −31% |
| analyze_l1 p50 | 9.34 s | 4.34 s | −54% |
| proxy p50 | 4.97 s | 2.96 s | −40% |

单项实测（30 s 4K HEVC 10-bit）：封面峰值 1.74 → 0.78 GB；分析 CPU 20.1 → 2.9 s，判据字段逐位相同；胶片条硬解 853 MB、关键帧模式 308 MB；90 s 素材硬解+关键帧 416 MB，尾格无黑。

预算档（`--budget-gb 12`，`qa/runs/2026-09-06T19-55-36Z-perf-r1-budget16`）：峰值 3.48 GB、p95 3.08 GB、总耗时 34.7 min、首屏 43.0 s、swapouts 24。两点如实说明：①swapouts 是整机计数，本次运行期间另有三条车道在跑 cargo 编译，不能归因于应用；②**装置缺口**：`perf_driver` 直接调 `JobRunner::run_one`，绕过了带解码许可/压力暂停的协调器，所以省内存档的限流在装置里根本没生效（总耗时与标准档几乎相同就是证据）。记 F-R1-9，R6 修装置后再测预算档。
（R6 Task 7d 复核注：`r1-budget16` 这个标签名字带的是机器档位语义,实际传的是 `--budget-gb 12`，也就是 Low 档,不是这台 32 GB 机器的标准档；本节以上数字未改动,仅补这句说明——`perf-harness.mjs` 现在把 `--budget-gb` 改成必填,不再有 12 这个隐藏默认值。）

## 3. 门禁记录
每次合并后 `node scripts/qa/fast-gates.mjs` 以 `gate.json.status` 判定：全部 PASS（qa/runs/2026-09-06T17-10-54Z 起多次）。性能装置：`qa/runs/2026-09-06T06-05-37Z-perf-baseline`、`qa/runs/2026-09-06T19-18-15Z-perf-r1-batch2`。

## 4. FINDINGS
- F-R1-1 showinfo 挪到 fps 之后时 `pts:` 变成滤镜时间基，场景切点偏差约 1000 倍 → 改解析 `pts_time:` 并按 tb 转 tick（52fb952）→ 既有硬切测试先红后绿。
- F-R1-2 `-skip_frame nokey` 在长 GOP 尾部会出黑格 → 封包级 GOP 探测（最大间隔与末关键帧距尾 ≤ 一格）才启用（44dc822）→ 单测先红。
- F-R1-3 可用内存百分比分母漏压缩页与投机页，压力越大越乐观 → 分母改 hw.memsize（8094ed3）→ 与 vm_stat 手算 46% 一致。
- F-R1-4 mpv `aid` 是 1 基而 stream_index 是 0 基（R3 Task 5 发现，同源问题）→ 转换只在 `mpv_calls_for` 一处（f970fc5）。
- F-R1-5 sidecar 冷启动模型加载约 200 s，新超时 60 s 会形成超时→重启→再超时死循环 → 首次调用用 600 s（b26c6a3）。
- F-R1-6 内存暂停曾把用户主动发起的导出也挡住且界面无提示 → 暂停只挡解码/大模型，导入页显示原因（0bf9b56）；多线程许可上限测试与压力文件端到端测试补齐；claim SQL 5000 条 15.3 ms/次（debug）。
- F-R1-7 第一次批次 2 测量被并行车道污染（负载 48）作废；重跑在负载 8 的机器上。
- F-R1-9 性能装置绕过协调器（`run_one` 而非 `run_one_with_coordinator` + `memory_profile` 许可），预算档等于没限流 → R6 改装置并重测。
- F-R1-8 首屏 43.5 s 未达 30 s：封面与胶片条在同一个 thumbnail 任务里，封面要等胶片条一起完成；候选改法是拆成 cover 先行、strip 后置（记入 R6）。

## 5. 被 revert 或冻结的项
无。

## 6. 下一轮入口
R2 缺口（已并行推进并合入）；R6 补：cover/strip 拆分以达首屏 30 s；16 GB 真机验收（待业主）；claim SQL 在 release 下复测。
