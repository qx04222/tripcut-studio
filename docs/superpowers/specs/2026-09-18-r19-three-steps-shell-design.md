# R19 「三步交给剪映」:减法、新壳、可回归的易用性(0.10.0)

业主方向(2026-09-18):结合最近火爆的开源/闭源同类项目做新一轮大面积升级,最终目的**易用性、上手难度低、性能优化到位、UI 简约可视效果好**;允许重做壳层(四步流水线不变);规格先拍板再开发。
依据:五份只读调研 `.superpowers/sdd/r19/brainstorm-{product,usability,ui,perf-eng,editing-jianying}.md`(全部带 URL/文件:行号,不入库)。
既有原则继续有效(新手开包即用、一条流水线、参考剪映不抄资源、AI 产物可解释可撤销、原片只读、不上传)。

**业主拍板(2026-09-18)**:① 签名/公证不做,个人使用为主;② 导出首屏三卡(交给剪映 / 导出视频 / 整包交付);③ CLIP/whisper 模型走「首启引导后台下载」,进 R19;④ 剪映 11.4 草稿由业主真机验;⑤ **软件的主要目的是业主自己做旅居记录,开源是附带的事**。
⑤ 落到本轮:面向陌生新手的转化项降级(U-11「右键打开」卡与 P-11 主张只进 README,不做首启卡;E-10 8 GB 注入降为可选),**业主日常路径的质量升级**(交付内容深度 J-01/J-02/J-03、一句话挑片 P-01、结果面板 P-03、模型一键到位 P-06)升级为一等;前 5 分钟与性能基线以业主本机(M5)为主判据,8 GB 只做不回归。

## 0. 调研给出的三个硬结论(决定本轮方向)

1. **品类在 2026 火的是「机制」不是「功能」**:对话入口 + 可解释可撤销的一批动作 + MCP(OpenChatCut 2 个月 1.9k★、openshorts 5.1k★、Selects/Eddie);同形态的「本地粗剪工作台」没有自然流量(roughcut-stdio 5★ 停更)。我们的独占位置(中文 + 剪映交接 + 本地买断 + 非口播打分)没人占,**方向不改,改的是「进门到第一份交付」的路径长度**。
2. **我们不是「四步流水线」的形状,是「六件事同屏」的形状**:1440×900 一屏 84 颗控件、4 颗实心主按钮、顶部三条横条、主路径 ≥12 个新概念(剪映只有 3 个);「下一步:自动挑选」在分析未完时必然报错;首启三层教学同亮。前 5 分钟本可比所有对手短(30 MB、免登录),却被这些拖回原地。
3. **没有一道门禁会在性能或易用性倒退时变红**:`fast-gates` 24 条命令零性能断言;R18 说好的 W-3/W-5b 量测没人接;剪映草稿默认路在业主真机(11.4 已加密)上是死路,素材包才是实际能走通的路。

## 1. 本轮取舍

- **减法优先于新功能**:默认态收成「拖进来 → 它挑好并说为什么 → 交给剪映」;40% 的面进「显示全部功能」开关(默认关),不删代码。
- **壳层采用方案 B「Cut 页式两层」**:上层 媒体池 | 监视器,下层镜头带通栏,检查器改滑出层(选中即出、Esc 收、可 📌 钉住),顶部只一行;**任一视图最多一颗实心主按钮**(只剩顶栏「下一步」)。方案 C(四页)不做。
- **先让门禁红过**:前 5 分钟脚本、性能基准、单主按钮断言、术语词表、2x 截图 diff 都先对 0.9.1 跑出一次真实结果再接入。
- **剪映交接以素材包为一等公民**;草稿层的内容补全(章节标记/字幕轨)只做 11.3.0 金样已知的形状,且以 J-06 业主真机三步验证为前置。
- **不做**:出成片/口播去静音/多机位/剧本驱动、云端按量、Electron、新分析维度、英文界面与 Windows(R19)、方案 C、向导式 onboarding、示例素材、磁性时间线、CapCut 适配、FCPXML(先走开放问题)、签名公证(业主规则,只做「右键打开」卡)。
- 迁移号预分配:0049 `settings.show_all_features`(若落 DB 而非本地偏好)、0050 结果面板的 `auto_select_runs`(P-03 需要「这一批」的 run id 以支持整批撤销与「换一段」)。其它车道无迁移。
- 版本:Wave 1 → 0.10.0;Wave 2 → 0.10.1。

## 2. 团队与车道(业主点名的七个角色 → 六条车道 + 一个接线人)

| 角色 | 车道 | 说明 |
|---|---|---|
| 产品经理 | 接线人(主会话) | 合并、门禁、真机验收、决策项跟进;不写车道代码 |
| 易用性专家 | **flow** | 前 5 分钟主路径、教学仲裁、术语、专业模式开关 |
| UI 设计大师 | **shell**(W1)→ **tokens**(W2) | 方案 B 壳、单检视器、检查器滑出;令牌/动效/深色/截图基线 |
| 全栈工程师 | **band**(W1)→ **results**(W2) | 镜块/工具条/状态条减法;结果面板 + 一句话挑片 |
| 剪映专家 + 中英文剪辑专家 | **deliver**(W1)→ **draft**(W2) | 交给剪映单按钮、素材包按章带字幕;草稿章节标记/字幕轨/节拍重排 |
| 测试运维工程师 | **bench**(W1)→ **perf**(W2) | 性能/启动/内存/体积基准与门禁、前 5 分钟脚本;whisper 线程、A18-01 取证、300 段量测、8 GB 注入 |

模型分配:shell / flow / results 三条判断重的用 Opus;band / deliver / bench / tokens / draft / perf 用 Sonnet;接线人主会话不降级。

## 3. Wave 1(六条并行,文件不相交)

| 车道 | 内容(编号来自调研文档) | 文件所有权 |
|---|---|---|
| **shell** | V-03 镜头带通栏(`Group vertical`:上层/带/状态,上层内 `Group horizontal` 池\|监视器);V-04 检查器滑出层(`position:absolute` 盖井右侧,`region "检查器"` AX 名不动,📌 钉住记偏好,删 `INSPECTOR_AUTO_COLLAPSE_WIDTH`/`InspectorCollapsed`);V-05 单检视器(去井内 chip、去假时码热力行、井撑到栏边、传输条一行、热力画进 seek 轨);V-01 栏内 primary 全降 secondary,只留顶栏「下一步」;V-02 顶部一行(删 `PipelineHint`,文案进首页四步卡 + 主按钮 tooltip;`ToolchainBanner` 降为状态条红点 + 一句);V-11 单一断点 `--bp-compact: 1366px` | `WorkspaceShell.tsx`、`shellLayout.ts`、`TopBar.tsx`、`PipelineRail.tsx`、`PipelineHint.tsx`(删)、`ToolchainBanner.tsx`、`Monitor*.tsx`、`Inspector.tsx`/`InspectorCollapsed.tsx`(删)、新 `shell-r19.css` |
| **flow** | U-01 分析中不吃闭门羹(主按钮「先挑已分析的 x/N 条」,全 0 时禁用 + eta);U-02 教学仲裁器(提示条/气泡/首启卡/空态归一个 store,同一帧只出一个);U-03 零术语首页(一句话 + 「新建一集」/「继续上次」+ 最近的集;模板区撤,等 P-09 做实再回);U-05 库空时导入抽屉只一颗按钮;U-09 首次自动挑选零决定(直接按全部 + 平台预算跑,toast 给「改范围/改时长」);U-08 错误文案去「第 n 步」;P-05 「显示全部功能」开关(设置 › 关于;关时:镜头带只剩故事/音乐、检查器只剩评级/标签/章节/AI 描述、设置只剩项目/播放与导出/工具/关于;技术检查/LUT/多音轨/八维/旅程/地点卡/平台画布/键位预设/云端补镜进开关后);P-11/U-11 只改 README 首屏(四句主张 + 「被拦截时这样做」三步),不做首启卡;P-12 默认键位表 ≤15 行 | `pipelineModel.ts`、`pipelineActions.ts`、`guides.ts`(→ teaching store)、`OnboardingCard.tsx`、`HomeScreen.tsx`/`homeModel.ts`/`HomeCards.tsx`、`ImportSourcesTab.tsx`/`ImportDrawer.tsx`、`BandAutoSelect.tsx`(仅首次分支)、`errorText.ts`、`settingsGroups.ts`、`AboutSection.tsx`、`terminology.test.ts`、`keymap.ts`(仅默认表裁剪)、`smart_select.rs:325-340`(仅文案) |
| **band** | V-06 镜块三元素(封面 + 时长 + 一行名,动作条进 hover/focus-within/选中);V-07 工具条二级化(视图三芯片 → 「按章节 ⌄」,附属五标签 → 「附属:故事 ⌄」,剪映按钮进 ···;`role=tab` 与五个 tab 名保留);V-08 状态条静默化(空闲只圆点 + 库名) | `BandSegment*.tsx`、`BandChapter*.tsx`、`BandAccessory.tsx`、`BandJianyingButton.tsx`、`StatusStrip.tsx`、新 `band-r19.css`;**不碰栏根节点** |
| **deliver** | U-06/P-04 导出首屏三张大卡「交给剪映」「导出视频文件」「整包交付」(「交给剪映」内部按版本可用性选草稿/素材包,不让用户选;未核对版本一次点击即出素材包 + toast 一句);J-10 不可用时一行灰字说明差别;J-04 素材包按章节子目录 + `顺序.txt` 标章节边界;J-05 素材包带同名 SRT 与本集音乐;J-07 完成 toast「打开剪映」直达草稿/素材包所在目录;「试验草稿 + 人工确认」进「更多方式 ⌄」(AX 名冻结不变) | `DeliverDrawer.tsx`、`deliver/deliverModel.ts`、`src-tauri/src/core/jianying.rs`(仅素材包 kit 分支)、`src/workspace/deliver/*` |
| **bench** | E-02 `bench/`(100 条固定夹具 → `perf_driver` → JSON;`check-bench.mjs` 对 `bench/baseline/` 断言 total_ms +15% / rss +10%;`perf-bench-100` 进 `fast-gates`,500/2000 进 `npm run bench:full`);E-03 启动时间探针(真 .app,空库 <400 ms、1344 条库 <600 ms);E-04 稳态内存三场景;E-05 启动拆两段(`rust_setup_ms` / `first_paint_ms`);E-11 二进制/DMG 体积 +10% 门禁;E-12 `qa/perf/history.jsonl` 追加式历史 + 报表;U-12 `scripts/qa/first-five-minutes.mjs`(隔离 profile,数点击/可见新词/到导出文件秒数);**头两周只报告不拦截**(开放问题 Q-13) | `bench/**`、`scripts/qa/first-five-minutes.mjs`、`scripts/qa/fast-gates.mjs`(只追加条目)、`lib.rs`/`main.tsx` 各加一个时间戳、`qa/perf/` |
| **tokens-lite**(shell 的前置,半天,先合) | V-10 `--motion-exit`、全局 `prefers-reduced-motion`(允许的唯一新 `!important`,基线 5→1)、4 个 keyframes 引令牌;`tokens.test.ts` 新规则 | `tokens.css`、`tokens.test.ts`、`monitor-r10.css`(拆 6 行) |

接线顺序:tokens-lite → shell 主线(V-03→V-04→V-05)先合;band / flow / deliver / bench 与 shell 并行但只碰各自文件;flow 的 V-02 文案落点(首页四步卡)与 shell 的 `PipelineHint` 删除在合并时对齐。

## 4. Wave 2(Wave 1 合入并发 0.10.0 后)

| 车道 | 内容 | 依赖 |
|---|---|---|
| **results** | P-03 「为什么是这些」结果面板(每段:缩略图/时长/中文 reason/被去重的兄弟段可展开;「不要这一段」「换一段」;整批 ⌘Z;迁移 0050 `auto_select_runs`);P-01 一句话挑片(顶栏输入框 → 本地规则解析中文关键词 → `auto_select_episode` 参数;LLM 可用时增强,不可用不报错);P-09 模板做实 = 三条预设句(旅行日记/电影感/快节奏各改目标时长、顺序、权重偏置) | flow、shell |
| **draft** | J-06 业主真机三步验证 11.4(零代码,**先做**);J-12 `golden_key_sets` 白名单扩展;J-01 章节 → 11.3.0 `materials.time_marks`;J-02 字幕 → 字幕轨(`materials.texts`),时间码逐条与 SRT 一致;J-03 选项 B「按节拍建议重排」按钮(整批可撤销,不写死切点);U-07 键位表加「与剪映的差别」列(S/⇧L/Tab/↑↓ 四行标注,补 ⌘N/M/Home/End/⌫) | J-06 结果;若 11.4 无法验证,J-01/J-02 只对 11.3.0 金样出货并在交付页标「仅 11.3」 |
| **perf** | E-01 whisper `-t min(P,8)`(收益 <15% 保留 `-t 4`,检测器先红);E-06 A18-01 取证方案(先排除资源竞争;构造 27×4 重排 profile 夹具;`lldb` 全线程栈);E-07 300 段镜头带量测(数字即验收,疼才做虚拟化);P-06 模型一键到位(首启/设置按内存档提示「装画面理解 ≈2.4 GB / 转写模型」→ 后台下载到 `models/`,进度在状态条,SHA 校验,可取消,失败可重试;装完 `interest` 参与打分、去重按向量;E-09 首次把 CLIP/whisper 耗时补进基线);E-10 8 GB 注入回归表(可选);E-08 快照占用前端接线核实;P-10/U-04 导入即有地图(入库 → 日期分组占位卡 ≤3 s,分析后台;Dock 进度真机验) | bench 基线 |
| **tokens** | V-09 旧 `--font-*` 三文件清零(`workspace.css`/`PlayerOverlay.css`/车道文件),`styles.css` 只做首页/抽屉 ~80 处;V-12 深色全剧本走查 + 36 张 @2x 入库为基线(git lfs)+ `preview-diff.mjs` pixelmatch ≤0.5%;主题两套(`jianying-dark` 升格为唯一 `dark`,旧 `dark` 用户自动映射);浅色下井/带/状态条深底 | shell、Q-3/Q-4 拍板 |

R20 候选(本轮不做,记录):P-07 MCP 暴露三件事(只读 + 导出)、J-09 FCPXML、方案 C、公开仓 CI。

## 5. 风险控制

- 每车道独立 worktree、独立文件;公共文件只追加;CSS `@import` 在 `workspace.css` 头部;冻结 AX 名(`aria.yml`)一个不改——改布局不改语义。
- shell 车道动栏根节点,其它车道只碰栏内部;`react-resizable-panels` 锁 4.12.3(4.12.4 折叠侧栏抛错)。
- 检测器先红后绿:单主按钮断言、术语首轮词表、前 5 分钟脚本、bench 阈值、截图 diff 都要对 0.9.1 先跑出真实结果。
- 「显示全部功能」关时被藏的功能全部要有 vitest 证明「开关打开后原样回来」(不是删)。
- 不动 `player/mod.rs`;不碰业主 profile 与剪映草稿目录;A18-01 只取证不盲修。
- 发布:Wave 1 合入 → 0.10.0-preview 真机验收 → 0.10.0 → 同步公开仓;Wave 2 → 0.10.1。

## 6. 验收(真机 + 脚本,15 分钟)

| 项 | 判据 |
|---|---|
| 前 5 分钟 | `first-five-minutes.mjs`:隔离 profile、27 条夹具、业主本机(M5):点击 ≤ 6、可见新词 ≤ 6、启动到导出文件 ≤ 60 s(含分析);对 0.9.1 先跑出 9–10 次点击 / ≥12 词的基线;8 GB 注入档只要求不比 0.9.1 慢 |
| 一屏一颗主按钮 | 任一剧本步骤 `.ui-button--primary:not([hidden])` ≤ 1;`preview-shots` 36 张全过 |
| 壳 | 1440 下 `region "镜头带"` `clientWidth ≥ 1380`;顶部到池标题条 = 44 px;检查器开合前后中栏宽度相等;1280/1366/1512/1920 四档截图 |
| 首屏噪音 | 1440×900 可交互控件 ≤ 45(现 84);「显示全部功能」关时 AX 交互节点比 0.9.1 少 ≥ 30%,开时五个附属 tab 全在 |
| 首页/教学 | 首页 DOM 不含 镜头带/章节/精选段/交付/模板/旅程;任意信号组合 `[data-teach]` ≤ 1 |
| 分析中 | 点主按钮 0 次出现「画面分析还没跑完」;文案含「x/N」 |
| 交付 | 导出首屏恰好三卡;未核对剪映版本机器:点「交给剪映」一次即出 `01_章节/…` + `顺序.txt` + 同名 SRT,无选择对话框;完成 toast 直达目录 |
| 性能门禁 | `bench/baseline/main-<sha>.json` 入库;故意改回旧 `decode_permits` 能让 `check-bench` 红;启动两段时间戳可见;体积门禁通过 |
| 视觉 | 深色剧本 0 console error;`--font-` 三文件命中 0;`!important` 基线 = 1;`animation` 全引 `--motion-*` |

## 7. 开放问题(需业主拍板;标 ★ 的不拍板车道就按「建议」走)

| # | 问题 | 选项 | 建议 |
|---|---|---|---|
| Q-1 | 签名/公证 | — | **已拍板:不做**(个人使用为主) |
| Q-2 ★ | 检查器默认 | a 滑出(Esc 收、📌 钉住);b 钉住三栏;c ≥1920 钉住 | a |
| Q-3 ★ | 主题收两套,`jianying-dark` 升格为唯一深色 | a 是;b 三套都留 | a |
| Q-4 ★ | 浅色下井与镜头带用深底 | a 是(NLE 惯例);b 否 | a |
| Q-5 ★ | 「集」还是「草稿」 | A 保留「集」,首页「新建一集」;B 对外叫「草稿」;C 首启卡说一次「一集 = 一个草稿」 | A + C |
| Q-6 | 导出首屏 | — | **已拍板:三卡**(交给剪映 / 导出视频 / 整包交付);「试验草稿 + 人工确认」进「更多方式 ⌄」 |
| Q-7 ★ | 模板卡 | A 撤;B 做实成三条预设句(Wave 2 P-09) | Wave 1 撤、Wave 2 做实 |
| Q-8 ★ | 云端补镜(MiniMax 3,387 行) | A 删;B 藏进「显示全部功能」;C 保留现状 | B |
| Q-9 ★ | 开关名字 | 「显示全部功能」/「专业模式」/「导演台」;放设置 › 关于 | 「显示全部功能」,顶栏不加 |
| Q-10 | CLIP/whisper 模型分发 | — | **已拍板:③ 首启按内存档引导后台下载**,进 R19 Wave 2(P-06) |
| Q-11 | 节拍对齐 | A 现状只参考;B 「按节拍建议重排」按钮可撤销;C 选模板即联动 | B(Wave 2 J-03) |
| Q-12 | 英文 NLE 交接 | A 不做;B 交付包英文平行版(mp4+CSV+SRT,零新码);C 最小 FCPXML | B,R19 不做 C |
| Q-13 ★ | 性能门禁头两周只报告不拦截 | A 是;B 直接拦截 | A |
| Q-14 | J-06:业主亲手在真机验 11.4 草稿三步 | — | **已拍板:业主来做**。截至 09-18 业主库 `settings` 里尚无 `jianying.human_check.*` 行,Wave 2 draft 车道开跑前提醒业主点一次「可以用」 |
| Q-15 | 公开仓补 GitHub Actions CI | A 做(跑 fast-gates 子集);B 不做 | A,R20 |
| Q-16 ★ | 前 5 分钟判据数字(点击 ≤6、新词 ≤6、≤90 s) | A 认可;B 改数;C 只记录 | A |
