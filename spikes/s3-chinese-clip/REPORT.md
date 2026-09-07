# S3 Spike — Chinese-CLIP 推理路径拍板(PyTorch-MPS vs ONNX-CoreML)

日期:2026-08-31 · 机器:Apple M5 / 32GB · macOS 27.0 · Python 3.11.15
模型:`OFA-Sys/chinese-clip-vit-base-patch16`(ViT-B/16,视觉塔 86M 参数 / 文本塔 RoBERTa-wwm-ext-base 102M 参数)
时间盒:同一错误卡 3 次转下一项——本 spike 触发一次(见下方"风险"),已按纪律记录后跳过继续测完全部指标。

## 结论(拍板)

**P0/P1 用 PyTorch + MPS,不用 ONNX-CoreML。**

- ONNX 导出本身成功(视觉塔、文本塔都能导出、能跑通 CPU EP,数值与 PyTorch 一致);但 **CoreMLExecutionProvider 在视觉塔上运行时直接报错崩溃**(`Error executing model: Unable to compute the prediction ... error code: -1`),不是"慢",是**跑不出结果**,graph 519 个节点里 CoreML 只吃得下 267 个(87 个分区),混合分区执行时炸掉。
- 就算避开 CoreML EP 只用 CPU EP,ONNX-CPU 也比 PyTorch-MPS **慢约 1.4-1.9 倍**(batch=1 视觉:32ms vs 22ms;batch=8 反而更差:34-99ms/frame vs 18-22ms/frame——ORT 的 CPU EP 在小 batch 卷积上明显没吃到 Apple Silicon 的 GPU/ANE 加速)。
- PyTorch-MPS 延迟已经足够低(batch=1 p50 22ms / p95 27ms,100 帧 ≈2.3s;文本查询 p50 8ms,交互态完全无感)。省下来的"打包体积"优势(约 2GB+ torch 运行时)在 P0/P1 阶段换不来能跑的推理路径——**先能用,再谈瘦身**。
- ONNX 路线不是死路:如果未来要瘦身,建议先解决"CoreML EP 视觉塔崩溃"这一个具体 bug(很可能是 dynamo 导出器产生的某个新 opset 算子在 ORT 的 CoreML EP 里没实现好,换旧版 `torch.onnx.export(dynamo=False)` 或手工分段导出可能绕开),而不是现在就切换生产路径。P2 若要做"零 PyTorch 依赖"打包,重新做这个 spike,目标明确为"修好 CoreML EP",而不是回退到比 MPS 慢两倍的 CPU EP。

## 基准环境

- 100 张测试图:ffmpeg `testsrc2` 生成,4 种尺寸各 25 张(1920x1080 / 1280x720 / 3840x2160 / 竖版1080x1920 各一档色相偏移),内容非真实素材,只测吞吐/延迟,非检索质量。
- 20 条中文查询文本(如"傍晚海边逆光走路的镜头"),覆盖典型旅拍搜索场景。
- venv:python3.11 + torch 2.13.0(MPS 后端可用)+ transformers 5.16.1 + onnxruntime 1.29.0(`CoreMLExecutionProvider` 可用)。

## 结果对比表

| 指标 | PyTorch MPS | ONNX CoreML EP(视觉塔) | ONNX CPU EP(视觉塔) |
|---|---|---|---|
| 首次加载(含权重读取) | 4.60s | 2.75s(session 建成)但**推理即崩溃** | 0.10s |
| 视觉编码 batch=1 p50/p95 | **22.1ms / 26.7ms** | 崩溃,无数据 | 31.9ms / 36.4ms |
| 视觉编码 batch=8 p50/p95(每帧) | **18.1ms / 22.0ms** | 崩溃,无数据 | 33.8ms / 98.7ms |
| 100 帧总耗时(batch=1) | 2.28s | — | 3.28s |
| 100 帧总耗时(batch=8) | 1.85s | — | 4.37s |
| 进程内存峰值(RSS,含 PyTorch 全流程) | 2893 MB | — | 4565 MB(注:该进程同时装了两套后端做对照,非单一路径的真实占用) |

| 指标 | PyTorch MPS | ONNX CoreML EP(文本塔) | ONNX CPU EP(文本塔) |
|---|---|---|---|
| 20 条中文查询 p50/p95 | **8.2ms / 15.8ms** | 29.3ms / 35.1ms(session 建成、能跑,但比 CPU EP 更慢) | 11.0ms / 13.0ms |

**打包体积**(参考,非最终产物大小):
- venv 内 `torch` 包本体 533MB,`onnxruntime` 包本体 80MB——若真走纯 ONNX 路径且预处理也脱离 torch,理论上能省下约 450MB+ 运行时(加上 torchvision/相关依赖,实际能省 2GB+ 的说法方向正确,但需要预处理链也去 torch 化才能兑现,当前 spike 的预处理仍用 `ChineseCLIPProcessor`,依赖 torch/numpy)。
- 权重体积基本不变:ONNX 导出后视觉塔 337MB + 文本塔 389MB ≈ 726MB(fp32),与 PyTorch 权重量级相当(未做 fp16/int8 量化)。

## 语义检索 Sanity Check

20 条中文文本 × 100 图相似度矩阵(PyTorch 路径与 ONNX-CPU 路径结果一致,因为读的是同一份权重):
- 无 NaN
- 相似度范围 0.227 ~ 0.366,std=0.025——有区分度,不是全部塌缩到同一个值
- 20 条查询里有 13 条各自的 top-1 匹配图片互不相同(top1 唯一计数 13/20)——说明模型确实按语义区分了不同图片,不是随机/退化输出(测试图内容是合成色块,非真实语义素材,不做检索质量评估,只验证数值管线通)

## 风险 / 已知坑

1. **ONNX 导出算子不兼容(已实锤,非假设)**:`torch.onnx.export` 新版 dynamo 导出器产出的视觉塔计算图,ONNX Runtime 的 `CoreMLExecutionProvider` 只能吃 267/519 个节点,混合分区执行时对某个 CoreML 分区报 `error code: -1` 直接失败。文本塔的 CoreML EP 建 session 成功且能跑(不崩溃),但比 CPU EP 更慢,说明 CoreML EP 对这个模型结构整体不友好,不只是视觉塔一处的 bug。
2. `torch.onnx.export` 需要额外装 `onnxscript`(默认 pip 装 torch 不带),文档/脚手架要记这条依赖。
3. batch=8 在 ONNX CPU EP 上 p95 达到 98.7ms/frame,明显劣化(可能是 ORT 默认线程数与 batch 内卷积调度冲突),说明"批处理一定更快"在 ONNX-CPU 路径上不成立,若真要用这条路径需要单独调 `intra_op_num_threads`。
4. 首次模型下载耗时 202s(HF Hub 未认证限速),生产/CI 环境应设 `HF_TOKEN` 或走 `HF_ENDPOINT=https://hf-mirror.com` 镜像并预置缓存,不能假设首启现下。
5. 内存峰值数字里 ONNX 进程同时持有两套 provider 的 session(CoreML+CPU 对照测试),4565MB 不代表生产单路径的真实占用,不要直接拿来做资源规划,需要单独跑一次"只装 CPU EP"的对照。

## 产物清单(本目录)

- `bench_pytorch.py` — PyTorch MPS 基准脚本(batch=1/8、文本、sanity、内存)
- `export_onnx.py` — 视觉塔/文本塔 ONNX 导出脚本
- `bench_onnx.py` — ONNX Runtime CoreML/CPU EP 基准脚本
- `pytorch_results.json` / `onnx_results.json` — 原始基准数据(JSON)
- `pytorch_bench.log` / `onnx_bench.log` / `export_onnx.log` — 运行日志(含 CoreML EP 报错原文)

模型权重、venv、100 张测试图、导出的 `.onnx`/`.onnx.data` 均在 scratchpad(未入库,按任务要求不进 git)。
