# AI 基线报告 · R18 车道 aiscore 改后重跑(2026-09-14)

> 对照组是 `baseline-2026-09-14.md`(同一台机器、同一套语料、同一条命令)。
> 与基线唯一的差别是「口播判定 · 负控」3/7 → 7/7;其余每一格逐字相同。
> 「最佳窗」那一列有 4 条素材的建议段挪了位置(0813 / 0821 / 0834 / 0835),
> 但命中数仍是 7/18 —— 挪动的那几条改前改后都不算命中。
> CLIP 仍然未配置,所以八维与画面搜索仍是**未测量**(不是 0)。


跑于 `cargo test --test ai_labels`。**report-only:本文件不设阈值门禁**,只作为后面改时刻分/搜索/描述时的对照组。指标定义与真值来源见 `qa/ai-eval/NOTES.md`。

- CLIP 侧车:**未配置**,八维与画面搜索记为未测量
- OCR 侧车:随包 `sidecar-ocr`(Swift/Vision)
- 转写:**未跑**(whisper 模型在业主 profile 里,本轮规则不碰),所以没有 CER 一项

## 合成夹具(/Users/xin/Library/Caches/tripcut-qa/ai-fixtures)

| 指标 | 值 | 备注 |
|---|---|---|
| 八维 top-1 · subject | 未测量 | CLIP 未跑 |
| 八维 top-1 · shot_size | 未测量 | CLIP 未跑 |
| 八维 top-1 · viewpoint | 未测量 | CLIP 未跑 |
| 八维 top-1 · function | 未测量 | CLIP 未跑 |
| 八维 top-1 · person_state | 未测量 | CLIP 未跑 |
| OCR 关键词召回 | 3/3 = 100% | 期望词任一命中即算 |
| OCR 负控(不该认出字) | 5/5 = 100% | 认出任何字即算失败 |
| 胶片条 / OCR 行 | 8 / 4 | 胶片条为 0 则 OCR 两格都不作数 |
| 口播判定 · 召回 | 3/3 = 100% | 真值 speech=1 的条 |
| 口播判定 · 负控 | 5/5 = 100% | 真值 speech=0 的条不该判有人声 |
| 时刻分最佳窗 IoU≥0.5 | 2/3 = 67% | top-1 建议段 vs 人工 best_window |
| quick_hash 对得上 | 未测量 | 对不上说明素材被重切/转码过 |
| 画面搜索 Recall@5 / MRR | 未测量 | CLIP 侧车没跑起来 |

### 逐条

| 素材 | 八维(真值→实得) | OCR 实得 | 口播 真/实 | 最佳窗 真/实 | 窗数 |
|---|---|---|---|---|---|
| zh_sign_shop | function Information→— | 城南面馆 | 0/0 | */2.0-10.0 | 20 |
| zh_sign_street | function Information→— | （放路128～ / 每品11204 | 0/0 | */2.0-10.0 | 20 |
| zh_sign_speech | function Information→— | 山海书店 | 1/1 | 1.0-6.0/1.0-9.0 | 20 |
| zh_speech_only | — | (无) | 1/1 | 1.0-6.0/1.0-9.0 | 20 |
| zh_speech_gap | — | (无) | 1/1 | 0.0-2.0/1.0-9.0 | 20 |
| silent_control | — | (无) | 0/0 | */2.0-10.0 | 20 |
| subject_red_block | — | (无) | 0/0 | */2.0-10.0 | 20 |
| subject_split_tone | — | (无) | 0/0 | */2.0-10.0 | 20 |

#### 校准(先让它红过)

- OCR 召回:期望词换成不存在的词 → 3/3 = 100% → 0/8 = 0%(会红)
- 口播召回:强制所有窗 speech=false → 3/3 = 100% → 0/3 = 0%(会红)
- 最佳窗 IoU:真值窗整体平移 600 s → 2/3 = 67% → 0/3 = 0%(会红)

## 真素材(人工看帧真值)(/private/tmp/claude-501/-Users-xin-Desktop-Torquemax-codex-split-prep/742cfd7a-a4ff-48e0-aa32-9dbf2ac2378d/scratchpad/walk-media)

| 指标 | 值 | 备注 |
|---|---|---|
| 八维 top-1 · subject | 未测量 | CLIP 未跑 |
| 八维 top-1 · shot_size | 未测量 | CLIP 未跑 |
| 八维 top-1 · viewpoint | 未测量 | CLIP 未跑 |
| 八维 top-1 · function | 未测量 | CLIP 未跑 |
| 八维 top-1 · person_state | 未测量 | CLIP 未跑 |
| OCR 关键词召回 | 2/18 = 11% | 期望词任一命中即算 |
| OCR 负控(不该认出字) | 未测量 | 认出任何字即算失败 |
| 胶片条 / OCR 行 | 21 / 7 | 胶片条为 0 则 OCR 两格都不作数 |
| 口播判定 · 召回 | 12/12 = 100% | 真值 speech=1 的条 |
| 口播判定 · 负控 | 7/7 = 100% | 真值 speech=0 的条不该判有人声 |
| 时刻分最佳窗 IoU≥0.5 | 7/18 = 39% | top-1 建议段 vs 人工 best_window |
| quick_hash 对得上 | 21/21 = 100% | 对不上说明素材被重切/转码过 |
| 画面搜索 Recall@5 / MRR | 未测量 | CLIP 侧车没跑起来 |

### 逐条

| 素材 | 八维(真值→实得) | OCR 实得 | 口播 真/实 | 最佳窗 真/实 | 窗数 |
|---|---|---|---|---|---|
| IMG_0812_机场出发 | subject 细节→—<br>shot_size 近景丨特写→—<br>viewpoint 俯拍→—<br>function Detail→—<br>person_state 操作→— | 玛滩让我把这个交给你 / 原来師信封品？ | 1/1 | 2.5-5.5/0.0-8.0 | 16 |
| IMG_0813_登机口 | subject 人丨细节→—<br>shot_size 近景→—<br>viewpoint 平视→—<br>function Detail丨Human-Reaction→—<br>person_state 操作丨观察→— | (无) | 1/1 | 6.8-9.8/10.0-12.0 | 24 |
| IMG_0815_落地 | subject 人丨交通→—<br>shot_size 中景→—<br>viewpoint 平视→—<br>function Experience丨Orientation→—<br>person_state 行走丨观察→— | (无) | 1/1 | 2.5-5.5/3.5-5.5 | 20 |
| IMG_0816_酒店入住 | subject 交通→—<br>shot_size 广角丨中景→—<br>viewpoint 平视→—<br>function Establishing丨Orientation→—<br>person_state 操作→— | (无) | 1/1 | 4.5-8.5/1.5-9.5 | 30 |
| IMG_0817_街头夜景 | subject 细节丨人→—<br>shot_size 特写丨近景→—<br>viewpoint 俯拍→—<br>function Information丨Detail→—<br>person_state 观察→— | (无) | 1/1 | 6.5-9.0/3.0-7.0 | 18 |
| IMG_0818_晚餐 | subject 细节丨人→—<br>shot_size 特写丨近景→—<br>viewpoint 俯拍→—<br>function Information丨Detail→—<br>person_state 观察→— | (无) | 1/1 | 8.5-12.0/4.0-8.0 | 24 |
| IMG_0820_夜骑出发 | subject 交通→—<br>shot_size 特写丨近景→—<br>viewpoint 平视→—<br>function Detail丨Establishing→—<br>person_state 操作→— | (无) | 0/0 | 0.0-3.0/0.0-7.0 | 14 |
| IMG_0821_湖边 | subject 交通→—<br>shot_size 中景丨广角→—<br>viewpoint 平视→—<br>function Experience→—<br>person_state 操作→— | (无) | 0/0 | 0.0-4.0/5.5-9.5 | 20 |
| IMG_0822_市中心 | subject 交通→—<br>shot_size 中景→—<br>viewpoint 平视→—<br>function Experience→—<br>person_state 操作→— | (无) | 0/0 | 2.0-6.0/0.5-8.5 | 24 |
| IMG_0823_回程 | subject 交通→—<br>shot_size 中景→—<br>viewpoint 平视→—<br>function Detail丨Atmosphere→— | (无) | 0/0 | 0.0-4.0/0.0-8.0 | 16 |
| DJI_0101_航拍4K | — | (无) | 0/0 | */0.5-8.5 | 20 |
| DJI_0102_航拍海岸 | — | (无) | 0/0 | */3.0-11.0 | 24 |
| DJI_0103_航拍10bit | — | (无) | 0/0 | */0.0-8.0 | 16 |
| IMG_0830_早餐 | subject 建筑丨人→—<br>shot_size 广角→—<br>viewpoint 平视→—<br>function Establishing→—<br>person_state 观察丨操作→— | (无) | 1/1 | 2.5-6.0/8.0-10.0 | 20 |
| IMG_0831_出门 | subject 人丨交通→—<br>shot_size 中景丨近景→—<br>viewpoint 平视→—<br>function Experience丨Human-Reaction→—<br>person_state 操作→— | (无) | */1 | 2.0-5.5/0.0-8.0 | 16 |
| IMG_0832_公园 | subject 人→—<br>shot_size 近景→—<br>viewpoint 平视→—<br>function Human-Reaction→—<br>person_state 互动丨自然反应→— | (无) | 1/1 | 7.0-11.0/3.0-7.0 | 24 |
| IMG_0833_合影 | subject 人→—<br>shot_size 近景→—<br>viewpoint 平视→—<br>function Human-Reaction→—<br>person_state 自然反应丨对镜头说话→— | 〉 BENDA / 夜向馆藏 | 1/1 | 0.0-4.0/0.0-8.0 | 16 |
| IMG_0834_骑行 | subject 人丨建筑→—<br>shot_size 中景→—<br>viewpoint 平视→—<br>function Establishing丨Experience→—<br>person_state 操作丨观察→— | (无) | 1/1 | 3.0-7.0/2.0-4.0 | 18 |
| IMG_0835_山路 | subject 交通丨人→—<br>shot_size 中景→—<br>viewpoint 平视→—<br>function Experience→—<br>person_state 操作→— | (无) | */1 | 4.0-8.0/0.5-8.5 | 26 |
| IMG_0836_观景台 | subject 人→—<br>shot_size 近景→—<br>viewpoint 平视→—<br>function Human-Reaction→—<br>person_state 互动丨自然反应→— | (无) | 1/1 | 3.5-7.5/6.0-10.0 | 20 |
| IMG_0837_日落 | subject 人→—<br>shot_size 近景→—<br>viewpoint 平视→—<br>function Human-Reaction→—<br>person_state 自然反应→— | BENDA / 夜向馆藏 / TSATO ATR ORS | 1/1 | 0.0-3.5/0.0-6.0 | 12 |

#### 校准(先让它红过)

- OCR 召回:期望词换成不存在的词 → 2/18 = 11% → 0/21 = 0%(会红)
- 口播召回:强制所有窗 speech=false → 12/12 = 100% → 0/12 = 0%(会红)
- 最佳窗 IoU:真值窗整体平移 600 s → 7/18 = 39% → 0/18 = 0%(会红)

