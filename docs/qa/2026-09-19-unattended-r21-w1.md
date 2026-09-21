# 无人值守 R21 · Wave 1 真机验收(照片进媒体池 · photo-core / photo-ui / photo-deliver / video-polish)

规格:`docs/superpowers/specs/2026-09-19-r20-r21-video-photo-design.md`(§3 照片三波、§6 W1 验收);车道报告与合并接线报告在 `.superpowers/sdd/r21/`(不入库)。上两轮验收写法与探针教训:`docs/qa/2026-09-18-unattended-r19.md` §2 / §6。

## 1. 合入(`r21/integrate`,未 push、未进 main)

接线人合并的顶 `5644b2d`(四条车道 + 5 个接线提交,见 `.superpowers/sdd/r21/integrate-w1-report.md`)之上,本轮验收再加四个提交,验收包顶 **`01ba603`**(前半程用 `58a22cc` / `93a421c` 包,发现即修即重打):

| 提交 | 内容 |
|---|---|
| `85555a4` | **P1 时区(接线报告 §7.2)**:照片 `taken_at` 统一成 UTC 瞬时;视频 `…Z` 不再当成声明的 `UTC+00:00`;分组按本机钟面;迁移 0052 `photo_meta.taken_at_local`(见 §3 F-R21-01) |
| `58a22cc` | **P2 伴随列表压角标(接线报告 §6 观察)**:列表铺满封面框、一行一个文件(name 可省略 / role 不省略),展开时角标抬到列表之上;`preview-shots` 浏览器上下文钉 `timezoneId: Asia/Shanghai`(基线不随拍图机器时区漂) |
| `93a421c` | **P1 队列优先级(真机发现,§3 F-R21-02)**:`photo_probe` 没登记优先级落到 `ELSE 0`,混合导入时照片要等视频全部流水线跑完才建档;改与 `import_probe` 同级 60 |
| `01ba603` | **P0 镜头带写入失败(真机发现,§3 F-R21-06)**:0050 的 `clips.kind` 撞上 `story.rs::ensure_selected` 段分支的裸 `kind` → 带上有精选段时 `set_story_order` 一律 ambiguous column;限定 `segments.kind` |

门禁(`01ba603`):`typecheck` 0 错 / `lint` 0 错 1 条基线 warning / vitest **213 文件 1564 绿 + 3 todo**(本机 America/Toronto 与 `TZ=UTC` 各跑一次) / cargo lib **1161 绿**(1159 + 队列 + 故事板两条新测试) / `clippy --all-targets -D warnings` 绿。preview-shots 深色 @2x 对基线 47 张:**45 张 ≤0.155%**,`29-entity-menus` 2.148% / `34-move-to-episode` 2.499% 是媒体池整格上移 12 px 的老问题(接线报告 §4 第一趟就见过,chip 行逐像素相同;两次重拍都一样,不随本轮改动变,未重拍入库,记 §3 观察)。

### 1.1 时区修法(F-R21-01)

口径:**`clips.captured_at` 全库是 UTC 瞬时**(视频 `creation_time` 本来就是 `…Z`),排序 / 日期分组 / chapterize 都拿它比;**显示才换回本地**,靠 `clips.tz_guess`(`UTC-04:00`)或本机 `localtime`(story.rs Z-15 那条路)。

- `photo_probe::capture_time`:解析 EXIF `OffsetTimeOriginal` / `OffsetTime`(`±HH:MM`),有则用;没有则按**导入机时区**(`libc::mktime` + `tm_isdst=-1`,夏令时按拍摄日期算)把 `DateTimeOriginal` 的本地钟换成 UTC。`photo_meta.taken_at` 存 UTC RFC3339(`2026-09-19T14:02:00Z`);新列 `taken_at_local` 存带 offset 的本地原文(`2026-09-19T10:02:00-04:00`)只给检查器显示;用到的 offset 写进 `clips.tz_guess`。
- `import.rs::parse_timezone_offset_minutes`:`…Z` 返回 None。MP4/MOV 的 `creation_time` 一律写 Z,不代表相机在零时区;以前当 `UTC+00:00` 让无 GPS 视频的章名整章显示 UTC,还和 iPhone 的 GPS 时区报假冲突(`tz_conflict`)。没声明就退到 GPS 经度 / 本机 `localtime` —— 与照片无 offset 时同一条规则。
- 前端:`PhotoMetaDto` 加 `taken_at_local` / `tz_guess`;检查器「拍摄时间」显示本地原文;`poolGrouping` 按本机钟面(`Date` 本地 getter)分组,不再切字符串(多伦多 20:00 的 `…Z` 以前会被记成次日「凌晨」——视频侧的老问题,顺手一起修)。
- 先红后绿:E2E 夹具改成带 offset 照片 ×4(`+00:00`)+ 无 offset 照片 ×1(EXIF 写的是 10:10Z 在本机时区的钟面)+ 视频 ×5,断言十条按真实瞬时逐分钟交错、C10 的 `captured_at` / `tz_guess` / `taken_at_local`、章名 `本地(10:01)-本地(10:10)`。本机 offset 钉 0 → 红(C10 排到最前);Z 改回 `Some(0)` → 红,章名「第 1 章 · 10:01-06:10」原样复现(就是 perf_driver 露出的那条)。单元:带 / 不带 / 坏 offset、跨日进位、本机 offset 与 SQLite `localtime`/`utc` 修饰符一致(含夏令时日期)、三件素材按真实时间排序。
- 迁移 **0052 被占用**,W2 `duel_*` 改 0053、W3 归档 0054(已写进 `lane-common-dev.md`);W2 两条车道分支自 `5644b2d`,合并前先 rebase。

> **业主拍板(验收进行中送达)**:照片改为**独立板块**(照片工作台 tab),不与视频混排,0.11.0 不发混排版(规格 §0.5)。本文按此收口:发动机项(导入 / 建档 / 缩略 / 方向 / 时区 / 伴随 / 监视器静态检视与 mpv 互切 / 素材包结构 / 导出视频文件行为 / 旧视频路径 / 审计 / 退出 / bench)照验照记;「媒体池混排 / 镜头带照片段 / 照片计 3 s 预算 / 混排分章分组」标 **作废**,已测到的数据留作记录不作验收判据。

## 2. 真机验收

包:`TRIPCUT_PACKAGE_MODE=qa` ad-hoc,`旅剪工作台_0.10.1_r21-qa-{58a22cc,93a421c,01ba603}_qa_aarch64.dmg`(31.4 MB;二进制 25,436,096 B;`src-tauri/target/release/bundle/dmg/`)。从 DMG 拷出的 .app 以 `TRIPCUT_APP_SUPPORT_DIR=<scratch>/profileN` 直接起可执行文件(不 `open -a`),只碰自己起的 pid;**`TRIPCUT_UPDATER_ENDPOINT=http://127.0.0.1:9/latest.json`**(见 §3 F-R21-03,不设这条 QA 包退出时会把自己换成 GitHub 上的 0.10.2)。

夹具(`<scratch>/r21/make-photo-fixtures.py`,全在 scratch,**不碰业主目录**):100 张 **4032×3024 HEIC**(`sips` 从合成 PNG 转,手拼 EXIF APP1;20 张 Orientation 6 竖图,10 张带 `OffsetTimeOriginal -04:00` 模拟 iPhone,其余无 offset 模拟相机)+ 5 张 1600×1200 **透明 PNG**(无 EXIF)+ 20 张 4032×3024 **JPG**(EXIF 无 offset)+ 1 组 **`DSC09999.ARW+JPG+xmp`**(假 RAW 64 KB)+ 1 组 **`IMG_0099.HEIC+MOV` Live**(同 stem)+ **10 条 1920×1080 8 s 视频**(ffmpeg,`creation_time` UTC)。EXIF 时间打散到 09-17 / 09-18 两天(本地钟 09:30 起每 7 分钟一张),视频按 UTC 14:03 / 15:33 / 17:03 / 18:33 / 20:03 = 多伦多 10:03 … 16:03 与照片交错。**注意**:合成 HEIC 是渐变图,只有 ~70 KB,解码比真 iPhone 照片(3–5 MB,P3/HDR)便宜得多——本轮的解码 / 缩略耗时是下限,不是真机 iPhone 数据(§4)。

截图目录:`/private/tmp/claude-501/-Users-xin-Desktop-Torquemax-codex-split-prep/0b1eb8a1-56bc-4f37-9f8f-c0573756a979/scratchpad/r21/shots/`;preview-shots 浅 / 深:`qa/preview/r21-w1-qa-{light,dark,dark2}/`(不入库)。

### 2.1 环境事故(决定了本节能验到哪)

- 21:15 起第一个实例(`r21-qa-58a22cc` 包,profile1):首页 / 「新建一集」/ 导入抽屉 AX 树正常;21:16 `open -a` 导入 136 条。**21:16–21:17 之间屏幕被锁**(`CGSSessionScreenIsLocked = Yes`,`IOConsoleLocked = No`,显示器仍亮;业主不在机器前)。锁屏下 WKWebView 的轮询 / rAF 停,媒体池停在锁屏前那一帧(「10 条 · 全是视频」,此时 DB 里已 136 条),AXWindows 首元素退化成 AXApplication,所有 AX / 键盘探针不可用;`screencapture -l <windowID>` 抓到的是停住的旧帧。锁着的 21:17–22:16 只做 DB / 日志 / 文件能判的项(占位卡与缩略时间线、方向、时区、伴随、分章、bench、菜单审计)。**22:16 业主开锁并 ⌘Q 了我的实例**(干净退出,无 sentinel),之后业主在同机作业(前台 Chrome / cmux):22:20–22:40 重起 `93a421c` 实例做 UI 逐项,键盘事件只发了两次 ⌘Q,都按「置前 → 核对 frontmost 是 tripcut-studio → 发键 → 把前台还给原应用」;23:00 起 `01ba603` 包复验 P0。
- 21:44 想 ⌘Q 第一个实例:锁屏下 Apple Event quit 送不到 WebView,改 SIGTERM。**退出钩子把暂存的 0.10.2 更新装进了 QA 包的 .app**(`staged update installed on exit version="0.10.2"`,bundle `CFBundleShortVersionString` 从 0.10.1 变 0.10.2)→ F-R21-03。之后所有实例都带 `TRIPCUT_UPDATER_ENDPOINT` 指向回环死端口。
- 探针工具:本轮自写 `<scratch>/r21/ax.swift`(dump / press / find / frame / text,`AX_FAST=1` 跳过 AXEnhancedUserInterface 等待)+ `shot.sh`(按 `kCGWindowName == "旅剪工作台"` 取 windowID,不取 layer 0 的第一个——那是菜单栏 / 500×500 的辅助窗)。

### 2.2 逐项

| 项 | 结果 |
|---|---|
| 导入 → 占位卡 ≤3 s | **DB 时间线**(profile2,`93a421c`,126 照片 + 10 视频 `open -a`):第一条 `photo_probe` 入队 → 做完 **+0.07 s**,126 条全部建档 **+0.88 s**(`clips.imported_at` 27.926 → 28.740);修前(`58a22cc`,profile1)第一条 photo_probe **+4.4 s**、全部 +6.8 s —— 照片排在 10 条视频的缩略 / 分析 / 代理 / 完整哈希之后(F-R21-02,已修)。**UI 上「卡出现」的秒数未量到(锁屏阻塞)**;按建档时间算 ✅ |
| 全部缩略 ≤4 s | **❌(记数字)**:profile2 混合 136 条,照片缩略第一张 **+0.96 s**、126 张全部 **+9.5 s**(视频的 analyze / proxy / ocr 同时抢 4 个 worker);profile3 **只有 100 HEIC + 20 JPG**:建档全部 +1.0 s,缩略第一张 +1.2 s、**120 张全部 +6.6 s**(≈ 5.5 s / 100 张)。每张 thumbnail 任务 = ImageIO 解 4032×3024 + cover 512 + preview 2048 两次 JPEG 编码,4 worker 均摊 ~180 ms/张;夹具还是 70 KB 的合成图,真 iPhone HEIC 只会更慢 → F-R21-04(P2,拍板项) |
| 方向全对 | DB:`photo_meta.orientation = 6` **20 张**,对应 `clips.width×height = 3024×4032`(已按方向换算)**20 条** ✅;真机:池里 `IMG_0000 / 0005 / 0010` 卡片缩略是竖的、角标「3024×4032」,监视器里 `IMG_0005.HEIC` 竖图正立、居中留黑边 ✅ `21-photo-tile-in-band.png` |
| 媒体池混排按时间 / 照片角标 / 尺寸 / 伴随 RAW 展开 | **混排项按 §0.5 改独立板块,作废**(数据留记录):真机(profile3,120 照片先导、再 `open -a` 16 条:10 视频 + RAW 组 + 5 PNG):AX 池序 `IMG_0000 … IMG_0004 → VID_00 → IMG_0005 …`(VID_00 = 10:03 本地,落在 09:58 与 10:05 之间)✅ `11-photo-selected.png`;每张照片卡角标「照片」+ 尺寸替时长(`4032×3024` / 竖图 `3024×4032`),视频卡仍是时长 ✅;后端 `list_clips` 136 条全 `ready`;`clip_companions`:`DSC09999 → raw + xmp`,`IMG_0099 → live_mov` ✅。RAW 角标展开只在 preview-shots 37 看了(两行「湖畔晨光.AR… RAW / …xmp… XMP」不压角标,`qa/preview/r21-w1-qa-light/37-photo-mixed-pool@2x.png`),真机没点(DSC09999 卡在池底部,没滚过去)|
| 镜头带照片段「3 s」固定宽 | **按 §0.5 改独立板块,作废**(记录):✅(`01ba603` 包):检查器「加入当前章节」→ toast「已加入第 1 章「第 1 章 · 09:30-16:44」,并已自动收藏整条」,带里 `镜头 3：IMG_0005.HEIC` 140×112 与视频镜块同宽、角标「3 s」、章头「0:19 · 3 镜」= 8 + 8 + 3 ✅ `21-photo-tile-in-band.png`。**`93a421c` 上这一步 ❌** → F-R21-06(P0,已修)|
| 选中照片监视器即出 / 三控件 / 切回视频 mpv / 照片↔视频来回 5 次 | ✅:点 `IMG_0003.HEIC` 卡 → 监视器 1.5 s 内出图(`11-photo-selected.png`),控件「上一张 / 下一张 / 放大 100%」,「播放 / I / O」灰、无 seek 条;**照片 → 视频 → 照片 5 个来回**(`12-alt-{1..5}-{video,photo}.png`):监视器区域灰度均值 / 标准差视频帧 0.733 / 0.137、照片 0.732 / 0.125,十张全部非黑、两类各自逐帧一致;来回后点「播放」时间码 **00:05.0 → 00:07.1(2 s)**,再切照片再切回视频再播 **00:05.0 → 00:07.1** 同样走 ✅ `13-video-playing.png` |
| 检查器照片字段 | ✅:`IMG_0003.HEIC` → 「尺寸 4032×3024 · 拍摄时间 **2026-09-17T09:51:15-04:00**」(EXIF 带 offset 的本地原文,不是 UTC);夹具没写机身 / 镜头 / GPS,三行按设计不出现;`IMG_0005`(无 offset)→ `2026-09-17T10:05:15-04:00`(导入机时区补的)`11-photo-selected.png` / `21-…` |
| 结果面板「可修:…」 | 真机自动挑选 3 段(VID_00 / 03 / 05,「3 段 · 共 24.0 s · 全部素材 · 按时间顺序 · 约 30 秒」)理由都是「清晰 · 曝光正常 · 有声音」,合成夹具没有可修项,**「可修:」行没机会出现**;离线 preview-shots 35 浅 / 深「可修:曝光偏亮」「未选:…」在 ✅ `14-autoselect.png` |
| 「换一段」→ ⌘Z 回原位 | 视频侧通用项,**未验(夹具不够)**:10 条 8 s 合成视频每条只有一个候选段,「换一段 · VID_03」按了没有反应(同素材没有别的段可换);要 30 s+ 的多段视频夹具,R19 §6.4 已在 `a9d1279` 上验过位置不动 |
| 自动挑选混排(照片计 3 s) | **按 §0.5 改独立板块,作废**。W1 本来就不含照片:`smart_select.rs:141/326` 对 photo 直接跳过,照片分支属 W2 group 车道(规格 §4);真机 126 照片 + 10 视频挑出的 3 段全是视频。照片进带走「加入当前章节」/ 收藏整条,计 3 s(上一行)|
| 导出三卡 / 「交给剪映」素材包 / 「导出视频文件」遇照片被阻止 | ✅ 三卡各带照片计数:「交给剪映 · 1 张照片一起交付」「导出视频文件 · 只导片段和收藏的视频文件 · **1 张照片需用素材包**」「整包交付 · 1 张照片一起交付」`18-deliver-cards.png`;点「导出视频文件」→ 面板「本集含 1 张照片,视频文件导出暂不支持照片;请用「交给剪映」或「整包交付」」+ 两颗跳转按钮,页脚「导出」`enabled=false` ✅ `19-quick-export-photo-block.png`;「交给剪映」→ 预览列表「4 个片段 · 共 0:27 · 附「顺序.txt」」→ 「导出剪映素材包到上次文件夹」(`ui.export.last_dir` 预先写进 settings,绕开原生面板)→ ~8 s toast「已导出 4 个片段 · 打开剪映」`20-kit-done.png`。落盘:`EP01_剪映素材包_2026-09-19/顺序.txt`(4 行,第 4 行「`IMG_0003.HEIC 照片 · 3 s`」)、`01_第 1 章 · 0930-1644/{01_…VID_00.mp4, 02_…VID_03.mp4, 04_…IMG_0003.jpg}`、`02_第 2 章 · 0930-1644/03_…VID_05.mp4`、`.tripcut-complete.json`;**HEIC → `.jpg` 4032×3024 sRGB IEC61966-2.1、无 alpha、532 KB(全分辨率)** ✅。伴随同目录只在 E2E 盖住(真机导出的照片没有伴随)|
| 分章 / 日期分组时间正确(修完时区后) | 发动机项(时区口径对视频侧同样生效)✅;混排后的章 / 组构成本身按 §0.5 作废。`chapters` = **「第 1 章 · 09:30-16:44」「第 2 章 · 09:30-16:44」**(09-17 / 09-18 各一章,时分是多伦多本地;修前同一批在 perf_driver 上是「10:01-06:10」),镜头带章头与检查器「章节」下拉同名;分组 chip **「09/17 上午 14 · 09/17 下午 54 · 09/18 上午 14 · 09/18 下午 49 · 时间未知 5」**(09:30 起 13 张照片 + 10:03 的视频落在「上午」,11:00 后是「下午」;5 张无 EXIF 的 PNG 进「时间未知」)`11-photo-selected.png`;DB:`IMG_0003.HEIC`(EXIF `09:51:15` + `-04:00`)→ `captured_at 2026-09-17T13:51:15Z`、`tz_guess UTC-04:00`、`taken_at_local …09:51:15-04:00`;`IMG_0000.HEIC`(无 offset)→ `13:30:15Z` + `UTC-04:00`(导入机时区);视频 `VID_00` `14:03:00Z` 排在 IMG 09:58 与 10:05 之间。修后 preview-shots 01–38 的 chip 行与基线逐像素相同(`timezoneId` 钉东八区)|
| 透明 PNG / 无 EXIF | 5 张 `透明_*.PNG`:`has_alpha = 1`、`captured_at NULL`(进「时间未知」组,不猜 mtime)✅;`photo_meta.error` 全库 **0** |
| 旧视频路径 preview-diff 0 | 深色 @2x 47 张:45 张 ≤0.155%(改动只在 37 / 38);29 / 34 的 2.1–2.5% 是媒体池上移 12 px 的老问题(§1)。浅色 47 张 console 0 / page errors 0 ✅ |
| 菜单审计 | `menu-audit.mjs --pid` **PASS(7 条顶级菜单)**;`native-audit/run.mjs --pid` 锁屏下 3 通过 / 1 探针故障(`app.window-on-screen`,套件自己认出是锁屏),开锁后重跑 **4 通过 / 0 缺陷 / 0 探针故障** ✅ |
| 退出无 `.unclean-exit` | ✅ 三次:业主 22:16 ⌘Q 的 `93a421c` 实例、我 22:40 ⌘Q 的 `93a421c` 实例、23:05 ⌘Q 的 `01ba603` 实例,profile3 都无 sentinel;`01ba603` 的 bundle 退出后仍是 0.10.1(带了 `TRIPCUT_UPDATER_ENDPOINT`)。System Events 的 Apple Event `quit` 对这个 Tauri 包**不生效**(开锁后也不退),只有 ⌘Q 有效 |
| bench · `check-binary-size` | **PASS**(`58a22cc` 包):binary 25,436,096 B vs 基线 29,360,464(86.6%);dmg 31,414,680 B vs 31,139,512(**100.9%**,新依赖 objc2-image-io / image / image_hasher 加了 ~275 KB;后两个包 31,414,887 B / 同量级)|
| bench · `check-startup` | rounds=5:**374 / 214 / 205 / 244 / 240,median 240 ms**(空库阈值 400)PASS(锁屏下起,无首帧竞争,不与 R19 §2 的 353 直接比)|

## 3. 发现

- **F-R21-01(P1,已修 `85555a4`)** 照片 `taken_at` 与视频 `captured_at` 不是一套时区:EXIF 本地钟原样入库、视频 UTC,排序 / 分组 / 分章按字符串比 → 同一分钟拍的被排开一个时区、分到两章(章名「10:01-06:10」)。修法见 §1.1。附带修了视频侧两条老问题:`…Z` 被当成声明的 `UTC+00:00`(无 GPS 视频章名整章 UTC、iPhone 的 GPS 时区报假冲突)、分组 chip 按 UTC 字面时分(多伦多 20:00 记成次日凌晨)。
- **F-R21-02(P1,已修 `93a421c`)** `jobs::claim_next` 的优先级表没有 `photo_probe`,落到 `ELSE 0`(比 `full_hash` 8 还低):混合导入时照片要等视频的缩略 / 分析 / 代理 / 完整哈希全跑完才建档 —— 真机 10 条视频就让第一张照片晚了 4.4 s,100 条视频的批次就是几分钟,规格「≤3 s 出占位卡」不可能达标。改与 `import_probe` 同级;修后 126 张 0.88 s 全部建档。
- **F-R21-03(P1,流程,未修 —— 需拍板)** QA 包(0.10.1)启动 6 小时内自动查更新,发现 GitHub 上有 0.10.2 就后台下载暂存,**退出钩子 `install_staged_on_exit` 把 .app 原地换成 0.10.2** —— 验收包第一次退出后就不再是候选包了(bundle 版本号实测从 0.10.1 变 0.10.2)。R19 两轮「同一 profile 升级启动」没踩到只是因为当时线上没有更高版本。运行时不知道自己是 QA 包(`TRIPCUT_PACKAGE_MODE` 只进 DMG 文件名)。本轮绕过:`TRIPCUT_UPDATER_ENDPOINT=http://127.0.0.1:9/latest.json`。建议:qa / preview 模式把 `updater.auto_update` 默认关(package-dmg.sh 写进 bundle 或 build stamp 进 Info.plist),或 QA 手册固定带这个 env。
- **F-R21-04(P2,记录 —— 拍板项)** 「全部缩略 ≤4 s」没达标:100 HEIC + 20 JPG 纯照片批次 120 张缩略 6.6 s(≈ 5.5 s / 100),混合 136 条 9.5 s。每张 thumbnail 任务同时产 cover(512)与 preview(2048)两张 JPEG;4 worker 均摊 ~180 ms/张,夹具还是 70 KB 合成图。可选:cover 与 preview 拆成两个任务(preview 优先级降到分析之后)、或 cover 走 ImageIO 的 embedded thumbnail(iPhone HEIC 自带 320 px 缩略)。真 iPhone 数据见 §4。
- **F-R21-06(P0,已修 `01ba603`)** 镜头带上只要有一个精选段(自动挑选 / I·O 保存片段),任何 `set_story_order`(拖排、「加入当前章节」、撤销)都报「加入镜头带没成功:ambiguous column name: kind in SELECT EXISTS(…」:photo-core 的迁移 0050 给 `clips` 加了 `kind`,`story.rs::ensure_selected` 段分支 `segments JOIN clips c` 里裸写的 `kind = 'select' AND tombstone = 0` 编译不过。**纯视频库同样中招**,四条车道 + 接线的 1160 条 cargo 测试没盖到段路径(`set_story_order` 的测试全走 whole)。改成 `segments.kind / segments.tombstone` + 一条段路径测试(改回裸 kind → 红);全仓 SQL 字面量扫过,其它裸 `kind` 都在单表 `FROM segments` 子查询里。真机复验:照片进带、带序 `VID_00 → VID_03 → IMG_0005 → VID_05`、章头「0:19 · 3 镜」。
- **F-R21-05(P2,记录)** 深色 preview-shots `29-entity-menus` / `34-move-to-episode` 稳定 2.1–2.5% OVER:媒体池整格比基线上移 12 px(chip 行、搜索框、筛选行逐像素相同),接线报告 §4 第一趟也见过、重拍后曾归零 —— 与本轮改动无关,像是引导气泡让位的时序;基线没重拍,下轮先查 `.ui-guide` 出现时机再定。
- **观察(混排,按 §0.5 作废)** 素材包 `顺序.txt` 里收藏整条的照片(不在带上的候选)编号排在带上三段之后(`04 … IMG_0003.HEIC 照片 · 3 s`),但文件放进它自己的章目录 `01_第 1 章`,于是 `02_第 2 章/03_…VID_05` 的编号比 `01_第 1 章/04_…IMG_0003` 小 —— 带序 + 候选追加的既有规则,不是照片专属;拖进剪映按编号排就是「视频三段 → 照片」。业主看一眼要不要按章内时间插。
- **观察** 「导出视频文件」被照片挡住时页脚「导出」按钮仍是实心主按钮样式(AX `enabled=false`,视觉上只是略灰),V-01 之外;建议禁用态换 ghost。
- **观察** `open -a <app> <folder>` 在没有活动集时(本轮 profile2 / profile3 起来就 `open -a`,没先点「新建一集」)照样导入并建了集(`episode_id = 1`),分析照跑。
- **探针教训**(进 R19 §4 那一类):① 锁屏可以在验收中途发生(不只是起包时),判据 `ioreg -n Root -d1 | grep CGSSessionScreenIsLocked`,`IOConsoleLocked` 与显示器亮不亮都不算;锁屏下窗口级截图抓到的是停住的旧帧,不是「界面没刷新」的缺陷;② 锁屏下 ⌘Q / Apple Event quit 都送不进 WebView,SIGTERM 退出钩子照跑(含更新安装!);③ `screencapture -l` 要按 `kCGWindowName` 选窗,layer 0 的第一个可能是菜单栏或 500×500 的辅助窗;④ DB `jobs.created_at / updated_at` 与 `clips.imported_at` 能在没有 UI 的情况下量「建档 / 缩略」时间线,占位卡秒数的上界就是建档时间。

## 4. 留业主(真机 / 真样本)

1. **真 iPhone HEIC(P3 / HDR / 48 MP)**:cover / preview / 素材包 JPG 的观感(`DecodeToSDR` + sRGB 画布没人看过真图);两张 48 MP 来回切换的内存峰值;100 张真 HEIC 的冷启动缩略秒数(本轮合成图 120 张 6.6 s 是下限,F-R21-04 拍板要真数)。
2. **真 ARW / DNG**:companions 只按同 stem 配对,真相机卡上的 `DSC00042.ARW + JPG + xmp` 与 DNG 单文件各一组;RAW 本身 W3 才解。
3. **Live Photo 真样本**:iPhone 导出的 `IMG_xxxx.HEIC + MOV`(本轮合成 MOV 只证了配对为 `live_mov`,没看 Apple asset identifier)。
4. **「换一段」→ ⌘Z 与「可修:」行**:要 30 s+ 多段、带曝光 / 抖动问题的视频夹具(本轮 8 s 合成视频每条一段、理由全绿);RAW 角标展开真机没点(离线截图有)。
5. **F-R21-03 拍板**:qa / preview 包要不要默认关自动更新。
6. 素材包里视频的 `.srt` 会跟着进 `01_章节/`、照片没有 —— 要不要在 `顺序.txt` 里区分(接线报告 §7.6,未决)。

## 5. 结论

**发动机可合并,壳层待照片工作台**(业主拍板 §0.5:照片独立板块,0.11.0 不发混排版)。

- **可合并的发动机**(`01ba603`,真机 + DB + E2E 证据):导入建档 126 张 0.88 s、缩略 120 张 6.6 s(F-R21-04 数字留给照片工作台定预算)、方向 20/20 正立、EXIF 时间统一 UTC + 本地原文 + `tz_guess`(F-R21-01,视频侧 `…Z` 假 UTC+00:00 与分组 chip 按 UTC 两条老问题一并修掉)、伴随 RAW+xmp / Live MOV 配对、监视器静态检视三控件 + 照片 ↔ 视频来回 5 次 mpv 不黑不卡且播放照走、素材包 HEIC → 全分辨率 sRGB JPG + `顺序.txt` 照片行、「导出视频文件」遇照片被挡并引导、旧视频路径 preview-diff 45/47 ≤0.155%(29/34 是老的 12 px 上移)、菜单 / 原生审计 4/4、三次 ⌘Q 干净、bench 两项 PASS。**1 P0(F-R21-06,纯视频库也中招)+ 2 P1(F-R21-01 / 02)已修并各有先红后绿的检测器。**
- **壳层作废待重做**:媒体池混排、镜头带照片段 3 s、自动挑选照片预算、混排分章分组 —— 已测数据留在 §2.2 作记录。
- **留业主**:F-R21-03(QA 包退出时把自己升级成线上版,验收流程隐患)、F-R21-04(缩略 6.6 s / 120 张的预算)、§4 真样本。未再动 P2。
