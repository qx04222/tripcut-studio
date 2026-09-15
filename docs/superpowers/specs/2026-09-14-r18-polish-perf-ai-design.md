# R18 专业级打磨:设置 · 视觉 · 性能 · AI(0.9.0)

业主方向(2026-09-14 深夜):「作为专业的 Mac 软件工程师,结合 AI 做专业级桌面软件」——
① 设置/后台功能齐全易用;② 视觉更清新精致、图标更精致;③ 性能覆盖 M 系列 8–128 GB;④ AI 整体升级;⑤ 头脑风暴;⑥ 多 agent。
依据:五份只读头脑风暴 `.superpowers/sdd/r18/brainstorm-{settings,visual,perf,ai,holistic}.md`(全部带行号证据与真机实测)。
所有既有原则继续有效(新手开包即用、一条流水线、不藏功能、参考剪映不抄资源、AI 产物可解释可撤销)。

## 0. 本轮取舍

- **修「已经做了却用不了」优先于做新东西**:⌘Z 被原生 Edit 菜单吞掉(R16 撤销栈键盘不可达)、窗口跑到屏幕外、AI 描述从没看过画面、CLIP 向量算完没人读——这四条是本轮第一梯队。
- **门禁先于美化**:视觉车道先扩样式门禁(43 个车道 CSS 不在门禁里)、先写图标几何门禁,再动笔;AI 车道先把评测语料入库再改任何打分。
- **签名/公证仍不做**(业主规则),只写清单;不换 Sparkle、不做 App Sandbox、不做多窗口、不做托盘/登录项。
- 迁移号预分配:AI-A 0045、AI-B 0046、AI-C 0047–0048、AI-E 0049;其它车道无迁移。

## 1. Wave 1(五条并行,文件不相交)

| 车道 | 内容 | 主要文件所有权 |
|---|---|---|
| **native** | M-01 中文原生菜单栏(应用/文件/编辑/显示/窗口/帮助,含「关于 / 偏好设置… ⌘, / 检查更新… / 退出」,编辑菜单撤销重做**转发到前端撤销栈**而不是被 AppKit 吞掉)+ ⌘Z 修复;M-02 窗口几何钳制(与可用屏幕无交集→居中)+ 全屏态不写回窗口尺寸;F2 关闭窗口时后台任务未完成的确认;M-07① `CFBundleDevelopmentRegion=zh-Hans` + `CFBundleLocalizations`;H-07 五条 `NS*UsageDescription` 中文 + 被拒后的「去系统设置」引导;M-09 `[profile.release]` strip + thin LTO(给前后 MB 数);H-23 去掉 `LSRequiresCarbon` | 新 `src-tauri/src/menu.rs`、`window_state.rs`;`lib.rs` 只加挂钩行;`tauri.conf.json`、`Info.plist`、`Cargo.toml [profile]`;前端 `src/workspace/menuBridge.ts`(新) |
| **settings** | F1 通知开关(交付完成 / 批量分析完成,默认开)+ 首次通知权限前置说明;F7 工具路径「恢复内置」;F8 后台任务「清空全部失败」;F5 「更改缓存位置…」(搬迁,失败兜底清空重建);F6 缓存自动清理(默认从不,15/30/60/90 天);M-04 「导出诊断包」(zip:版本/工具链/内存档/最近日志(脱敏,**断言匹配发生过**)/失败任务) + M-03 `tracing` 真落盘(`logs/` 7 天轮转) | `src/workspace/settings/*`(除视觉车道点名的样式)、`src-tauri/src/core/settings.rs`、`notify.rs`、新 `logging.rs`、`diagnostics*`、`ImportJobsTab.tsx` |
| **tokens**(V1) | 样式门禁扩到 `src/styles/workspace/`(字号/圆角/阴影/transition/z-index/`!important` 只降不升,先红后绿);补令牌 `--radius-2/4/pill`、`--text-28/40`、`--z-*`、`--motion-slow`、深色 `--ring` 内圈;修 12 处 px 字号、31 圆角、37 阴影、14 transition;**只新增令牌不改旧值**;`preview:shots` 加 2x 截图 | `src/styles/tokens.css`、`src/styles/tokens.test.ts`、`src/styles/workspace/*.css`(仅令牌引用替换)、`scripts/qa/preview-shots.mjs`(加 deviceScaleFactor) |
| **icons**(V2) | 图标规范写进 design-system(16 网格、活动区 12.5、描边 1.5、四分格、单一点径、实心/线稿规则、语义表);`icons.geometry.test.ts` 先对现状报红;按频次重画(第一批 `settings` 6 齿 / `grip` / `more` / `import` / `play` 实心 / `arrow-*` 镜像 / `info` `warning` 点 / `save` 去软盘),补 `tag` `similar` `takes` `slot` 四个语义正确的新图标并改 6 个调用点;`Icon` 按尺寸补偿描边;M-11 应用图标规格化(squircle、Apple 网格 824、分层导出,`icon.icns` 压缩) | `src/workspace/ui/icons.tsx`、`icons*.test.ts*`、`src/styles/kit/icon.css`、`src-tauri/icons/*`、`Inspector.tsx`/`InspectorSections.tsx`/`emptyStates.tsx` 的图标名(仅 name 属性) |
| **ai-ground**(AI-F1/F2 + AI-A) | 评测语料入库 `qa/ai-eval/`(manifest.tsv 加八维/OCR/口播/最佳窗真值、queries.tsv、SOURCES.md、quick_hash;视频不入库)+ `make-ai-fixtures.sh` 8 条语义可判合成片 + 基线报告;A-1 零云端本地描述 `clip_brief.rs`(八维 + OCR + 转写 + 时刻分 → 一句中文,8 GB 也有);A-2 云端描述 prompt 喂这些事实(检测器:subject=食物 断言 prompt 含「食物」,现在必红);迁移 0045 | `qa/ai-eval/`、`scripts/qa/make-ai-fixtures.sh`、`src-tauri/tests/ai_labels.rs`、新 `core/clip_brief.rs`、`core/llm.rs`、迁移 0045 |

## 2. Wave 2(Wave 1 合入后)

| 车道 | 内容 | 依赖 |
|---|---|---|
| **layout**(V3) | 顶栏减压(1280 折叠胶囊、同一时刻只许一颗实心主按钮的断言、更新就绪降级 ghost + 齿轮小圆点)、媒体池(去框外搜索钮、芯片一行、卡片定高、takes 角标、两档列宽)、监视器井充满 + toast 位置、镜头带工具条分组、设置 sheet 单一说明框/单一关闭、首页卡片语言统一、状态条分组;只写 `polish-r18.css` | tokens |
| **perf-tiers** | 按 `brainstorm-perf.md`:4 档(≤8/16/32–64/≥96 GB)× P/E 核 × 代际的并发/解码/模型/mpv 表;高配机解除保守限制;热点修复;每项前后数字 | — |
| **ai-score**(AI-B + AI-C) | 时刻分第六项 `interest`(CLIP,无 CLIP 权重 0)、`segments.reason_json NOT NULL`、自动挑选视觉去重 + 逐段撤销;帧级向量表 + 文本搜画面到秒 + 相似聚类;迁移 0046–0048 | ai-ground 基线 |
| **native-2** | M-06① 拖放扩到全窗口 + Dock 图标(`CFBundleDocumentTypes`)、Dock 进度、通知 action;M-12 三个 swift 探针进 `scripts/qa/native-audit`;M-10 iCloud dataless / 卷弹出处理 | native |
| **ai-draft**(AI-D/E) | 节拍对齐 + 字幕交接;「一键成片草案」可解释可逐条撤销;迁移 0049 | ai-score |

## 3. 风险控制

- 每车道独立 worktree、独立文件;公共文件只追加;CSS `@import` 在 `workspace.css` 头部。
- 检测器先红后绿;凡「更快/更精致」都要给数字或截图(2x)。
- 不动 `player/mod.rs`(除 R17 已加的 `command_for`);不碰业主 profile。
- 发布:Wave 1 合入 → 0.9.0-preview 真机验收 → 发 0.9.0;Wave 2 → 0.9.1。

## 4. 验收(真机,10 分钟)

菜单栏全中文、⌘Z 撤销一次批量评级出 toast;`window.x=5000` 重启后窗口居中;关闭窗口时有后台任务弹确认;设置 › 通知开关可关、「恢复内置」「清空全部失败」「更改缓存位置」可用;「导出诊断包」zip 不含绝对路径;顶栏齿轮 16 px 清晰、检查器标签/相似/Take/槽位图标各不相同;Dock 图标不再大一号;`tokens.test` 覆盖 43 文件全绿;AI 描述含八维/OCR/转写事实;`qa/ai-eval` 基线报告入库。
