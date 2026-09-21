# 无人值守 R21 W3 · 真机验收 + P1 修复(2026-09-21)

分支 `r21/integrate3`,起点 `2946526`(W3 合流树,见 `.superpowers/sdd/r21/integrate-w3-report.md`),本轮 9 次提交(7 次代码 + 1 次文档与基线),末尾 `44b081f`。未 push、未 merge。
业主原话「照片的逻辑不应该是视频的那一套」是本轮判据;规格 §0.5 / §0.6 / §6(W3:RAW 三类样张、归档注入故障可对账)。

## 1. 合入(本轮提交)

| 提交 | 项 | 先红后绿 |
|---|---|---|
| `af8eda3` | **P1-1** 照片工作台顶栏换成照片自己的三步 rail「① 导入 N 张 → ② 挑选 M 张已选 → ③ 导出精选照片」;主按钮「下一步:导入照片 / 挑选照片 / 导出精选照片 / 再导出一次」,tooltip 三句照片话,没有「补缺口」;视频四步 rail 的 DOM 与冻结 AX 名一字不变(视图抽成 `RailView`,`TopBar` 按 `workspaceMode` 分派 `VideoTopBar` / `PhotoTopBar`,视频侧一个 hook 都不多跑) | `TopBarPhoto.test` 5 条,红 4 → 绿 |
| `7c55eea` | **P1-2** 状态条在照片工作台「N 张 · 已选 M 张 · 正在分析 x/y(约 T)」取代「已导入 N 条 · 共 X 分钟」;`ArchiveRecoveryEntry variant="photo"`:「上次导出未完成 · 继续导出 / 导出已完成 / 导出记录与撤销」,只列 kind=photo 的归档,视频侧仍「交付」、只列素材包 / 整包 | `StatusStripPhoto.test` 3 条 + `ArchiveRecoveryEntry.test` 新 2 条,红 4 → 绿;`photoTerminology.test` 词表补「段(放行「时段」)/ 章 / 分钟」并新增扫壳一条 —— 把 6 个源文件换回 `2946526` 跑红 1,换回来绿 |
| `4bc8aac` | **P1-3** 删 `build_contact_sheet_items` / `build_shot_list_csv` 的照片分支(「整张 / 展示 N s」),加 `debug_assert` 守「照片不进整包」;`photo_delivery_hold_and_legacy_schema` 改钉视频行 | cargo 1288 绿、clippy 0 |
| `04d52eb` | **F-W3-04(P1)** 空闲态 `get_export_status` 改 `video_only`:视频交付抽屉「内容」行不再把精选照片算进项数与时长 | Rust 新测试红(3 ≠ 1)→ 绿 |
| `4ed6861` | **F-W3-01(P1)** 视频线七只新手气泡(nav / heat / autoselect / shot / gap / export / autoplay)在照片工作台不出 | `guides.test` 新一条红(nav)→ 绿 |
| `017464a` | **F-W3-02(P2)** 照片卡不挂「静音 / 削波 / 手持抖动」角标 | `AnalysisPanel.test` 新一条红 → 绿 |
| `5ded3de` | **F-W3-03(P2)** 照片导出与视频导出的「导出过了没」分开:`EpisodeSummary.photo_export_count`(manifest.mode=photos)、`EXPORT_DONE_EVENT` detail `"photo"`、两个会话计数 | `TopBarPhoto.test` 新 2 条,换回四个源文件红 2 → 绿;episode.rs 测试补断言 |

门禁(末尾树):typecheck 0 错、lint 0 错 1 既有 warning、vitest **236 文件 1703 通过 3 todo**、`next` 无关;cargo test **1288 通过 0 失败 7 ignored**、clippy `-D warnings` 0;`check-binary-size` PASS(二进制 26,771,376 B = 基线 91.2%,DMG 31,111,226 B = 99.9%);fast-gates 见 §2.14。

### 假设(无人值守自定)
- 归档恢复入口按工作台分类:照片抽屉只列 `kind=photo`,视频抽屉只列素材包 / 整包。旧三条通用测试的夹具 kind 由 `photo` 迁为 `kit`,断言不变。
- 「切回视频工作台原样」只保证壳与 rail;视频状态条的「已导入 N 条」仍数全库素材(0.11.0 既有口径),未动。

## 2. 真机逐项

包:`旅剪工作台_0.11.0_r21w3-qa-4bc8aac_qa_aarch64.dmg`(P1×3 后,SHA-256 `ee6763f2…3fc0555`)做主验收;`旅剪工作台_0.11.0_r21w3-qa-5ded3de_qa_aarch64.dmg`(四条发现修完,SHA-256 `d22940bf…dbd3ec8`,`audit-dmg` **13/13 PASS**)复验四条发现。两包都从 `src-tauri/target/release/bundle/dmg/`(打包时临时符号链接到主仓共享 target,打包后删除)拷 .app 到 scratch 直接起可执行文件。
隔离:`TRIPCUT_APP_SUPPORT_DIR=<scratch>/w3/profileN`、`TRIPCUT_EXPORT_DIR` 在 profile 内、`TRIPCUT_UPDATER_ENDPOINT=http://127.0.0.1:9/`(日志两次 `update check skipped: endpoint unreachable`)、`TRIPCUT_DISABLE_LLM_PROVIDERS=1`;激活只用 System Events 按 pid;导入不用 `open -a` —— 往 profile 的 `watched_folders` 播一行 + AX 按「立即扫描」;截图按自己 pid 的 windowID;开始前 `AppleClamshellState = No`、`CGSSession` 无锁屏键。未碰 `~/Library/Application Support/TripCutStudio/`、`/Applications/旅剪工作台.app`;唯一另起的进程是 0.11.0 预览包(§2.7)与 `bench/check-startup` 自己起的 5 轮。

夹具(`<scratch>/w3/fixtures`,80 个文件):60 张 4032×3024 HEIC(`sips` 合成,12 张 Orientation 6、6 张带 `-04:00` offset)+ 5 张透明 PNG + 假 `DSC09999.ARW+JPG+xmp` + `minimal-rgb.dng`(仓内 `qa/ai-eval/raw/`,64×48 方向 6)+ 本机真 Sony A7R III `A7R03675.ARW`(`mdfind` 命中的 ArcNexus 市场素材,只读复制,43.2 MB)+ 10 条 8 s 1080p 视频。前后 80 个 SHA-256 **diff 为空**(三个 profile、六次导出之后)。入库:photo **68**(60+5+1+1+1)/ video 10,failed 0,`photo_meta.error` 0,`DSC09999.JPG → raw + xmp` 伴随,`A7R03675.ARW` 7952×5304 `ILCE-7RM3`,`minimal-rgb.dng` 48×64 方向 6,竖图 12。

证据目录:`qa/runs/2026-09-21T05-00-00Z-r21-w3-native/`(43 张截图 + 18 份证据,`SHA256SUMS.txt`;不入库)。

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 2.1 | 照片工作台顶栏 / 状态条 / 入口无视频概念(AX 全树 grep `剪映|镜头带|段(非时段)|章|秒|分钟|交付|素材包|整包|粗剪|镜头表|快速导出|排列`) | ✅ 主包:rail「导入 68 张 → ② 挑选 → ③ 导出精选照片」、主按钮「下一步:挑选照片」、状态条「68 张 · 已选 0 张」;grep 唯一命中是新手气泡「导入 → 挑选 → 排列 → 导出」→ **F-W3-01**,修后包 grep **0 命中**。选 6 张后 rail「挑选 6 张已选」、状态条「已选 6 张」、主按钮「下一步:导出精选照片」 | `01-photo-ws`、`02-topbar-crop`、`04-topbar-crop`、`30-v2-photo-ws`、`ax-photo-ws(-v2).txt` |
| 2.2 | 照片工作台无「交给剪映」,只有「导出精选照片」 | ✅ 抽屉 AX:「导出精选照片」区块 + 「将导出的照片」6 行 + 页脚「更改文件夹 / 导出精选照片到上次文件夹」,无三卡、无 chip;主包里抽屉弹「…再切「完整交付包」」气泡 → **F-W3-01**,修后包不弹 | `05-photo-export-drawer`、`ax-photo-deliver-drawer.txt` |
| 2.3 | 导出到临时文件夹 → winners JPG + 原件 / 伴随 + `顺序.txt`,`archive_ops` done | ✅ `EP01_精选照片_2026-09-21/`:`01_A7R03675.{jpg 7952×5304 sRGB 7.9 MB, ARW 与原件 cmp 相同}`、`02/03_IMG_*.jpg 4032×3024`、`04_DSC09999.{JPG,ARW,xmp}`、`05_minimal-rgb.{jpg 48×64, dng 相同}`、`06_透明_2.PNG`;`顺序.txt` 六行「NN 文件 照片[ · RAW]」无章名无秒数;op `85dabf44` photo done,12 个文件 published;目标旁无 `.tripcut-*` 残留;结果卡「已导出 6 张照片」 | `06-photo-export-done`、`photo-export-order.txt`、`profile1-archive-ops.txt` |
| 2.4 | 视频工作台素材包 / 整包不含照片 | ✅ 素材包 `EP01_剪映素材包_2026-09-21/`:2 章各 1 个 mp4 + `顺序.txt`,照片文件 **0**;整包 `EP01_交付_2026-09-21/`:`01_精选原片/{001,002}_VID_*.mp4`、`04_参考粗剪/参考粗剪.mp4`、`05_镜头表/{联系表.pdf,剪辑清单.csv}`、`交付说明.txt`,照片文件 **0**,op bundle done 7 文件。**但**整包表单「内容」行写「8 项 · 预计 0:34」(2 视频 + 6 照片 × 3 s)→ **F-W3-04**,修后包「2 项 · 0 段精选片段 · 2 条收藏的整条视频 · 预计 0:16」 | `09-kit-done`、`10-full-form`、`16-full-done`、`33-v2-full-form` |
| 2.5 | RAW 卡角标与预览来源,真 ARW 出缩略 | ✅ `A7R03675.ARW` 卡右上「RAW」角标、缩略与静态检视都是真实画面(驾驶室),EXIF 行「7952×5304 2026-01-19T11:32:41-05:00 ILCE-7RM3 FE 16mm F1.8 G Display P3 41.2 MB」;`minimal-rgb.dng` 卡「RAW」+「RAW 预览较小」+ 48×64;`DSC09999.JPG` 卡伴随「RAW」可展开。真 ARW 也被标「疑似废片」(启发式,画面确实过曝天空,不算缺陷) | `03-raw-arw-selected` |
| 2.6 | 设置 › 分析三行 slider 只在「显示全部功能」开时 | ✅ 默认「工具与模型」页 AX 找不到「地平线端正 / 局部曝光 / 主体清晰」、「标定后生效」0 处;关于页打开「显示全部功能」→ 三个 `AXSlider` 值 0、「标定后生效」3 处;验完关回 | `17-settings-tools-default`、`18-settings-tools-showall` |
| 2.7 | 交付抽屉「上次未完成」入口:中断一次导出后出现并能恢复 | ✅(两种中断都做了)a)按下导出 0.3 s 后 `kill -9`:重启进「上次会话没有正常结束」页 → 进入工作台仍停在照片工作台;**作业队列自动续跑**,op `43bc12d8` 在 3 s 内自己 done(日志先 WARN「需要继续准备文件」再完成),入口只显示「导出记录与撤销」。b)同样 kill 后把目标目录 `chmod 000` 再起:op `10bed3c3` partial,入口「上次导出未完成 · 查看与继续」→ 展开列 10 个文件、4 条「Permission denied」、按钮「继续导出 / 撤销复制」;`chmod 755` 后按「继续导出」→ 2 s 内 done,`EP01_精选照片_2026-09-21-2/` 与第一次产物逐文件同名、ARW 与原件相同 | `12-recovery-page`、`13-photo-drawer-after-crash`、`14-recovery-entry-unfinished`、`15-recovery-resumed`、`profile1-tripcut.log` |
| 2.8 | 视频壳与 0.11.0 截图 diff | ✅(壳 0 差)0.11.0 正式预览包(`TripCut-Studio_0.11.0_github-preview…dmg`,SHA `d299467f…`)在独立 profile 用同一夹具、同一脚本走到视频工作台;整窗 AE=1647(0.027%),全部落在媒体池的**数据顺序**上:日期 chip「09/18 上午 1 / 09/17 下午 4」互换、卡片文件名顺序 —— 同一 W3 包在 profile1 与 profile3 之间也差 160 px 同一位置(导入并发落库的 id 顺序不定,chip 按首次出现排);顶栏 / 监视器 / 镜头带 / 状态条 0 像素差。0.11.0 只入库 66 张(独立 ARW / DNG 不认),W3 68 张 | `20-video-shell-base`、`21-video-shell-w3`、`diff-video-shell`、`side.png` |
| 2.9 | 照片↔视频来回 5 次 | ✅ 五轮 AX:视频侧「10 条」+ rail「第 3 步 排列」,照片侧「68 张 · 已选 6 张」;五张照片截图两两 AE=0,五张视频截图两两 AE=86432 恒等(同一处:媒体池 hover / 选中态,轮间一致) | `07-alt-{1..5}-{video,photo}` |
| 2.10 | 菜单审计 / 原生审计 | ✅ 两包都是 `menu-audit` PASS(7 条顶级菜单)、`native-audit` 4 通过 / 0 缺陷 / 0 探针故障 | `menu-audit(-v2).json`、`native-audit(-v2).json` |
| 2.11 | 退出无 `.unclean-exit` | ✅ 主包 profile1 ⌘Q 261 ms 退出、profile3 / 修后包 profile4 ⌘Q 后 `.unclean-exit` 不存在;两次 `kill -9` 后 sentinel 如期存在并进恢复页 | — |
| 2.12 | `bench/check-startup`、`check-binary-size` | ✅ startup 5 轮 rust_setup_ms 399 / 288 / 273 / 276 / 274,中位 276(阈 400)PASS;binary-size PASS(§1) | — |
| 2.13 | 主包 `audit-dmg`(未单跑)/ 修后包 | ✅ 修后包 13/13 PASS(`evidence/dmg2-audit/`) | — |

### 2.14 fast-gates(`5ded3de` 上跑,`qa/runs/r21-w3-final-fast-gates/`)
28 门 **27 PASS / 1 FAIL**:唯一红是 `preview-diff-dark` 里 `45-photo-export-drawer` 找不到「第 4 步 导出」——剧本按视频 rail 找入口,照片工作台现在是「第 3 步 导出精选照片」(P1-1 的预期后果)。`photo-scenario.mjs` 改按照片 rail 找、并断言照片工作台没有视频四步 rail(`exact: true`,「照片流水线」含「流水线」子串会假红);重跑 `preview-diff` 52 张里 41–44 超阈(0.67–0.68%,差异全在顶栏 rail 与状态条文案),45 在阈内 → 41–45 五张基线重拍,`--enforce` **0 张超阈、0 张缺失**。`perf-bench-100` total 360,456 ms = 基线 69.3%;vitest / cargo / clippy / audit 同 §1。这两处改在 `docs` 提交里一并入。

## 3. 发现

| 编号 | 级别 | 发现 | 处置 |
|---|---|---|---|
| F-W3-01 | P1 | 照片工作台弹视频线新手气泡:第一只「这一条就是流程:导入 → 挑选 → 排列 → 导出」、照片导出抽屉里「…想整包交给别人再切「完整交付包」」(锚点 `nav.pipeline-rail` / `.deliver-drawer` 两边共用) | **已修** `4ed6861`,修后包真机复验 0 命中 |
| F-W3-02 | P2 | 照片卡挂「静音」角标(照片 `has_audio=false` 是常态);导出清单的 `l1_summary` 也带「静音」 | **已修** `017464a`(卡片);清单 `l1_summary` 是整包镜头表的字段,照片不进整包,未动 |
| F-W3-03 | P2 | 导出一次精选照片后视频 rail「导出 1 次」、④ 打勾;视频导出也会让照片线「再导出一次」 | **已修** `5ded3de`,修后包复验:视频「④ 导出」无计数、照片「导出精选照片 1 次 / 再导出一次」 |
| F-W3-04 | P1 | 视频整包表单「内容」行「8 项 · 预计 0:34」把 6 张照片与 hold_ms 算进去(空闲态 `get_export_status` 未过滤) | **已修** `04d52eb`,修后包「2 项 · 预计 0:16」 |
| F-W3-05 | P2 | 归档恢复入口:目标不可用时每个失败成员各一行英文 `filesystem error: Permission denied (os error 13)`(4 行重复、未中文化) | 记录,未修(archive 车道文案域) |
| F-W3-06 | P3 | 1512 宽四列照片卡的角标行「疑似废片 ×4 展开 擂台」相互压叠(`02-photo-ws-clean` 第一行) | 记录 |
| F-W3-07 | P3 | 48×64 的小 DNG 卡片按图像比例缩成窄卡,与邻卡不齐 | 记录 |
| F-W3-08 | P3 | 归档入口在导出**进行中**也说「上次交付 / 导出未完成」(op running 计为未完成,3 s 轮询) | 记录,既有行为 |
| — | 注 | 首次 `kill -9` 中断的照片导出被作业队列自动续跑完成(不是缺陷,是比恢复入口更早的一层);要看到入口的「未完成」态需要目标真的不可用 | — |

## 4. 留业主

1. **DNG 真样本**:iPhone 16/17 Pro Max ProRAW、Leica Q、GR III 各 ≥5 张仍缺;本轮 DNG 只有仓内 64×48 合成件(角标 / 「预览较小」/ 导出双份都对,但解码质量与真机预览大小无法外推)。
2. **真 iPhone HEIC**:P3/HDR/48 MP 的观感、缩略耗时仍是合成 70 KB HEIC 的下限数据(W1 F-R21-04 未变)。
3. 真 ARW 已用本机 A7R III 样张验过入库 / 缩略 / 检视 / 导出双份;其余机身(Leica / GR)无样本。
4. F-W3-05 的错误文案要不要中文化、F-W3-06/07 的卡片排版,由业主定优先级。
5. 可发性:P1 五条(P1-1/2/3 + F-W3-01/04)都已合入并真机复验,fast-gates 除剧本自身过时那一条外全绿、基线已重拍;`r21/integrate3` 可进 main 发 0.11.2。

发布:v0.11.1(main 267d9ee)
