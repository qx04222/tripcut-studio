# 无人值守 R21 · 独立照片工作台验收

规格：`docs/superpowers/specs/2026-09-19-r20-r21-video-photo-design.md`，以 §0.5 的业主拍板为最终边界：照片是独立工作台，不进入视频媒体池、镜头带、故事顺序或时长预算。

## 1. 收口范围

- 对照/合并基线：`main@1d659f3`（v0.10.2）。R21 在 `r21/integrate2` 接入 W1 照片发动机、相似分组、质量预筛、擂台和独立照片工作台；数据库最新版本保持 **53**，0054 未占用。
- 同一集顶部提供「视频工作台 / 照片工作台」两个 tab。视频侧只读取 `kind='video'`，原有视频监视器、镜头带、章节和自动挑选语义不变；照片侧只读取 `kind='photo'`。
- 照片工作台包含日期/时段网格、相似组折叠、疑似废片后排、静态照片检视、星级/保留/拒绝、精选带、组内 A/B 擂台、一句话挑照片和结果面板。
- 照片检视器没有播放、I/O 打点或时间轴；提供适屏/100%/200%/400%、滚轮与拖动、EXIF、星级、保留/拒绝、设为主图。照片擂台提供双静态画布、同步缩放/平移、双侧 EXIF、成员条、进度、撤销和断点继续。
- 素材包和整包交付把精选视频与照片分别写入 `视频/`、`照片/`，两边各有 `顺序.txt`。照片不计视频预算；混合交付的参考粗剪只使用视频，纯照片交付不承诺粗剪。

### 1.1 片刻参考边界

产品交互与工作流参考 `DouglaxYuan/pianke-ai-select`（审阅 commit `05b6de2368e420be09c20a00567b08dfff0b525a`）：日期/半日分组、相似组折叠、废片原因、A/B 进度、EXIF 对照、成员条、胜者结果持久化、同步缩放/平移、撤销与断点继续。TripCut 在既有 Tauri/React/Rust 架构中重写这些机制，并加入视频/照片工作台隔离、现有评分与交付链。

上游采用 Pianke Software License Agreement v2，而非 MIT；它允许个人或摄影工作室内部使用及自用修改，但禁止销售、换皮或二次打包、把软件能力作为付费服务、嵌入付费软件、转授权以及移除品牌，超范围需另取商业授权。本轮只将上游作为行为与工作流参考；核对的 TripCut 变更未引入上游源码、CSS、文案或素材。TripCut 继续以自身许可证发布的前提是最终来源复核没有上游表达性代码或素材。

## 2. 自动门禁与浏览器验收

### 2.1 六门禁

最终功能代码 `71e559c` 的六门禁结果：

| 门禁 | 结果 |
|---|---|
| `npm run typecheck` | PASS，0 错 |
| `npm run lint` | PASS，0 错、1 条既有 warning |
| `npx vitest run` | **230 文件，1681 通过，3 todo** |
| `npm run build` | PASS，Vite **384 modules** |
| `check-chunks.mjs` | PASS，**15 chunks**，最大 **289.7 KB** |
| `cargo build` | PASS |
| `cargo test` | **1293 通过、7 ignored、0 failed**；另跑剪映金丝雀 **1/1 PASS** |
| `cargo clippy --all-targets -- -D warnings` | PASS |

每项新增行为均先用失败测试锁定再修绿，包括：工作台隔离、照片不进入视频顺序、相似组/主图账本/擂台撤销、照片专属监视器、命令面板擂台 kind 隔离、纯照片/混合/空交付文案、坏图重建与性能路径。

### 2.2 浏览器剧本与截图

- `preview-shots` 最终候选浅色 **46/46 个正式场景 PASS**，深色 **46/46 个正式场景 PASS**；每种主题各产出并比较 **48 张 PNG**（另含 `25-guide-bubble-heat`、`30-chapter-menu-open` 两张辅助截图），console errors/warnings **0**，page errors **0**。浅色最终重拍输出为 `/tmp/r21-final-71e559c-preview-light/`；深色最终门禁日志在 `qa/runs/2026-09-20T23-33-56Z-fast-gates/logs/preview-diff-dark.log`。
- 新场景 `41-photo-ws`、`42-photo-grid-groups`、`43-photo-duel` 已入 `qa/preview-baseline/`。最终基线显示照片专属静态检视、倍率/评分/EXIF和双静态擂台，不再显示视频播放控件。
- 视频主壳与 `main@1d659f3` 对同一裁剪区域 `2880×1656+0+88` 比对：浅色 **AE=0（0 像素）**，深色 **AE=0（0 像素）**；两组标准化 PNG 的 `cmp` 也均为 **0**。最终深色报告为 report-only，4 个既有非照片场景超过 0.5% 阈值；照片新场景 41/42/43 分别为 **0.000% / 0.148% / 0.000%**，全部低于 0.5% 阈值。
- 浏览器运行时确认：照片监视器没有视频控件；适屏/100/200/400 状态正确；orientation 6 显示 3024×4032；网格有焦点时监视器 hover 不劫持方向键或 F/X；设主图立即刷新折叠代表；擂台双图同步缩放和平移。自动化金样覆盖 EXIF orientation 1–8 的尺寸与四象限像素映射；原生候选实际观察只覆盖 orientation 6，本轮没有逐个在原生 UI 观察 1–5、7–8。

### 2.3 性能

夹具：100 张照片 + 10 条视频、4 workers、standard、8 decode permits；原片哈希前后零变化，manifest SHA-256 `7f88951c9f93a4b50e6956f0baeb589f87a75f61a61ff9c65816db0990050d50`。

| 轮次 | worker 生成全部 cover | DB 轮询确认全部 cover artifact | DB 轮询确认全部 preview artifact | 首 12 个 cover artifact | 含视频全部任务 | jobs | RSS p95 / peak | swapouts_delta |
|---|---:|---:|---:|---:|---:|---|---:|---:|
| R1 | **3.476 s** | 3.807 s | 17.411 s | 0.625 s | 6.034 s | 503 done / 0 failed / 0 blocked | 2.049 / 2.080 GB | 0 |
| R2 | **3.464 s** | 3.823 s | 16.289 s | 1.157 s | 4.904 s | 503 done / 0 failed / 0 blocked | 1.985 / 2.050 GB | 0 |

这些数字证明后台产物与数据库完成时间，不等于照片卡在原生 UI 中可见的时间。保留 cover 512 px、JPEG 0.90、方向/alpha/SDR-sRGB 与真实资源预算；没有降低质量、删任务或改测量口径。

大样本基础候选 `d263de9` 另以两个全新隔离 profile，从原生文件夹面板最终「打开」动作开始计时到照片网格首卡出现：**2788.850 ms**、**1582.258 ms**，两轮均满足 ≤3000 ms，随后均导入 photo=100、video=10，⌘Q 后 `.unclean-exit` 不存在。已导入的混合 profile 中连续选 20 张不同照片，直接轮询缓存的 `AXImage` 预览签名：**p95=44.600 ms，max=50.608 ms**，满足 ≤100 ms；探针自身属性读取 p95=40.125 µs、max=108.542 µs，未从结果中扣除探针时间。最终候选 `71e559c` 没有改动导入、解码或照片预览性能路径，并以 §3.3 的增量原生回归覆盖其后所有行为修复。

### 2.4 确定性算法判据

- 无 CLIP 模型时相似分组 **10/10**，跨事件误并 **0**；1 万张取消 **483.666 µs**，该数字只含分组计算，不含全量 ImageIO 解码。
- 51 张确定性 PNG 中，废片召回 **10/10**、好片误杀 **0/10**、夜景欠曝误判 **0**。未加载真实 CLIP，这些合成夹具数字不能外推到真实相机照片或真实模型精度。
- 独立的 41 张照片夹具输入「挑 20 张照片」得到 **20/20**：20 行理由非空、每个相似组最多 1 张、全部源 `duration_ticks=0`、自动段 `(0,0)`、视频段 **0**、照片故事顺序 **0**。照片 `hold_ms` 只用于照片结果和交付说明，不进入视频自动挑选预算。

### 2.5 fast-gates

- `3cb9aeb`：`qa/runs/2026-09-20T20-27-32Z-r21-final/gate.json`，**28/28 PASS**。
- 最终功能提交 `d263de9`：`qa/runs/2026-09-20T20-54-04Z-r21-integrate2-final2/gate.json`，**28/28 PASS**；其中 Vitest 1662 通过、Rust 1272 通过，typecheck、lint、build、Clippy、cargo/npm audit、100 素材性能门和 preview diff 全部退出 0。
- 最终候选 `71e559c`：`qa/runs/2026-09-20T23-33-56Z-fast-gates/gate.json`，**28/28 PASS**；Vitest **230 文件、1681 通过、3 todo**，Rust **1293 通过、7 ignored、0 failed**，100 素材性能门 **380447 ms（基线的 73.1%）**、RSS peak **4,348,444,672 B（基线的 97.6%）**，其余 typecheck、lint、build、Clippy、cargo/npm audit、金丝雀和 preview diff 全部退出 0。首次重跑被未跟踪的 `src-tauri/target` 符号链接误扫入旧公开源码包，另发现一处 1–5 星级提示快照未更新；移除链接并以失败快照校正期望后，整套门禁从头重跑全绿。
- 合入 main 后的隔离补丁 `6e856de`：`qa/runs/2026-09-21T00-30-00Z-fast-gates/gate.json`，**28/28 PASS**；Vitest **247 文件、1785 通过、3 todo**，Rust **1293 通过、7 ignored、0 failed**，100 素材性能门 **430388 ms（基线的 82.7%）**、RSS peak **4,066,213,888 B（基线的 91.3%）**；48 张深色预览均生成、console/page error 为 0，照片场景 41/42/43 为 **0.000% / 0.148% / 0.000%**。本轮先发现 legacy `auto_select_episode` 在混合库里仍会把照片 `hold_ms` 算入视频预算：回归测试红灯为实际 2 条、期望 1 条；wrapper 固定 `only_photos=Some(false)` 后绿灯只选视频，随后完整门禁从头全绿。

## 3. 隔离 profile 真机验收

候选包从项目 bundle 直接启动，始终设置独立 `TRIPCUT_APP_SUPPORT_DIR`、独立导出目录和剪映草稿目录，并设置 `TRIPCUT_UPDATER_ENDPOINT=http://127.0.0.1:9/`、`TRIPCUT_DISABLE_LLM_PROVIDERS=1`。只用 System Events 按精确 PID 激活；未使用 `open -a`，未触碰 `~/Library/Application Support/TripCutStudio`、`~/Movies/JianyingPro` 或 `/Applications/旅剪工作台.app`。

最终 QA 候选包为 `旅剪工作台_0.10.1_r21-final-71e559c_qa_aarch64.dmg`，SHA-256 `122bf8e617c16d6cdbfc84a76adcc16ad5774aacd7c6117e9d60e552412d3354`。`qa/runs/2026-09-20T23-49-43Z-r21-final-71e559c-dmg-audit/gate.json` 为 **13/13 PASS**：DMG CRC、app 存在、ad-hoc 签名完整性、无禁用/外部运行库、无外部 backend 搜索、macOS 14、中文本地化与文件权限、H.264 VideoToolbox、来源哈希和许可证材料全部通过；包内 **13 个 Mach-O、8 个 dylib**。包版本仍是合并前的 0.10.1 QA 候选，正式发布包将在 main 上升为 0.11.0 并重新审计。

### 3.1 混合素材闭环（`d263de9` 大样本基础候选）

- 导入 **100 张照片 + 10 条视频**。按精确 PID 连续完成照片→视频→照片→视频→照片→视频→照片六次快照：视频工作台只显示 10 条及媒体池/镜头带，照片工作台只显示 100 张及照片网格/照片静态检视；重启后仍停在照片工作台，数量、评分和精选保持。
- 照片静态监视器实测适屏/100/200/400、放大拖动、orientation 6 的 3024×4032、4 星、收藏、拒绝；自然相似组 4 张完成擂台并撤销/重做。
- 原输入框和结果面板「再挑一次」的占位文案都精确为「例如：挑 20 张，优先清晰、构图完整，按拍摄时间排序」，没有视频的「60 秒」。大样本基础候选输入「挑 7 张照片」，数据库最新 run 为 `only_photos=true`、`photo_count=7`、prompt 原文一致；该复验 profile 从已有 8 张精选状态克隆，所以此次只新增 1 行，精确 20 张的空白状态另由 §2.4 的 PH09 验收锁定。最终候选另以「挑 3 张照片」验证 `only_photos=true`、`photo_count=3` 与结果面板张数文案。
- 数据库：`schema_version=53`，`integrity_check=ok`；photo=100、video=10；照片故事顺序 **0**；failed jobs **0**。禁用可选模型后只有 Chinese-CLIP 嵌入（`clip_embed=10`）与转写（`transcribe=10`）按预期 blocked。真机热键留下可复核账本：IMG_0045 为 4 星且收藏，IMG_0049 为拒绝。
- 素材包：`视频/` 有 1 个 MP4 和 `顺序.txt`，`照片/` 有 8 个 JPG 和 `顺序.txt`；HEIC 0，JPG 8。
- 整包交付：`01_精选原片/视频`、`01_精选原片/照片` 各有 `顺序.txt`；照片为全分辨率 4032×3024、sRGB IEC61966-2.1；8 秒视频专属 `04_参考粗剪/参考粗剪.mp4` 实际生成。两个 export job 均 `done`，failed=0。
- 应用日志确认更新端点只访问回环死端口；两次候选启动都以 ⌘Q 在 **200 ms** 内退出，`.unclean-exit` 不存在；110 个原片哈希前后 diff exit=0、diff=0 bytes。

### 3.2 七张照片 / 六场擂台（`d263de9` 大样本基础候选）

有效夹具为 `/tmp/tripcut-r21-native-duel7-v2/`：7 个视觉相同、描述元数据不同且 SHA-256 各异的 HEIC，避免导入层按内容哈希去重；最终隔离 profile 为 `/tmp/tripcut-r21-native-final-d263de9-20260920T2117Z/duel-profile`，没有修改数据库造组。第一版同哈希夹具被去重，不作为验收证据。

- 真机网格显示 `×7`，静态检视显示「组内对比 7 张」。
- 擂台从「第 1/6 场」连续完成到「本组已选好」，成员条为 7 张；⌘Z 显示「已撤销整组擂台」，随后再按一次右键不会破坏撤销账本。
- 数据库：photo_count=7、`integrity_check=ok`。基础候选是同一隔离 profile 的第 2 次 session：6 条 verdict 全部 `undone=1`、session `undone=1`；第 1 次基线 session 的 6 条 verdict 仍为 `undone=0`，证明整组撤销只作用于本次 session。最终候选 `71e559c` 又以 results/photo 来源完成 6 场并整组撤销，见 §3.3。
- 原生菜单 `/tmp/tripcut-r21-native-final-d263de9-20260920T2117Z/duel-menu.json` 为 **7 条顶级菜单**；native audit `duel-native-audit.json` 为 **4 通过 / 0 缺陷 / 0 探针故障**。
- ⌘Q 在 **200 ms** 内退出且 `.unclean-exit` 不存在；7 个原片哈希前后 diff exit=0、diff=0 bytes。

### 3.3 最终真机证据索引

基础大样本真机证据汇总在 `qa/runs/2026-09-20T21-17-00Z-r21-native-final/`，共 39 个文件并附 `SHA256SUMS.txt`（覆盖其余 38 个文件）。它证明 `d263de9` 的 100 照片 + 10 视频闭环。最终候选 `71e559c` 另在 `qa/runs/2026-09-20T23-50-12Z-r21-native-71e559c/` 做晚 13 提交的增量原生回归，共 **18 个文件**，`SHA256SUMS.txt` 覆盖其余 **17 个文件**且全部校验通过。关键文件：

- `photo-placeholder-1.json`、`photo-placeholder-2.json`：两个全新 profile 的首卡 2788.850 ms / 1582.258 ms；
- `fresh-profiles-db-evidence.txt`：两个全新 profile 均为 schema 53、photo=100、video=10、照片故事顺序 0、`integrity_check=ok`、`.unclean-exit` 不存在；
- `photo-select-latency-direct-ax.json`：20 次不同照片选择，p95 44.600 ms、max 50.608 ms；
- `tab-1.txt` 至 `tab-6.txt`、`restart.txt`、`restart-video.txt`：双工作台反复切换与重启持久化；
- `mixed-ax-selected.txt`、`photo-result-placeholders.txt`：照片静态检视控件、EXIF 与两个照片专属提示；
- `duel-v2-final.txt`、`duel-v2-complete.txt`、`duel-v2-undo.txt`、`duel-v2-redone.txt`：六场擂台、完成、整组撤销与撤销后状态；
- `final-db-evidence.txt`：schema 53、媒体隔离、任务状态、照片 prompt、评分、duel session/verdict 和两库 `integrity_check=ok`；
- `mixed-native-audit.json`、`duel-native-audit.json`：两次均 **4/4 PASS**；`mixed-menu.json`、`duel-menu.json`：两次均为 **7 条顶级菜单**；
- `source-integrity-summary.txt` 与四份前后哈希：110 个混合素材和 7 个擂台素材两组 diff exit=0、diff=0 bytes。
- `video-shell-ae.txt`、`video-shell-{light,dark}-{main,candidate,diff}.png`：同一 `2880×1656+0+88` 裁剪区域的原图、候选图与差异图；浅/深色均为 **AE=0**、`magick_exit=0`、`cmp_exit=0`，两边 SHA-256 分别一致。
- 最终增量证据中的 `native-photo-workspace-results.png`、`native-video-workspace.png`：同一集内照片工作台只显示 **10 张照片**，视频工作台只显示 **2 条视频**；照片侧为分组网格、静态监视器、EXIF、星级/F/X、精选带和照片结果面板，视频侧保留媒体池、视频监视器、I/O 文案、章节与镜头带。
- `final-db-evidence.txt`：`71e559c` 的 schema 53、照片 10 / 视频 2、照片故事顺序 0、`integrity_check=ok`；照片监视器 1–5 星级完整账本；结果面板打开时 X 从 2 张即时降到 1 张、F 恢复到 2 张；六场 results/photo duel 的 session 与 6 条 verdict 均已撤销；原生菜单/窗口审计 **4/4 PASS**。
- `native-photo-delivery-order.png`、`photo-delivery-order.txt`：将照片顺序改为 `photo_distinct_10` → `photo_group_7` 后立即进入交付，输出仍为相同 01/02 顺序；同时生成 `视频/顺序.txt` 与 `照片/顺序.txt`。更新检查只访问 `http://127.0.0.1:9/`；精确 PID 以 ⌘Q 正常退出，`.unclean-exit` 不存在，12 个输入素材哈希前后 diff exit=0。

## 4. 发现与修复

| 级别 | 发现 | 处理与证据 |
|---|---|---|
| P1 | 命令面板在无选择或切 tab 的迟到请求中可能跨 kind 启动擂台 | 请求携带 `workspaceMode`，解析前后多层按 kind 过滤，切台后拒绝迟到请求；16 个聚焦测试文件 **120/120** 通过 |
| P1 | 混合照片交付 UI 曾说不生成粗剪，后端实际正确生成视频专属粗剪 | 文案改为仅使用视频，照片不计预算；聚焦 **15/15** 通过，真机有 8 秒 MP4 |
| P1 | 纯照片整包 UI 曾承诺不存在的粗剪 | `hasVideos=false` 时禁用粗剪时长并说明纯照片不生成；交付测试 **17/17** 通过 |
| P2 | 零视频零照片曾显示「仅照片」 | 改为「暂无交付项 · 本次不生成」；红 1 failed / 5 passed，绿 **18/18** |
| P1 | 坏图历史 preview 在清缓存时会被反复复位 | `thumbnail` 与 `photo_preview` 同时尊重非空 `photo_meta.error`；健康 NULL/空错误仍可恢复 |
| P1 | 照片一句话输入和结果面板「再挑一次」沿用视频「挑 60 秒」占位文案 | 两个入口都改为照片张数、清晰度、构图与拍摄时间的专属示例；视频默认文案不变，相关聚焦测试 **22/22** 通过 |
| P2 | 零素材交付抽屉与表单仍误写成纯照片 | 首屏、详情和清单统一显示本次暂无交付项，生成按钮禁用；相邻交付回归 **42/42** 通过 |
| P1 | 照片监视器只有鼠标星级，键盘 1–5 未写入 | 补齐聚焦热键与输入框豁免；最终原生账本实际记录 1/2/3/4/5，UI 与精选带同步 |
| P1 | 照片结果「换一张」曾沿用视频候选，results duel 胜者替换与撤销账本不完整 | 照片只用相似组健康 sibling；擂台开始/结束复验 kind、组、live select 与 X；最终真机 B 胜替换、⌘Z/整组撤销均恢复原结果，Rust duel **24/24** |
| P1 | 照片 X 之后自动挑选、结果计数、集摘要、擂台与交付的有效评级口径可能分裂 | 各链统一读取最新非 `select` 显式 binary；最终真机结果面板打开时 2→1→2 即时刷新，Rust/前端定向回归全绿 |
| P1 | 照片拖序保存与立即交付、切集之间存在竞态 | 保存队列按 episode key 冲刷，交付等待后再次核对 episode；原生立即交付顺序正确，竞态回归 **47/47** |
| P1 | legacy 视频自动挑选命令仍允许照片混入并占用视频预算 | `auto_select_episode` 固定 `only_photos=false`；混合库回归先红（2≠1）后绿，main 完整门禁 **28/28 PASS** |

最终独立复审（`r21/integrate2@db8030f`，随后 `71e559c` 只更新已红的监视器文案快照）：代码层 **P0=0、P1=0、P2=0**。复审另跑 Rust 照片相关 **91 passed、2 ignored**、前端 **10 文件 93/93**，typecheck、Clippy、diff-check 均通过，ESLint 0 error、1 条既有 warning。监视器壳层按工作台挂载不同子树，照片/视频入口和最终成员均按 kind 防御过滤；Pianke 仅作行为参考，生产源码、CSS、文案、依赖与素材中未见其表达性内容。

## 5. 已知边界与留业主真样本

1. 真 iPhone HEIC 的 P3/HDR/48 MP 观感、两张 48 MP 来回切换峰值和 100 张真 HEIC 冷启动速度仍需业主样本；本轮合成 HEIC 只证明方向、色彩空间、队列和预算。
2. 真 ARW/DNG 与真实 Live Photo 仍需样本复核；当前已验证同 stem RAW/xmp/Live MOV 的配对和交付边界。
3. RAW 解码是第二期；Chinese-CLIP Python 环境不随公开包分发。缺少可选模型时照片导入、分组、评分、擂台、精选与交付仍可用。
4. v0.11.0 仍是 Apple Silicon、macOS 14+、ad-hoc 未公证预览版。

## 6. 结论

R21 的照片能力已按 §0.5 收束为独立工作台。照片监视器与视频播放器在数据源、控件、键盘、预算、顺序、擂台和交付上均独立；片刻的选片机制已按 TripCut 架构完成自用化实现，视频工作台像素级保持原壳。
