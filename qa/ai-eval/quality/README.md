# R20-3 画质三指标标定入口（2026-09-20）

本轮只采集测量值；默认和实际评分贡献均为 0。设置页的三个实验 slider 保存到 `moments.weights`，标定通过前，即使保存非零值也不参与分子、分母或挑片。照片 `analyze_l1/photo-v2`、视频 `analyze_l1/v6` 会让旧分析重新排队；moments/v3 的评分公式不变。

## 存储与单位

不加迁移。`clip_analysis.tool_versions.quality`：

```json
{"version":"quality/v1","scoring_enabled":false,"samples":[{"position":0.5,"metrics":{"horizon_tilt_deg":7,"exposure_worst_cell":{"index":1,"status":"over","severity":1,"cells":[]},"saliency_sharpness":120,"width":320,"height":180}}]}
```

示例中的数值只解释结构，实际 `cells` 包含至多 9 个非空格。照片一个 `position=0` 样本；视频在时长的 10%/50%/90% 各一帧。按帧保存，不把不同帧的角度和最差格混成一个不可追溯的均值。

- `horizon_tilt_deg`：Sobel 边缘 → 1° Hough 投票 → 主导直线与最近水平/垂直轴的无符号偏差 0–45°。不是语义地平线识别；平坦或没有足够长的直线返回 null。长边至少 25% / 至少 12 像素的支持线才有效。
- `exposure_worst_cell`：九宫格编号从左上到右下 0–8；每格保留 8-bit 亮度 mean、low/high clip ratio、status、severity。亮度 ≤8 / ≥247 计入剪切；欠曝要求比例 ≥10% 且 mean≤60，过曝要求比例 ≥10% 且 mean≥170。severity 为剪切比例乘相应偏暗/偏亮程度，取最大值；同分选最前格。三种真值为 `under` / `over` / `normal`。这是未标定的局部曝光启发式，黑夜和白色物体可能误报；不会改现有整帧曝光角标。
- `saliency_sharpness`：保持比例、长边≤320 的图；64×64 FFT 的 log amplitude 减去 3×3 频谱均值，保留相位，抑制 DC，逆 FFT 幅度平方 + sigma=2.5 平滑；显著图 >2×均值区域内的显著性加权 3×3 拉普拉斯方差。8-bit 亮度平方单位，越高越锐；不是直接输出 1–5 分。无纹理/无显著区域返回 null。FFT 使用 Cargo.toml 已有 `rustfft`，没有新增依赖。

视频新增 3 次单帧软解抽取，采用保比例 PNG；原来的 320×180 focus 抽帧与评分信号不变。此取舍避免旧 focus 行为变化和竖幅倾角失真；增加解码成本，未测量大批真实 4K 素材的吞吐量。像素测量按 SDR 解释，HDR 色调映射和跨设备阈值尚未标定。

## 真值、来源与证据边界

- `../manifest.tsv` 原 21 条视频增三列，保持 `*`（未标定）；登记的临时素材目录本轮已不存在。原 hash/size/旧真值全部保留。
- `../photos/quality-truth.tsv` 登记现有 51 张照片，暂为 `*`；旧的全帧「blur/good/underexposed」标签不冒充主体区域锐度或最差格的人评真值。原照片及原 manifest.json 不改。
- 本目录 `manifest.tsv` + 71 张 PNG 为本轮替代标定集：24 张 3°/7°（包含正负、水平/垂直线、位置/亮度变体）；27 张曝光图（9 个位置×过曝/欠曝/正常）；20 张主体图（4 个位置×5 个模糊级）。三项有标注的总数分别为 24 / 71 / 20。
- 主体真值 5→1 对应同组 Gaussian sigma=0/0.7/1.2/2/3.5；这是可目视分辨、由构造参数确定的相对顺序。未把算法输出反填为真值，也未声称是 20 张实拍主体的人评打分。
- 目视抽查 `tilt-01`、`exposure-01`、`focus-1-0`、`focus-1-4`：倾斜分界线、顶中格高光剪切、清晰主体纹理和虚焦主体均与构造一致。独立全量人工打分尚未做。

## 复现

在本 worktree 根：

```sh
export PATH=$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$HOME/.cargo/bin:$PATH
export CARGO_TARGET_DIR=/Users/xin/Projects/tripcut-wt-r21-quality/src-tauri/target
cargo test --manifest-path src-tauri/Cargo.toml --test quality_r20 -- --nocapture
```

只有显式再生成时运行（覆盖本目录的合成 PNG 和 manifest，原片不受影响）：

```sh
cargo test --manifest-path src-tauri/Cargo.toml --test quality_r20 quality_r20_generate_fixtures -- --ignored
```

评估测试不写文件。基线数字见 `../baseline-2026-09-14.md` 的 R20-3 段；没有以合成结果宣称已经完成实拍校准或允许开启权重。
