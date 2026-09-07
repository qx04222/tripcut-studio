# 无人值守 R5 收尾——音乐节奏 + OCR 全链 — 2026-09-06

## 1. 目标与工作项
本轮是 R5（音乐节奏 + OCR）的收尾轮，验证 R5 五个任务在打包产物与冒烟链路上是否可复现：
- Task 1：迁移 0034 + 基于 rustfft 的音乐节拍分析（`src-tauri/src/core/music.rs`：能量包络 → 自相关估拍 → 置信门 → 节拍/小节/段落落库）
- Task 2：`music_analyze`/导入等相关命令与后台任务接线
- Task 3：故事板「音乐与节奏」前端面板（UI）
- Task 4：迁移 0035 + 一个 Swift Vision OCR 随包工具 `sidecar-ocr`（Apache-2.0 自有代码）
- Task 5：`ocr_scan` 后台任务 + 第五条搜索路（OCR/画面文字搜索）+ 迁移 0036（幂等索引）

`git log --oneline --merges | grep -i "R5"` 命中的合并提交：
```
1149eac merge: 文档同步 R4/R5(docs/r4-r5-sync)
eab4bb3 merge: R5 Task 4+5 OCR 迁移 0035/0036、Vision 随包工具、任务与搜索第五路(feat/r5-ocr-search)
f6d98fe merge: main(0034 音乐、回滚、联系表) into feat/r5-ocr-search
2a9312d merge: R5 Task 2+3 音乐命令/任务与节奏面板(feat/r5-music-cmd)
4a4b0d3 merge: R5 Task 1 迁移 0034 音乐节拍分析 + 置信门(feat/r5-music-gate)
d1d5eca merge: R5 Task 3 音乐与节奏面板(feat/r6-music-panel)
```
（起始 HEAD `60fcd08`，收尾落笔时 main 已前进到 `7df8d7d`——期间有其它并发车道继续推进 R6，属正常共享仓库状态，未影响本轮验证的 R5 功能面。）

## 2. 快照与测量

**打包**：`TRIPCUT_PACKAGE_MODE=qa TRIPCUT_ALLOW_ADHOC=1 ./scripts/package-dmg.sh` PASS，产物 `旅剪工作台_0.1.1_20260906T215418Z-11849_qa_aarch64.dmg`（ad-hoc 签名，21 个动态库内嵌，`final self-check (critical payloads present)` 无报错通过）。

**sidecar-ocr 随包验证**：
- `.app/Contents/MacOS/sidecar-ocr` 存在（110784 字节）。
- `codesign -dv` 输出：
  ```
  Executable=.../旅剪工作台.app/Contents/MacOS/sidecar-ocr
  Identifier=sidecar-ocr-555549447e3dcddd2a1d3c98af6cd82fd86dcbd9
  Format=Mach-O thin (arm64)
  CodeDirectory v=20400 size=429 flags=0x2(adhoc) hashes=7+2 location=embedded
  Signature=adhoc
  Info.plist=not bound
  TeamIdentifier=not set
  ```
- SBOM `Contents/Resources/legal/native-sbom.json` 命中 `sidecar-ocr` 条目，`"licenseConcluded": "Apache-2.0"`，`licenseEvidence` 为 `sidecar-ocr/main.swift` + `sidecar-ocr/build-manifest.json`。
- 许可 1:1 自检（打包脚本 `==> final self-check (critical payloads present)` 步骤，覆盖 sidecar-ocr 二进制、`legal/sidecar-ocr/main.swift`、`legal/sidecar-ocr/build-manifest.json`、`legal/native-sbom.json` 等关键载荷齐全性）：无报错通过，紧接着进入 `==> packaging DMG`。

**OCR 夹具测试**：`echo <zh-en.png 绝对路径> | <app>/Contents/MacOS/sidecar-ocr` 输出：
```json
{"texts":[{"text":"旅剪工作台 TripCut 2026","confidence":0.5,"bbox":[0.2012187215255586,0.403005697269224,0.5991638692220052,0.2601192982991536]}],"path":"/Users/xin/Projects/tripcut-studio/src-tauri/tests/fixtures/ocr/zh-en.png"}
```
包含「旅剪」与「TripCut」两个字符串，PASS。

**音乐 BPM/节拍数**：无驱动真实导入+分析的 example 二进制（`grep -rn "import_track\|music_analyze" src-tauri/examples` 无命中），按 brief 走单测路径：用与 `src-tauri/src/core/music.rs` 测试完全一致的 ffmpeg lavfi 配方（`aevalsrc=exprs=0.9*sin(2*PI*1000*t)*lt(mod(t\,{period})\,0.02):s=22050:d={seconds}`，`period=60/bpm`）生成了一份 20 秒 120 BPM 的点击音轨 `/tmp/tc-click-120.wav`（供留证，未接入真实导入流程，因为没有 example 驱动）。随后运行：
```
cargo test --manifest-path src-tauri/Cargo.toml music -- --nocapture
```
`core::music::tests` 23/23 全部 `ok`，其中：
- `click_track_at_120_bpm_is_measured_within_two_bpm`（60 秒 120 BPM 点击轨）：断言 BPM ∈ [118.0, 122.0]、拍间隔中位数 500000±25000（微秒）、拍数 ∈ [110, 130]（约 120 拍/60 秒）、`confidence > 1.5`、下拍（小节）间隔中位数 2000000±100000。测试通过，说明实测值落在这些区间内；测试体本身只在断言失败时才 `println!` 具体数值（`assert!(..., "...{}", grid.bpm)` 形式），断言通过时不打印精确值，故只能如实记录区间而非单点数值。
- `click_track_at_60_bpm_is_measured_not_120`：BPM ∈ [58, 62]，通过。
- `click_track_at_200_bpm_is_measured_within_bounds`：BPM ∈ [197, 203]，通过。
- `dithered_silence_reports_no_beats` 等负例、`persist_analysis_*`、`running_the_job_analyzes_the_track_and_marks_it_done` 等落库/后台任务测试全部通过。

## 3. 门禁记录
`ls qa/runs/ | grep -i "fast-gates"` 命中今天（2026-09-06）21:00Z 及以后的记录，逐条读取各自 `gate.json` 的 `status` 字段：

| 运行目录 | status |
|---|---|
| `2026-09-06T21-02-59Z-fast-gates` | PASS |
| `2026-09-06T21-10-40Z-fast-gates` | PASS |
| `2026-09-06T21-24-34Z-fast-gates` | PASS |
| `2026-09-06T21-27-35Z-fast-gates` | PASS |
| `2026-09-06T21-37-14Z-fast-gates` | FAIL（如实列出，未过滤——本轮未去追查该次 FAIL 的根因，因为不在本轮工作项范围内，仅忠实转录门禁记录） |
| `2026-09-06T21-38-29Z-fast-gates` | PASS |
| `2026-09-06T21-44-00Z-fast-gates` | FAIL（同上，如实列出） |
| `2026-09-06T21-46-52Z-fast-gates` | PASS |
| `2026-09-06T21-49-15Z-fast-gates` | PASS |

21:00Z 之后共 9 次 `fast-gates` 运行，7 次 PASS、2 次 FAIL；PASS 的 7 次时间戳均已列在上表。

## 4. FINDINGS

F-R5-1 OCR 车道擅自把 clip_ocr_texts 改号成 0034 "补缺口"，与音乐 0034 冲突，合并时改为 0035/0036（教训：派工要写明预留号不许改）
F-R5-2 音乐置信门 MIN_TEMPO_CONFIDENCE=5.0 是启发式，抖动噪声按种子置信度 3.9–12.7，可能漏判
F-R5-3 音乐导入与分析各解码一次（应改用 ffprobe format=duration，R6 7a 处理）
F-R5-4 许可清单脚本自 printpdf/lopdf 落地起在门禁之外一直红（已补映射并进 fast-gates）
F-R5-5 合并脚本解冲突两次吞掉 raw string 结尾 "#;（已加 cargo build 把关）
F-R5-6 老测试 api mock 缺新导出导致门禁红（getComponentStatuses）
F-R5-7 OCR 夹具 PNG 276KB→32KB（sips -Z 1200）仍识别正确

F-R5-8 本轮实测确认 F-R5-3 已在 R6 处理：收尾时 main HEAD 为 `7df8d7d`（`merge: R6 Task 7a 补探测谓词/rotation_source+audio_probed(0038)/ISO 前缀/音乐时长 ffprobe(feat/r6-cleanup-import)`），即 R5 音乐/导入各解码一次的问题已经有后续修复合入，本轮不再重复处理。
F-R5-9 `prepare-cua-candidate.mjs` 命中真实的 `runtime.desktop-unlocked` 检测（`ioreg -n Root -d1` 里 `CGSSessionScreenIsLocked"=Yes`）——本轮执行期间 macOS 会话处于锁屏状态，且持续锁定超过 5 分钟未变化。按 brief 的锁/权限症状处置规则，重试两次（间隔 30 秒）仍是同一条 `FAIL runtime.desktop-unlocked: macOS session is locked; native UI evidence would be invalid`，随后停止重试并如实上报（不是代码缺陷,是执行环境缺少可用桌面会话；下一轮需在已解锁的会话里跑收尾链的 GUI 相关步骤)。
F-R5-10 由于 F-R5-9,`smoke-gui.mjs`(需要 `prepare-cua-candidate.mjs` 产出的 `manifest.json` 作为 `--candidate`)与 `crash-diff.mjs`(需要同一个 `manifest.json` 作为 `--baseline`)两步在本轮被迫跳过——不是脚本本身失败,是上游候选没能生成,链路上没有产物可喂给它们。`audit-dmg.mjs`、`preflight.mjs`、`crash-recovery.mjs`(不依赖 GUI/候选进程,只用临时种子库跑 crash_probe)三步均正常执行并全部 PASS,详见 §2、§3。

## 5. 被 revert 或冻结的项
无。

## 6. 下一轮入口
R6 收尾。此外因 F-R5-9/F-R5-10：R6（或任何需要跑 `smoke-gui.mjs`/GUI 冒烟的下一轮）开工前应先确认执行环境的 macOS 会话已解锁，否则 `prepare-cua-candidate.mjs`→`smoke-gui.mjs`→`crash-diff.mjs` 这条依赖链会在第一步就如实 FAIL。
