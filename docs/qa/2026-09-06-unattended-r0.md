# 无人值守 R0 基建 — 2026-09-06

## 1. 目标与工作项
fast-gates 加 build 与 audit / 性能夹具与装置 / smoke-gui / 交付目录重编号。迁移号：本轮无。

## 2. 快照
起始 main `da3338f` → 结束 `2ddce93`（Tasks 1–6 已合并推送；本报告提交前 HEAD）。
提交序列：842015b、c874a33（gates）、ef78ca3+f188a34（fixtures）、0fc9815+a910126+ff781e4（perf harness）、48d20d9+2ddce93（smoke）、48d0704+2682120 合并为 443a00f（交付重编号）。

DMG `旅剪工作台_0.1.1_20260906T171959Z-r0_qa_aarch64.dmg`
sha256 `f9a55945483945ebe44c3d9f424ba2567a315aa48d6cd497b85a942f1e2fac7a`

target 40G；根分区剩余 249Gi（capacity 5%，used 12Gi / 926Gi）。均低于清理阈值（target ≤45G 且剩余 ≥120G），本轮未执行磁盘清理规则。

perf 基线（500 夹具、4 workers，qa/runs/2026-09-06T06-05-37Z-perf-baseline）：peak RSS 7.42 GB（7963590656 B）/ total 54.6 min（3275468 ms）/ 首屏 cover 55.6 s（55614 ms，超过 30 s 目标 — R1 债务）。

## 3. 门禁记录
- fast-gates（qa/runs/2026-09-06T17-16-39Z-fast-gates）PASS（19 项含 typecheck/lint/build/vitest/cargo test/clippy/cargo-audit/npm-audit 全绿）。
- perf-harness（qa/runs/2026-09-06T06-05-37Z-perf-baseline）PASS（gate 整体 PASS；子项 `first-screen<=30s` 为软性检查，标为 fail=55614ms，登记为 R1 债务，不拖累 gate 状态）。
- audit-dmg（/tmp/r0-audit）**PASS**：签名、依赖路径、供货商 hash、许可证物证全部通过；`--expect-signature adhoc` 命中。
- preflight（/tmp/r0-preflight）**FAIL**：`tool.xcode` — `xcode-select: error: tool 'xcodebuild' requires Xcode, but active developer directory '/Library/Developer/CommandLineTools' is a command line tools instance`。其余全部 PASS（candidate.*、tool.node/npm/cargo/rustc、tool.ffmpeg/ffprobe、runtime.single-writer、runtime.no-mounted-tripcut-dmg）。这是本机环境缺少完整 Xcode（只有 Command Line Tools）导致，与本轮任何提交无关；打包/签名/公证流程本身未实际调用 `xcodebuild`。
- cua-candidate（/tmp/r0-cua）PASS。
- smoke-gui（/tmp/r0-smoke）**FAIL**：`db.integrity` — pass=false，但 detail 记录为 "ok"。其余 30 项全 PASS（含 onboarding 关闭、四页导航/截图/内容断言、二轮回访、`select.rate.f` WARN 0->0、`db.clips`=8、`process.alive.end`）。见 §4 F-R0-8。
- crash-diff（/tmp/r0-crash/crash-gate.json）PASS：`added=0`，`processExited=true`。
- 检测器假红修复后复跑：`node scripts/qa/preflight.mjs`（/tmp/preflight-fix2）**PASS**——`tool.xcode` 降级为 warn（detail 追加 "CLT only; required for release/pre-notary"），非 release/pre-notary 模式不再致命；`caffeinate -dims node scripts/qa/smoke-gui.mjs`（/tmp/smoke-fix3，候选来自 /tmp/cua-fix3）**PASS**——`db.integrity`=ok、`db.clips`=8 均为单次 sqlite3 调用结果，31 项全绿；`node scripts/qa/fast-gates.mjs`（/tmp/fast-gates-fix）**PASS**（19 项全绿）。

**总体状态：BLOCKED**（preflight 与 smoke-gui 各有一项 FAIL）。未对任何代码或脚本做回滚/修复；两处均已按事实记录，交由下一轮处置。

## 4. FINDINGS
F-R0-1 夹具脚本 `(( i++ ))` 在 `set -e` 下首轮即中止 → zsh 后自增返回旧值 0 → ef78ca3 改 `(( ++i ))` → 实现者复现过。

F-R0-2 夹具重跑 manifest 归零/非法 JSON → 条目写在生成分支内、逗号守卫绑循环序号 → f188a34 → 审查员复现过。

F-R0-3 perf 装置整类排除 clip_embed 且产物看不出 → a910126 只排除 blocked 并写 excluded 字段 → 审查发现。

F-R0-4 perf.db 固定路径被后续运行覆盖，基线证据不可再查 → ff781e4 每次拷入 qa/runs → 审查发现。

F-R0-5 交付说明步骤渲染 1,2,3,4,6,5,7 → subtitle_note 内嵌编号 → 2682120 统一编号+测试 → 测试先红后绿。

F-R0-6 冒烟用 ⌘K+中文键入是假阳性来源（CJK 被 System Events 乱码，六张截图同一面板）→ 48d20d9 改侧边栏 AX 点击；截图存在≠渲染 → 2ddce93 每页 AX 文本断言 → 校准红过。

F-R0-7 打包输入全在 /tmp，重启即清空，本轮重建 ffmpeg/libplacebo/mpv/whisper 约 40 分钟 → 基建债：R6 前把产物移到 `~/Library/Caches/tripcut-build` 并让 `package-dmg.sh` 读环境变量（登记，不在本轮修）。

F-R0-8（本轮新发现，未修）本机 `preflight` FAIL：`tool.xcode` 检测要求 `xcodebuild -version` 可执行，而本机只装了 Command Line Tools（无完整 Xcode.app）→ 根因是环境缺失，非代码缺陷；打包/公证链路实际未调用 xcodebuild，该检查目前会挡住每一次无 Xcode 环境下的 preflight → 未修，登记为环境依赖或改为软性检查，留给下一轮业主拍板。→ 修复提交 dbe13af

F-R0-9（本轮新发现，未修）smoke-gui 的 `db.integrity` 检查对同一条 `PRAGMA integrity_check` 调用了两次 sqlite3（一次判 pass、一次取 detail，见 `scripts/qa/smoke-gui.mjs:148`），二者非原子：本轮运行中第一次调用命中应用仍在 WAL 写入/checkpoint 的窗口而失败（stdout 非 "ok"，pass=false），第二次调用锁已释放返回 "ok"（detail="ok"），造成 pass=false 与 detail="ok" 并存的假红。收工后对同一 DB 手动重跑 `PRAGMA integrity_check` 5/5 次均返回 "ok"，确认库本身完好、只是检测点有竞态。未修改脚本；建议下一轮把两次调用合并为一次并复用结果。→ 修复提交 dbe13af

## 5. 被 revert 或冻结的项
无。（preflight 与 smoke-gui 的两处 FAIL 已按不回滚的原则原样记录，见 §3、§4 F-R0-8/F-R0-9。）

## 6. 下一轮入口
R1 性能第一批 P1–P4（`artifacts.rs:219` 滤镜顺序、`analysis.rs:370` 场景检测位置、strip/运镜 hwaccel、`-skip_frame nokey`），装置用 `--label before` / `--label after` 各跑一次写两列。

Backlog：cargo-audit 17 条 unmaintained 警告（gtk-rs/proc-macro-error/unic）；`select.rate.f` 冒烟仍 WARN（焦点问题，R2）；smoke 的 AX 路径脆弱；F-R0-8（xcode 环境依赖）、F-R0-9（smoke db.integrity 双调用竞态）留待下一轮处置。
