# R9 设计系统 —— 令牌 / 组件套件 / 密度规则

> 依据：`docs/superpowers/specs/2026-09-12-r9-ui-productization-design.md` §1/§2/§6/§11。
> 源码：`src/styles/tokens.css`（令牌）、`src/workspace/ui/`（套件组件）、
> `src/styles/kit/`（套件样式，`src/styles/kit.css` 是 `@import` 桶）。
> 本文档只记「现在长什么样、怎么用」；R9 各任务与规格的出入见各车道报告
> `.superpowers/sdd/r9/task-*-report.md` 与 `docs/qa/2026-09-12-unattended-r9.md`。

## 1. 令牌（`src/styles/tokens.css`）

唯一的令牌文件，在 `src/main.tsx` 里先于 `styles.css` 引入（只定义变量，不含规则）。
表面色 / 语义色引用 `styles.css` 顶部既有的调色板（`--bg`、`--accent`、`--warning`、
`--danger`…），深色主题因此自动跟随 `prefers-color-scheme` 与 `html[data-theme]` 这两条
既有机制——`tokens.css` 只在文件末尾覆盖那些浅色时写死了字面量的几个令牌（表面、阴影、井底）。

`src/workspace/**`、`src/styles/workspace.css`、`src/styles/kit.css` 与 `src/styles/kit/*.css`
里**禁止**出现颜色字面量、`px` 字号、非六档间距——`src/styles/tokens.test.ts` 扫描这些文件，
命中 `#[0-9a-f]{3,6}` / `font-size:\s*\d+px` / 非六档 `padding|margin|gap` 一律判红。套件的
门禁从 Task 1 起就是开着的；`workspace.css` 这组在 Task 8a 的死规则清理里打开（详见 QA 报告）。

| 组 | 令牌 | 值（浅色） | 说明 |
|---|---|---|---|
| 字号 / 行高 | `--text-11/12/13/15/20` / `--lh-11/12/13/15/20` | 11/12/13/15/20 px / 14/16/18/20/26 px | 五级，一一配对 |
| 间距 | `--space-1`…`--space-6` | 4/8/12/16/24/32 px | 只允许这六档 |
| 表面 | `--surface-ground` `--surface-panel` `--surface-card` `--surface-raised` | `var(--bg)` / `var(--bg-elevated)` / `#fff` / `#fff` | 四级：壳底 → 栏面板 → 卡片 → 浮层 |
| 铬条 | `--surface-chrome` `--surface-chrome-2` | `#f0eee7` / `#e9e7df` | A 稿「编辑台密度」的铬条色，比面板暗半档；令牌表之外的追加项（规格没列，但 A 稿要用） |
| 井底 | `--well-bg` | `#1d1b18` | 监视器唯一允许的深色，深色主题下换成 `--media-well` |
| 阴影 | `--shadow-card` `--shadow-raised` `--shadow-inset-well` | 见源码注释 | 三级；深色下 `card` 阴影换成 `0 0 0 1px var(--border)` |
| 圆角 | `--radius-6` `--radius-10` | 6 / 10 px | 控件 6，卡片 / 井 / 抽屉 10 |
| 边框 | `--border-hair` `--border-strong` `--border-focus` | 引用既有调色板 | |
| 强调 | `--accent-ink` `--accent-text` | `var(--accent-contrast)` / `color-mix(...)` | `-ink` 压强调底，`-text` 压 tint 底 |
| 语义 | `--ok/-tint` `--warn/-tint` `--danger/-tint` `--info/-tint` | ok = accent；info = 次级文字 | |
| 焦点 / 选中 | `--ring` `--ring-selected` | 双圈 / 单圈强调 | `:focus-visible` 与选中态各一套 |
| 动效 | `--motion-fast` | `150ms cubic-bezier(.2,.7,.2,1)` | 唯一允许的 transition 时长；§0 明令不做别的动画 |
| 控件 | `--control-sm/md/lg` | 24 / 28 / 30 px | `lg` 是顶栏主按钮，规格之外的追加档 |
| 等宽 | `--font-mono` | SF Mono / JetBrains Mono / ui-monospace / Menlo | 时码、文件名、`Kbd` |

深色只保证「不刺眼、不反色」，不做视觉走查（规格 §0 明确不做深色遍历）；R10 用
`preview-shots --dark` 补一轮走查。

## 2. 组件套件（`src/workspace/ui/`）

16 个组件文件（每个 < 200 行）+ 14 份 vitest（`*.test.tsx`）+ `KitPreview.tsx` 里各一个
示例块；统一从 `src/workspace/ui/index.ts` 导出。全部只消费令牌，`className` 可透传，
交互元素的 `ref` 用 React 19 的 props ref。

| 组件 | 文件 | Props 摘要 | 行为 / 视觉 |
|---|---|---|---|
| `Icon` | `icons.tsx` | `name: IconName`，`size?: 12\|16\|20\|32`，`filled?`，`className?` | `<svg viewBox="0 0 16 16">`，1.5px 描边、`currentColor`、`aria-hidden`；`filled` 只对 `star`/`heart` 生效 |
| `Button` | `Button.tsx` | `variant?: primary\|secondary\|ghost\|icon`（默认 secondary），`size?: sm\|md`，`icon?`，`busy?`，`tone?: neutral\|danger` + `<button>` 全部透传 | `icon` 变体没有 `aria-label` 会抛错；`busy` → `aria-busy` + disabled |
| `Chip` | `Chip.tsx` | `selected?`，`count?`，`tone?: neutral\|accent\|warn\|danger`，`icon?`，`onClick?` | 有 `onClick` 渲染 `<button aria-pressed>`，否则 `<span>` |
| `Badge` | `Badge.tsx` | `tone?: neutral\|accent\|warn\|danger\|ink`，`icon?` | 18px 角标；`ink` 用于压在封面缩略图上 |
| `Card` | `Card.tsx` | `level?: card\|raised`，`interactive?`，`selected?`，`padding?: 3\|4`，`as?: div\|button\|article\|section\|li`，`disabled?` | `as="button"` 自动 `type="button"`，`selected` 时加 `aria-pressed` |
| `SectionHeader` | `SectionHeader.tsx` | `title`，`meta?`，`actions?`，`size?: pane\|section`（默认 section），`description?` | `section` = `<h3>` 15px；`pane` = `<div>` 13px，32px 铬条 |
| `Field` | `Field.tsx` | `label`，`help?`，`htmlFor?`，`inline?`（默认 true） | 有 `htmlFor` → `<label>`，否则 `<span>`；`help` 贴控件下方 |
| `Toggle` | `Toggle.tsx` | `checked`，`onChange(next)`，`label`（即 AX 名），`disabled?`，`id?` | `<button role="switch" aria-checked>` 32×18 |
| `Select` | `Select.tsx` | 原生 `<select>` 全部 props（含 ref） | 外套 `chevron-down` 覆层，`className` 落外层容器 |
| `Tabs` | `Tabs.tsx` | `items: {id,label,count?}[]`，`value`，`onChange(id)`，`ariaLabel` | `role="tablist"/"tab" aria-selected`；← → Home End roving + 自动激活；`count` 对 AX 隐藏 |
| `Drawer` | `Drawer.tsx` | `open`，`title`，`side: left\|right`，`width`，`onClose`，`actions?`，`children` | 经内部 `ModalSurface`：模态栈、`useFocusTrap`、Esc 只在栈顶响应、遮罩 `mousedown` 关闭、可见「关闭」按钮 |
| `Sheet` | `Sheet.tsx` | `open`，`title`，`width?`（默认 960px），`height?`（默认 80vh），`onClose`，`actions?` | 居中，与 `Drawer` 共用 `ModalSurface` |
| `EmptyState` | `EmptyState.tsx` | `icon`，`title`，`body?`，`action?`，`size?: pane\|inline`，`tone?: light\|dark` | 标题用 `<p>`，不是 heading（栏 landmark 已有名字） |
| `Toolbar` | `Toolbar.tsx` | `children`，`ariaLabel?`，`dense?`；`Toolbar.Divider` | `role="toolbar"` 当且仅当传了 `ariaLabel` |
| `Kbd` | `Kbd.tsx` | `children` | 11px 等宽键帽，卡面底 + 发丝边 |

`ModalSurface`（内部，不对外导出）承担 `Drawer`/`Sheet` 共同的模态行为，打开时
`containerRef.focus()`。

### 图标集（34 个，命名冻结）

规格 §2 原定「24 + 9 = 33」，实际按对（`volume`/`volume-off` 是两个独立名字）算出 34：
`import deliver settings search play pause prev next volume volume-off fullscreen
mark-in mark-out save star heart x check chevron-down chevron-right grip plus close
info warning`（25 个基础图标）+ `settings-appearance settings-performance
settings-timeline settings-tools settings-analysis settings-generation settings-privacy
settings-about settings-cache`（9 个设置分区图标）。`ICON_NAMES.length === 34` 由
`icons.test.tsx` 钉住。

### 怎么加一个组件（四步）

1. 在 `src/workspace/ui/` 新建 `<Name>.tsx`（< 200 行），只用 `tokens.css` 里已有的令牌——
   缺令牌就先去 `tokens.css` 加一条，不在组件里写字面量。
2. 在 `src/styles/kit/<name>.css` 写样式，`src/styles/kit.css` 加一行 `@import`（桶文件，
   `@import` 必须在文件顶部——文件尾的 `@import` 会被 `postcss-import` 静默丢弃，产物里
   一条规则都不会有，这是 R9 六条车道全部踩过的坑，见下节）。
3. 在 `src/workspace/ui/index.ts` 导出组件与它的 Props 类型；在 `<Name>.test.tsx` 写渲染 +
   variant class + AX 角色 + 禁用态的用例。
4. 在 `KitPreview.tsx`（`kit.html` 的挂载页）加一个示例块（每个 variant × 状态，含
   `data-hover` 模拟态、focus 态、禁用态），跑 `npm run preview:kit` 用 Read 工具看
   `10-kit.png`。

## 3. 密度规则（规格 §6/§11）

| 位置 | 高度 |
|---|---|
| 顶栏 | 44 px |
| 栏标题条（`PaneHead`/`SectionHeader size="pane"`） | 32 px（规格文字写 36，A 稿与套件 `--pane` 实际是 32，以套件为准） |
| 状态条 | 28 px |
| 控件（小 / 中 / 大） | 24 / 28 / 30 px（顶栏主按钮用 30） |
| 分隔条 | 6 px 可见抓手，hover / 拖动中变强调色 |
| 媒体池行高 | 146 px（三行文件名 36 + 元信息 + 分析角标行；规格草案的 136 在实现中改为 146） |
| 镜头带瓦片 | 160×130 px |
| 镜头带视口高（story / 其它） | 184 / 284 px（`shotBandModel.bandMinHeight`），加栏标题条 32、音乐再加刻度轨 36 → 216 / 316 / 352（`bandPanelMinHeight`） |
| 检查器头部缩略图 | 64×36 px；Take 缩略图 96×54 px |
| 抽屉 / sheet 标题栏 | 52 px（20px 标题 + actions + 关闭） |
| 抽屉宽度 | `min(720px, 60vw)`；设置 sheet 960×80vh |

## 4. 每车道一个 CSS 文件 + `@import` 顶部纪律

`src/styles/workspace.css` 是 R8 遗留的大文件（当前 1667 行，10 个分节），R9 不重写它，
新样式各自落一个文件，`workspace.css` 只加一行 `@import`：

```
src/styles/workspace/
  chrome.css              — 顶栏 / 栏标题条 / 分隔条 / 状态条(Task 2)
  pool-monitor.css        — @import 桶(pool.css / monitor.css, Task 3)
  band-inspector.css      — @import 桶(band.css / inspector.css, Task 4)
  import-drawer.css       — 导入抽屉(+ import-drawer-sources.css, Task 5)
  deliver-drawer.css      — 交付抽屉(Task 6)
  settings-sheet.css      — 设置 sheet(Task 7)
  band-accessory.css      — @import 桶(band-accessory-music.css / -panels.css, Task 8a)

src/styles/kit/           — 套件样式,14 个文件, src/styles/kit.css 是 @import 桶
```

**`@import` 必须写在 `workspace.css` 顶部（首条规则之前），不能写在文件尾。** 这是六条
车道（Task 2/3/4/5/6/7）各自独立踩到又各自独立修复的同一个坑：CSS 规定 `@import` 只能出现
在其它规则之前，`vite build` 对写在文件尾的 `@import` 只报一句
`@import statements must precede all other statements` 的 warning，**不报错**，产物 CSS 里
那条 `@import` 会被 `postcss-import` 静默丢弃——整个车道的样式一条规则都不会进 bundle，
`vitest`/`jsdom` 因为不跑 CSS，看不出这个问题，只有 `grep <某个类名> dist/assets/*.css`
或真机截图能发现。挂在顶部的代价是新样式的选择器都输给 `workspace.css` 旧分节的声明顺序，
所以每条车道都在自己的选择器上加了外层前缀（如 `.workspace-shell .shot-band`）抬一级
特异性来压过旧规则，旧规则本身留给死规则清理去删。**以后新开一条车道，`@import` 一律加在
`workspace.css` 顶部；如果要在 `styles/kit.css` 或任何桶文件里加 `@import`，同样必须在
文件顶部。**

## 5. 预览与截图装置

```bash
npm run preview:workspace   # vite --mode mock --port 1421,先跑 make-mock-covers.mjs 补假封面
npm run preview:shots       # 无头 Playwright 走一遍工作区剧本,截 00-09 共 10 张 PNG + aria.yml
npm run preview:kit         # preview-shots.mjs --kit-only,只截套件预览页(kit.html)
```

`preview:shots` 的截图落在调用者指定的目录（各任务报告约定放
`.superpowers/sdd/r9-visual-audit/task-<N>/`）；`--kit`/`--kit-only` 额外产出
`10-kit.png`（整页）与 `11-kit-hover.png`（hover 模拟态）。`kit.html` 只在
`vite --mode mock` 下可访问，生产 `npm run build` 只打 `dist/index.html`，
`kit.html` 不进产物（`viteMock.test` 断言 `rolldownOptions.input` 未定义）。

## 6. AX 名冻结清单

R9 从头到尾**没有改**下列 AX 名（`src/workspace/axNames.test.tsx` 与
`scripts/qa/smoke-gui.mjs` 共同钉住，见 `docs/qa/2026-09-12-unattended-r9.md` §4）：

- 顶栏按钮（4）：`导入素材` `切换集` `流水线下一步`（R12 起，原 `生成交付包` 解冻迁移；可见文案随步变化） `设置`
- 流水线导航条（R12）：`nav` 名 `流水线`；四颗按钮 `第 1 步 导入` `第 2 步 挑选` `第 3 步 排列` `第 4 步 导出`（计数不进名字）
- landmark（5）：`媒体池` `预览监视器` `镜头带` `检查器` `后台状态`
- 附属带 tablist：`镜头带附属视图`，tab 名 `故事 音乐 旅程 地点卡 模板`
- 三个模态的冻结串（9 处）：
  - 导入抽屉标题 `导入素材`；分页 `来源` `任务` `缺失素材`；拖放覆盖层 `松开即导入`
    （平时不在树里）
  - 交付抽屉：`本次交付平台`、开关 `联系表.pdf`
  - 设置 sheet：左轨常驻 `隐私与诊断`、`云端补镜`
- 集切换：`重命名本集` `目标平台`

**新增的一处改名**（有意为之，记在这里免得被当成漏改）：缺失素材面板的按钮从旧壳的
`选择新位置` 改成 `重新定位`（`ImportMissingTab`，规格 §4.1 明确要求；旧壳
`MissingMediaPanel` 本体不受影响，仍叫旧名，等 R10 删旧壳时一起消失）。

## 7. R10 新组件

> 依据：`docs/superpowers/specs/2026-09-13-r10-usability-design.md`；各车道报告
> `.superpowers/sdd/r10/lane-*-report.md`；QA 报告 `docs/qa/2026-09-13-unattended-r10.md`。

| 组件 | 文件 | Props 摘要 | 行为 / 视觉 |
|---|---|---|---|
| `CoverImage` | `src/workspace/ui/CoverImage.tsx` | `src: string \| null \| undefined`，`fallback?`，`lazy?`，`crossOrigin?`，`className?` | 封面缩略图（源自 R9 D4，本轮首次进入套件文档）：`src` 为空或 `<img>` 加载失败时渲染 `--well-bg` 上的中性占位（胶片图标），绝不显示浏览器的坏图问号；失败记忆只跟着这一条 URL，换素材即重新给一次机会。池卡片、监视器井底 backdrop、Stack 候选条共用它。 |
| `MonitorSeekBar` | `src/workspace/MonitorSeekBar.tsx` | `status: PlayerStatus \| null`，`inPoint`，`outPoint`，`onSeek(seconds)` | 监视器传输条上的可拖 seek bar（U-09）。原生 `<input type="range">`，AX 角色天然是 `slider`（新 AX 名「播放位置」）；拖动中显示本地值，不被 80ms 状态轮询拉回；`seek_abs` 命令按 `SEEK_THROTTLE_MS=120` 节流，松手补发最终值；键盘/点击一次一发不节流。`isAtEnd()` 用 `END_EPSILON_SECONDS=0.2` 判定播放到尾，供 `Monitor.onPlayPause` 在尾帧时先 `seek_abs 0` 再 `play`。 |
| `PoolStackStrip`（导出名 `MediaPoolStackStrip.tsx`） | `src/workspace/MediaPoolStackStrip.tsx` | `stack: ShotStack`，`clipsById`，`activeClipId`，`onPick(member)`，`onClose()` | 媒体池 Stack 展开视图（U-02/U-26）：点卡片角标「n 条候选」或在卡片上按 `Tab` 展开，贴在网格**下方**，不塞进虚拟化网格（行高与 `aria-rowcount` 不受影响）。每条候选是 `Card interactive`（`CoverImage` 96×54 + `Take n · 文件名`），先露 `POOL_STACK_PREVIEW=6` 条，尾部「还有 n 条」展开全部。新 AX 名见下节。 |

## 8. R10 新增 AX 名（冻结名一个未动）

R9 §6 的冻结清单本轮未变；以下是 R10 五条车道 + 接线车道新增的控件（均为新控件用新名，不是给旧名改名）：

- **媒体池（车道 A）**：按钮「导入第一批素材」（空池大号入口，与顶栏冻结名「导入素材」是两颗不同控件，只在空池并存）；group「{scene_name} 的候选」；按钮「收起候选」「还有 n 条」；候选卡 button「Take n · {文件名}」；卡片 gridcell 新增 `aria-expanded`（仅 Stack 卡片）。
- **监视器（车道 C）**：slider「播放位置」（`MonitorSeekBar`；沉浸态 `PlayerOverlay` 的「播放进度」未动）。
- **检查器 / 镜头带（车道 D）**：按钮「从媒体池选择…」（空章与空槽位）；dialog「从媒体池选择」；按钮「加入 &lt;文件名&gt;」「关闭选择列表」「去媒体池」「去设置」；list「精选段列表」；按钮「复播精选段 n」「删除精选段 n」；按钮「添加标签」（原「添加」，断言已迁移）；按钮「加入当前章节」；按钮「已放好，刷新列表」；form「重命名本集」；group「画布方向」。
- **壳 / 抽屉 / 设置 / 恢复页（车道 E）**：交付抽屉主按钮改名为「开始生成」（替换抽屉内原「生成交付包」；顶栏「生成交付包」不变）；导入来源「添加素材文件夹」按钮忙态名变为「选择中…」/「扫描中…」；任务分页 list「流水线三阶段」；三个 progressbar「索引进度」「画质分析进度」「运镜分析进度」（原来只有一个「索引进度」）；恢复页新增一条 `status`（自检 notice）。
- **接线车道**：group「本次交付画布方向」，内 button「横版」「竖版」（`aria-pressed`）；group「Whisper 模型文件」，button「复制下载地址」「导入模型文件…」（忙态名「正在校验并导入…」，`aria-busy`）；集切换 popover 新增 button「新建集」、form「新建集」、textbox「新集标题」、button「创建」「取消」；检查器 AI 描述段新增 button「去设置」（仅未启用时）；状态条新增短语「音乐分析 n/m」（纯文本非控件）；技术检查「方向」新增值「方屏 · n°」；系统通知标题「旅剪已开始后台处理」（非 AX，记在这里便于冒烟识别）。

## 9. R11 新组件

> 依据：`docs/superpowers/specs/2026-09-13-r11-smart-select-design.md`§1–§5；各车道报告
> `.superpowers/sdd/r11/lane-{moments,player,export,simplify,fix}-report.md`；QA 报告
> `docs/qa/2026-09-13-unattended-r11.md`。R11 不碰 `player/mod.rs`，原片只读，零模型可用。

| 组件 | 文件 | Props 摘要 | 行为 / 视觉 |
|---|---|---|---|
| `MonitorHeatStrip` | `src/workspace/MonitorHeatStrip.tsx` | `moments: ClipMoment[]`，`suggestions: SegmentSuggestion[]`，`activeSuggestionIndex`，`durationSeconds` | 监视器 seek bar 下方的时刻分热力条（SVG，与轨道左缘对齐 ≤6px）：每个时刻分窗口按 `score` 渲染成一段高度不同的竖条（≤200 点，由 `heatPoints` 桶取最高分保证），当前建议段画成半透明高亮块盖在热力条上。新 AX 名 img「时刻热力」。无时刻分数据（老库未补齐）时整条不渲染，不报错。 |
| `BandAutoSelect` | `src/workspace/BandAutoSelect.tsx` | `episodeId`，`platformBudget?`，`onDone(outcome)` | 镜头带工具条「自动挑选精选段」弹出的小面板：三枚范围 chip（只看收藏 / 收藏 + 3 星以上 / 全部素材，默认「收藏 + 3 星以上」实际发送 `favorites_or_rated3` 并集语义）+ 一个预算数字输入（按当前集平台预算预填，拉不到时兜底 30 秒）+「开始挑选」主按钮。结果反馈是镜头带底部一行 toast「已挑选 n 段 · 共 m s · 覆盖 k 章 · 撤销」，撤销调 `undoAutoSelect(batch_id)`。首启引导卡的「挑选片段」按钮会广播 `tripcut:open-auto-select` 直接打开这个面板。 |
| `OnboardingCard`（`OnboardingCardView` / `MonitorIdle`） | `src/workspace/OnboardingCard.tsx`（逻辑在 `src/workspace/onboarding.ts`） | `visible`，`hasClips`，`onImport()`，`onAutoSelect()`，`onExport()`，`onClose()` | 替代旧「本机准备」工具链模态的首启三步引导：整个素材库为空且 `onboarding.steps_seen=false` 且本次未关闭时，在监视器空闲态显示一张卡片「1 导入素材 → 2 挑选片段 → 3 导出」，只有第一步是 primary，第 2/3 步在库为空时禁用（`title="先导入素材"`）。库一有素材或点右上角关闭都会写 `steps_seen=true`，下次启动不再出现。新 AX 名 group「三步上手」，button「选择素材文件夹」「自动挑选」「导出片段」「关闭引导」。 |
| `ui/Menu` | `src/workspace/ui/Menu.tsx` | `trigger`，`items: {label, onSelect, disabled?}[]`，`ariaLabel` | 套件新增的最小右键/下拉菜单组件（R11 前套件里没有菜单原语），供媒体池右键「导出所选…」使用；`role="menu"`/`menuitem"`，Esc 关闭，点击外部关闭。 |
| 交付抽屉「快速导出」模式 | `src/workspace/DeliverDrawer.tsx` + `DeliverContents.tsx` | 顶部 `role=group「导出方式」` 两枚 chip「快速导出」（默认）/「完整交付包」 | 快速模式正文只有一句引导 + 清单卡（段数/收藏数/总时长 + 文件名列表 + 文件夹名），页脚「关闭」/「更改文件夹…」（ghost）/ 主按钮「导出」（AX 名「导出到上次文件夹」）；首次或目录不可用时弹一次文件夹面板并写 `ui.export.last_dir`。完成后卡片内 toast「已导出 n 个文件」+「在 Finder 中显示」。任务进行中两枚 chip 禁用，换模式不丢已排队任务。 |

## 10. R11 新增 AX 名（冻结名一个未动）

R9 §6、R10 §8 的冻结清单本轮未变；以下是 R11 三条功能车道（B 时刻分无界面、C 播放器/媒体池、E 一键导出）+ 简化专项车道 + 修复车道新增的控件（均为新控件用新名）：

- **监视器（车道 C）**：img「时刻热力」；button「上一条建议」「下一条建议」；`data-testid="monitor-suggestion"`；「播放速度」原为禁用占位按钮，本轮起可点（=按 `L`），AX 名未变。
- **镜头带（车道 C）**：button「自动挑选精选段」（`aria-expanded`）；group「自动挑选精选段」内 group「挑选范围」（chips「只看收藏」「收藏 + 3 星以上」「全部素材」）、label「总时长约 … 秒（按发布平台预填）」、button「开始挑选」。
- **设置 → 外观（车道 C）**：switch「选中素材从最精彩处开播」「播完自动播下一条」。
- **媒体池（车道 C）**：`.pool-card-bolt`（aria-hidden，title「有建议段」，即闪电角标）、`.pool-card-scrub`（`data-testid="pool-card-scrub"`，悬停刮擦条）。
- **交付抽屉 / 检查器 / 媒体池（车道 E）**：chip「快速导出」「完整交付包」（`aria-pressed`，group「导出方式」）；button「导出到上次文件夹」（可见「导出」/「导出…」）、「更改文件夹」（可见「更改文件夹…」）、「导出所选」（检查器精选段区按钮 + 媒体池右键 menuitem，可见「导出所选…」/「导出所选（n 条）…」）、「在 Finder 中显示」；list「将导出的文件」；section「快速导出」；menu「素材操作」（`ui/Menu` 右键菜单）。
- **首启引导（简化专项 → R12 四步卡）**：group「四步上手」；button「开始使用」「关闭引导」（R12 起，原「三步上手」与「选择素材文件夹」「自动挑选」「导出片段」释放）。
- **工具链横幅（R12）**：region「视频处理组件缺失」；button「去安装」「关闭提示」。新壳不再有「先把本地工具链接好」dialog。
- **设置页三分区（简化专项）**：tab「常用」「工具与模型」「关于」（九个旧分区 id 原样保留，见车道报告搬迁表）；button「云端补镜」「隐私与诊断」（左轨「直达」按钮，取代原 tab）；button「更改…」/「选择…」（导出文件夹，常用段新增一行）；button「更多信息」（检查器折叠段，`aria-expanded`）；button「打开导入」「回到按章节」（镜头带空态）、「去添加文件夹」（导入任务空态）；switch「启用增强分析」（原「启用 L3 增强」）、「自动生成轻量预览文件」（原「自动生成 540p 代理」）；combobox「后台并行任务数」（原「worker 并发」）；text「安装检查」「全部就绪」。
- **修复车道**：button「回到当前集」（媒体池只读查看横幅内，`role=status` 的 `.workspace-pool-scope` 里，N-2 修复新增）；帮助页「媒体池」组空格条目的 keys 改为 `Space, K`（旧 id `immersive-player` 不变，V-05 修复把 `K` 接入 `toggle-playback`）。

**术语清扫（简化专项，改名而非新增，记在这里免得被当成漏改）**：可见文案里 remux/L1/L3/Stack/VFR/PTS/tick/worker 等内部术语已替换为白话（完整清单见 `.superpowers/sdd/r11/lane-simplify-report.md` §3），新增门禁 `src/workspace/terminology.test.ts` 扫描回归；AX 名同步迁移的包括「启用 L3 增强」→「启用增强分析」、「Take n」可见文字→「第 n 条」（`aria-label="Take n · 文件名"` 本身按 R10 冻结未动，留给 R12）、「只看 Stack 首选」→「只看每组首选」。

## 11. R12 术语 v2 —— 冻结 AX 名改名表（车道 C）

> 依据：`docs/superpowers/specs/2026-09-14-r12-pipeline-design.md` §4；车道报告 `.superpowers/sdd/r12/lane-terms-report.md`。
> 本轮是 R9 §6 冻结以来**第一次给冻结名改名**：所有新名从 `src/workspace/copy.ts` 导出，`axNames.test.tsx` 钉住常量值，`terminology.test.ts` 禁旧词回流。§6 / §8 / §10 里出现的旧名以本表为准。

| 旧名 | 新名 | 类型 / 位置 | 常量 |
| --- | --- | --- | --- |
| `Take n · 文件名` | `第 n 条 · 文件名` | button（池内候选条 `MediaPoolStackStrip`） | `takeLabel(n, name)` |
| `{scene_name} 的候选` | `同一镜头 · {scene_name}` | group（池内候选条、镜头带 `BandTakeStrip`、检查器 `TakeSwitcher`） | `stackGroupLabel(scene)` |
| `n 条候选` | `同一镜头 n 条` | 池卡片角标（`PoolCard`，可点） | `stackCountLabel(n)` |
| `收起候选` | `收起同一镜头` | button（池内候选条） | — |
| `八维评分` | `画面评分` | 检查器折叠段 summary | `INSPECTOR_TITLES.dimensions` |
| `音轨与 LUT` | `声音与调色` | 检查器折叠段 summary | `INSPECTOR_TITLES.audio` |
| `八维筛选` | `画面筛选` | combobox（媒体池「更多筛选」） | `DIMENSION_FILTER_LABEL` |
| `选择显示 LUT` / `显示 LUT` / `添加 LUT…` | `选择预览调色` / `预览调色` / `添加调色文件…` | combobox 与 option（`TechCheckPanel`） | — |
| `画布方向` | `画面方向` | group（集表单 `EpisodeForms`） | `ORIENTATION_LABEL` |
| `本次交付画布方向` | `本次交付画面方向` | group（交付抽屉 `DeliverForm`） | `DELIVER_ORIENTATION_LABEL` |
| `画布 W×H`（交付抽屉副标题） | `竖版 W×H` / `横版 W×H` | text（`canvasLabel`） | — |
| `索引进度` / `索引` | `导入进度` / `登记` | section 与 progressbar（导入抽屉「任务」分页；progressbar 名随段名成「登记进度」） | `IMPORT_PROGRESS_LABEL` |
| `Whisper 模型档位` / `Whisper 模型文件` | `转写模型` / `转写模型文件` | combobox / group（设置 → 工具链） | — |
| `FFmpeg 路径` / `FFprobe 路径` / `whisper-cli 路径` | `视频处理组件的位置` / `媒体信息组件的位置` / `转写组件的位置` | textbox（设置 → 工具链；读数标题同步为「视频处理组件 已就绪」，路径与版本号收进 `details`「详情」） | — |
| `MiniMax API Key` / `默认模型` | `MiniMax 密钥` / `生成模型` | textbox / combobox（设置 → 云端补镜） | — |
| `后台并行任务数` / `自动生成轻量预览文件` | `后台同时处理几条` / `预览用小文件` | combobox / switch（设置 → 性能） | — |
| `可选：提供已校验的 Whisper 模型` / `初始化本地 Chinese-CLIP 环境` | `转写(可选)` / `画面识别(可选)` | 首启弹窗与「安装检查」卡的步骤标题（`toolchainSteps`） | `OPTIONAL_TRANSCRIBE_TITLE` / `OPTIONAL_VISION_TITLE` |
| `生成交付包`（交付抽屉标题） | `导出` | dialog（`DeliverDrawer`；命令面板项同步为「打开导出」）— R12 验收 X-05 解冻 | `DELIVER_DRAWER_TITLE` |
| `n 条整条收藏` | `n 条收藏的整条视频` | text（交付抽屉汇总行 / 内容清单 / 快速导出面板）— X-05 | — |
| `第n段·hh:mm-hh:mm`（自动章节默认名） | `第 n 章 · hh:mm-hh:mm` | 镜头带章标题（Rust `core::story` 生成）— X-05 | — |
| `上移` / `下移`（镜头带镜块） | `往前` / `往后` | button（`BandSegment`，图标同步改 `arrow-left`/`arrow-right`）— R12 验收 X-03 | — |
| `生成交付包`（顶栏主按钮，旧冻结名） | `流水线下一步`（AX 名固定；可见文案随步骤变化） | button（顶栏，`PipelineRail` 车道 A）— 解冻迁移 | — |

## 12. R12 新组件（车道 A/B/D）

> 依据：`docs/superpowers/specs/2026-09-14-r12-pipeline-design.md` §1–§6；车道报告
> `.superpowers/sdd/r12/lane-shell-report.md`、`lane-player-report.md`、`lane-fix2-report.md`（车道 B/C 报告未入库，
> 相关组件由合并提交 `cb98969`/`b14541e` 的 diff 复原，详见 `docs/qa/2026-09-14-unattended-r12-r13.md` §2）。

| 组件 | 文件 | Props 摘要 | 行为 / 视觉 |
|---|---|---|---|
| `PipelineRail` | `src/workspace/PipelineRail.tsx` | `step: PipelineStep`，`stepCounts`，`onStepClick(step)` | 顶栏中央集切换器右侧四步导航：`nav「流水线」`，四颗 `button「第 n 步 导入/挑选/排列/导出」`（计数不进 AX 名），`aria-current="step"` 标记当前步，完成打勾，1280px 以下只留数字与勾。点击调 `pipelineActions.focusPipelineStep`（导入抽屉 / 聚焦媒体池 / 聚焦镜头带 / 导出抽屉）。数据来自 `usePipeline.ts`（`pipelineModel.ts` 纯函数 `derivePipeline`），与首启四步卡、空态提示同一份推导。 |
| `PipelineHint` | `src/workspace/PipelineHint.tsx` | `step`，`seen: boolean`，`onDismiss()` | 导航条下方每步首次进入时出现的一条可关提示（`status「第 n 步提示」` + `button「知道了」`），写 `pipeline.hint_seen.n`（Rust `ONBOARDING_FLAG_KEYS` 白名单）。 |
| `ToolchainBanner` | `src/workspace/ToolchainBanner.tsx` | `requiredToolsMissing: boolean`，`onInstall()`，`onDismiss()` | 替代旧「本机准备」工具链模态：只在 ffmpeg/ffprobe 缺失时顶栏下出现一条非模态横幅（`region「视频处理组件缺失」` + `button「去安装」「关闭提示」`），关闭只对本次启动生效。 |
| `Toast` / `toastStore` | `src/workspace/ui/Toast.tsx`、`src/workspace/ui/toastStore.ts` | `message`，`tone: "status"\|"danger"`，`action?: {label, onClick}`，`durationMs`（3–5 s） | 套件新增的顶部居中提示条，最多同时 1 条，`role=status`（danger 时 `role=alert`）；自动挑选结果、撤销、拖排、忽略缺口、排入完成、导出完成/失败全部改走它，替代镜头带底部原来的小字提示。 |
| `arrangeSelectedSegments` / `undoArrange` / `skipChapter`（`useBandArrange.ts`） | `src/workspace/useBandArrange.ts` + Rust `core::arrange.rs` | — | 「一键排入」把本集精选段按章节（有章按章、无章按拍摄时间）排成 `story_order`，只写既有列、可撤销；「这章够了」把 0 镜章标记跳过，不算缺口。自动挑选完成后默认已排入。 |
| `MonitorControls` 「连播」开关 | `src/workspace/MonitorControls.tsx` | `autoAdvance: boolean`，`onToggle()` | 工具条 Spacer 之后、全屏之前，`switch「连播」`（新名），写 `ui.player.auto_advance`，**默认改为 false**（R11 默认是自动播完接力，本轮改为需要显式打开）。 |
| 「播放速度」菜单 | `src/workspace/MonitorControls.tsx` + `ui/Menu` | — | 点「×1」按钮弹 `menu「播放速度」`，`menuitem「速度 ×0.5」「速度 ×1」「速度 ×2」「速度 ×4」`（新名），选中即调原生 `player_set_speed`；按钮加 `aria-haspopup="menu"`/`aria-expanded`。 |

### R12 新增 AX 名（冻结名一个未动，术语改名见 §11）

- **壳 / 导航（车道 A）**：nav「流水线」；button「第 1 步 导入」「第 2 步 挑选」「第 3 步 排列」「第 4 步 导出」；固定 AX 名「流水线下一步」（顶栏主按钮，文案随步骤变化）；group「四步上手」+ button「开始使用」（替代 R11 的「三步上手」/「选择素材文件夹」等三名，已释放）；dialog「流水线手册」（`HelpOverlay` 标题，`aria-labelledby` 未动）；region「视频处理组件缺失」+ button「去安装」「关闭提示」；status「第 n 步提示」+ button「知道了」。
- **导出抽屉（车道 A）**：chip「导出片段」（替代 R11「快速导出」，锚点已迁）、「完整交付包」、「剪映草稿」（不可用时可见文案带「(待验证)」+ `role=status` 一句白话）；checkbox「出一份联系表 PDF…」「出一份镜头表(表格)」；button「只重试失败的」。
- **镜头带（车道 B）**：button「一键排入」（primary，可撤销）、「去自动挑选」（空态主动作）、「这章够了」；text「片段 a–b s」（镜块小标）；button「往前」「往后」（见 §11 改名表，X-03 常显修复）。
- **反馈系统（车道 B）**：`Toast` 的 `role=status`/`role=alert`，无固定文案 AX 名（每条消息即时生成）。
- **播放器 / 变速（车道 D）**：switch「连播」；menu「播放速度」+ menuitem「速度 ×0.5/×1/×2/×4」；button「播放速度」（名未变，新增 `aria-haspopup`/`aria-expanded`，可见文案多了「×0.5」「倒退」两种状态尾缀）。
- **修复车道**：dialog「导出」（原「生成交付包」，X-05 解冻，`DELIVER_DRAWER_TITLE`，命令面板项同步「打开导出」）。

## 13. R13 新组件与新增 AX 名（车道 A/B/C）

> 依据：`docs/superpowers/specs/2026-09-14-r13-jianying-alignment-design.md` §1–§5；车道报告
> `.superpowers/sdd/r13/lane-guides-report.md`、`lane-timeline-report.md`（车道 A 报告未入库，
> 由合并提交 `5c33622` 的 diff 复原）。

| 组件 | 文件 | Props 摘要 | 行为 / 视觉 |
|---|---|---|---|
| `keymap.ts` / `keymapStore.ts` | `src/workspace/keymap.ts`、`src/workspace/keymapStore.ts` | 动作枚举 → 键位表，三套预设 JSON（剪映/Premiere Pro/Final Cut Pro）+ 自定义覆盖 | `useGlobalHotkeys`/`useMonitorHotkeys`/`useRatingHotkeys` 改为查表而非硬编码；**默认预设改为剪映键位**（空格播放、I/O 入出点、← → 逐帧、⇧← → 前后 5 s、J/K/L、⌘Z/⇧⌘Z 撤销重做、⌘E 导出、F 收藏、X 拒绝、1–5 打星、Enter 采用建议、N/⇧N 建议切换）；设置键 `keymap.preset` + `keymap.custom`（白名单）。 |
| `KeymapSection` | `src/workspace/settings/KeymapSection.tsx` | — | 设置 →「快捷键」分区：预设下拉、动作表（动作 · 当前键 · 修改录制 · 冲突提示）、「恢复默认」。帮助页/工具条 `KeymapKbd` 提示随预设变化。 |
| 设置六分区（`SETTINGS_GROUPS`） | `src/workspace/settings/settingsGroups.ts` | `id: "project"\|"keymap"\|"playback"\|"performance"\|"tools"\|"about"` | 分区名与顺序改为剪映式六块：「项目与缓存 / 快捷键 / 播放与导出 / 性能 / 工具与模型 / 关于」，每块顶部一句 `intro` 说明「这里管什么」；**去掉 R12 遗留的「高级…」折叠**，所有项一行一控件。九个旧分区 id（`SettingsSectionId`）全部保留，只是重新分配进六块。 |
| `Guide` / `guides.ts` | `src/workspace/ui/Guide.tsx`、`src/workspace/guides.ts` | `anchor: ref\|selector`，`text`，`onDismiss()`，`onAction?()` | 剪映式一次性功能气泡：锚点 300ms 轮询跟随（零依赖），找不到超 2.5s 让位；`dialog「新手引导」`（`role=dialog`，无 `aria-modal`，不抢焦点，`prefers-reduced-motion` 关动画）。`guides.ts` 纯函数表 `GUIDES` + `nextGuide()`，同一时刻恰好一个；键 `guide.<id>.viewed`（Rust 白名单前缀规则，值只许 true/false）。首批 7 个：导航条、热力条、自动挑选按钮、镜头带镜块、缺口卡、导出抽屉、连播开关。 |
| `HomeScreen` / `HomeCards` | `src/workspace/HomeScreen.tsx`、`src/workspace/HomeCards.tsx`、`src/workspace/homeModel.ts`、`src/workspace/homeStore.ts` | `visible`，`recentEpisodes`，`onStart()`，`onOpenEpisode(id)`，`onTemplate(id)` | 空库自动出现 / 点顶栏 logo 进入；**盖在**三栏与状态条上（`inert`，不是替换，三栏保持挂载）；`region「首页」`，`button「开始一个新旅程」`，`list「最近的集」`，`group「从模板开始」`（旅行日记/电影感/快节奏），`status「模板确认」`（当前集有素材时先确认再新建，不悄悄封存）；R12 四步卡内容并入首页顶部（`group「四步上手」`，同一 `usePipeline` 数据源）。 |
| `useBandTimeline` / `bandTimeline.ts` | `src/workspace/useBandTimeline.ts`、`src/workspace/bandTimeline.ts` | — | 镜头带时间刻度 + 播放头：节距轴（每块固定 168px，与时长无关）到时间的分段线性映射，刻度/播放头/点击定位三处共用；`img「时间刻度」`（视口上方常驻）；播放头（红线，token `--playhead`）250ms 轮询 `player_status` 换算位置，不改 `player/mod.rs`。 |
| `useBandTrim`（拖边裁剪） | `src/workspace/useBandTrim.ts` | — | 精选段镜块两侧把手 `button「调整入点」「调整出点」`，拖动吸附 0.1s，← → 一次 0.1s；`status「<新时长> s」`（拖动中块内预览）。后端无「更新精选段」命令，走「新建→`set_story_order` 换引用→删旧」三步，失败回滚新段不动旧段；新段星级不继承旧段（评级挂在 `segment_id`）。 |
| 轨头折叠 | `src/workspace/BandChapters.tsx` | `folded: Set<chapterId>` | 章名行 sticky 贴左，`button「折叠第 n 章」/「展开第 n 章」`（`aria-expanded`），折叠格显示 `button「<n> 镜 · 已收起」`（点击展开）；偏移表/刻度/虚拟化按折叠后几何重算。 |
| 「导入剪映继续剪」+ 交接 toast | `src/workspace/BandJianyingButton.tsx` + Rust `open_app` 命令 | — | 镜头带刻度行右端常驻，`button「导入剪映继续剪」`（AX 名不带「(待验证)」，可见文案带）；`SUPPORTED_JIANYING_VERSIONS` 白名单可用为 primary、否则 secondary + 白话说明；点击落到抽屉剪映模式，草稿生成后全局 toast「已生成剪映草稿」+ `button「打开剪映」`；`open_app(bundle_id)` 白名单仅 `com.lemon.lvpro`，名单外不跑 `open`。 |
| 剪映风格深色主题 | `src/styles/tokens.css`（`html[data-theme="jianying-dark"]`） | — | 近黑冷炭灰四级 + 青绿强调 `#2fd6c4` + 红播放头 `#ff4d4a`；`tokens.test` 钉住 27 个必须重定义的键；设置外观「主题」新增第四段 `button「剪映风格深色」`；不默认。 |

### R13 新增 AX 名（冻结名一个未动）

- **快捷键 / 设置六分区（车道 A）**：设置分区 tab 从「常用/工具与模型/关于」三个改为「项目与缓存/快捷键/播放与外/性能/工具与模型/关于」六个（原三分区 tab 名释放，六分区为新名）；「快捷键」分区内表格行、录制态、冲突提示（无固定枚举文案，逐条生成）。
- **引导（车道 B）**：dialog「新手引导」；button「知道了」「试试自动挑选」；button「重置新手引导」（设置「关于」）。
- **首页（车道 B）**：button「首页」（顶栏 logo，带 `aria-pressed`）；region「首页」；button「开始一个新旅程」；list「最近的集」；group「从模板开始」；status「模板确认」；img「四步进度:n/4」。释放：button「开始使用」「关闭引导」（R12 四步卡不再是独立入口，并入首页）。
- **镜头带时间线化（车道 C）**：img「时间刻度」；button「在时间刻度上定位」（铺满刻度的透明按钮）；button「调整入点」「调整出点」；status「<新时长> s」；button「折叠第 n 章」/「展开第 n 章」；button「<n> 镜 · 已收起」；`gridcell` 新增 `data-guide="shot"|"gap"`（供车道 B 引导气泡锚定）。
- **交接感（车道 C）**：button「导入剪映继续剪」；toast「已生成剪映草稿」+ button「打开剪映」；设置外观 button「剪映风格深色」。

**未决 AX 事项**：R13 验收 v1 报告尚未产出（见 `docs/qa/2026-09-14-unattended-r12-r13.md` §4），上表 AX 名均按车道报告与代码 diff 记录，尚未经过真机走查逐条核对；若走查发现锚点/文案需要调整，以走查报告为准更新本节。

## 14. R14 新组件与新增 AX 名（车道 draftforce/kit/draftcontent）

> 依据：规格 §9 A/B/C（`docs/superpowers/specs/2026-09-14-r13-jianying-alignment-design.md`）；车道报告
> `.superpowers/sdd/r14/lane-draftforce-report.md`、`lane-kit-report.md`、`lane-draftcontent-report.md`；
> 真机验证 `.superpowers/sdd/r14/verify-v1.md`。均已经真机走查核对（verify-v1 §A/§B）。

| 组件 / 位置 | 文件 | AX 名 | 行为 |
|---|---|---|---|
| 剪映草稿试验开关（车道 draftforce） | `src/workspace/deliver/DeliverForm.tsx`、`DeliverResultCard.tsx` | button「仍然试着生成」（可见文案「我知道风险，仍然试着生成（试验）」）；button「可以用」；button「打不开」 | 待验证版本才出现；点「仍然试着生成」走 force 生成，不弹选目录；结果卡三步裁定走「可以用」「可以用」/「打不开」，裁定后按钮换「已记下「可以用」」（`role=status`）。结果卡里的「打开剪映」沿用既有名。 |
| 剪映可用性广播（车道 draftforce） | `src/workspace/deliver/jianyingHumanCheck.ts` | 事件名 `tripcut:jianying-availability-changed`（非 AX，供开关/chip/按钮跨组件即时刷新） | 裁定写 settings 成功后广播，监听方（`useDeliverForm`）立即翻转 `jianying.supported`/`canGenerateNative`，不需要重启。 |
| 剪映素材包 chip（车道 kit） | `src/workspace/deliver/DeliverDrawer.tsx` | chip「剪映素材包」（导出方式 group 内第二枚，四枚顺序：剪映草稿 / 剪映素材包 / 导出片段 / 完整交付包） | 剪映不可用时默认落点；剪映草稿 chip 仍保留（带「(待验证)」，给试验开关留入口）。 |
| 素材包主按钮 / 面板（车道 kit） | `src/workspace/deliver/JianyingKitPanel.tsx` | button「导出剪映素材包到上次文件夹」（可见文案「导出素材包」/「导出素材包…」，「更改文件夹」沿用）；section「剪映素材包」；list「将导出的文件」（沿用）；结果卡三步 list「接下来在剪映里」；button「打开剪映」「在 Finder 中显示」 | 面板一句话「按镜头带顺序编号导出，拖进剪映时间线就是这个顺序」+ 编号清单 + 「附『顺序.txt』」；页脚「导出到 <上次文件夹>」；与快速导出共用 `ui.export.last_dir`。 |
| 镜头带右上按钮（车道 kit） | `src/workspace/deliver/BandJianyingButton.tsx` | 不可用时 button「导出剪映素材包」（不再带「(待验证)」）；可用时仍「导入剪映继续剪」 | 不可用 → `openDeliverAs("kit")`；仍是 secondary（镜头带一次只许一个 primary）。 |
| 待验证态文案（车道 fix，V14-03） | `src/workspace/deliver/quickExportModel.ts`、`DeliverDrawer.tsx` | 无新 AX 名，`deliver-mode-hint`（role=status）文案改写 | 顶行改「这个剪映版本（v）还没核对过草稿格式。可以先导出素材包，或试着生成一份草稿在剪映里打开看看。」，未知版本/没装剪映的兜底从「完整交付包」改「剪映素材包」。 |
| 章节折叠（沿用 R13 §13，本轮真机核对） | `src/workspace/BandChapters.tsx` | button「折叠第 n 章」/「展开第 n 章」；button「<n> 镜 · 已收起」 | verify-v1 A6/Y-12：`axgeom` 确认三者均在 AX 树内，`axpanel press` 直接生效（R13 §13 记录的 AX 名本轮真机复核通过，非新名）。 |

**新事件（非 AX，供接线参考）**：`tripcut:jianying-availability-changed`（车道 draftforce 广播，车道 kit 的
`BandJianyingButton`/`DeliverDrawer` 尚未监听，需接线人各加一行 `onJianyingAvailabilityChanged` 订阅——见
`docs/qa/2026-09-14-unattended-r14.md` §7 第 4 条）。

**未改的冻结名**：结果卡「打开剪映」按钮名沿用 R13；镜头带右上按钮的 AX 名「导入剪映继续剪」/「导出剪映
素材包」二选一互斥，不新增第三个名。

未改的冻结名：顶栏四按钮、五个 landmark、附属带 tablist 与五个 tab、三个模态的 9 处冻结串、集切换两串、首启弹窗标题「先把本地工具链接好」与按钮「暂时进入工作台」（`smoke-gui.mjs` / `ax-helpers.mjs` 锚点，车道 A 若撤弹窗一并处理）。
