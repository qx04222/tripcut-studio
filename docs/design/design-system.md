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

- 顶栏按钮（4）：`导入素材` `切换集` `生成交付包` `设置`
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
