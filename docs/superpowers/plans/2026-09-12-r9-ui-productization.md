# R9 界面成品化 —— 设计系统、原生抽屉、主屏层级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 每个任务先写会红的测试，再写实现；每个 commit 都要能被单独否决而不拖垮同任务的其它 commit。**每个任务收尾必须 `npm run preview:shots`，实施者用 Read 工具看 PNG，把仍存在的缺陷写进任务报告。**

**Goal:** 把 R8 的线框级导演台升到成品：一套令牌（`src/styles/tokens.css`）+ 一个组件套件（`src/workspace/ui/`）+ 一套 16px 描边图标；主屏四栏有层级、有空状态、有 hover / 拖动态、分隔条可见；导入 / 交付 / 设置三个模态用套件原生重写，旧页面只剩逻辑供体（hooks）与旧壳宿主。

**Architecture:** 令牌层引用 `styles.css:4-60` 既有调色板变量（深色主题自动跟随）。套件每组件一文件 + 一测 + 一个 `KitPreview` 示例块，由 `kit.html` 在 `vite --mode mock` 下挂载，`preview-shots.mjs --kit` 截图。三个模态的逻辑抽成 `useImportSources` / `useImportJobs` / `useMissingMedia` / `useDeliverForm` / `useExportProgress` / `useSettingsForm`，旧组件改为消费这些 hooks（既有测试一行不改仍绿 = 抽取正确的判据），新抽屉 / sheet 只画皮。`src/api.ts` 一行不改，`src-tauri` 零改动。

**Tech Stack:** React 19.2.8 + TypeScript 6.0.3 + Vite 8.2.2（rolldown）+ vitest 4.1.11 + jsdom 30 + `@testing-library/react` 16.3（`renderHook` 可用）+ `playwright-core` 1.62（截图装置）+ `postcss`（`axNames.test.tsx` 已用它解析 CSS）。**不新增 npm 依赖。**

## Global Constraints

以下逐条来自规格 §0/§1/§6/§7，执行期间不得自行放宽：

- **AX 名 / 角色一字不差（R8 冻结）**：按钮 `导入素材` `生成交付包` `设置` `切换集`；`role="region" aria-label` 为 `媒体池` `预览监视器` `镜头带` `检查器`，`role="status" aria-label="后台状态"`；`role="tablist" aria-label="镜头带附属视图"`，tab 名 `故事` `音乐` `旅程` `地点卡` `模板`。`src/workspace/axNames.test.tsx` 与 `scripts/qa/smoke-gui.mjs` 按这些串找元素。
- **模态内冻结串**：`导入素材`（抽屉标题）、`来源 / 任务 / 缺失素材`、`松开即导入`（平时不在树里）、`本次交付平台`、`联系表`、`隐私与诊断`、`云端补镜`、`重命名本集`、`目标平台`。
- **每个文件 < 400 行**（`wc -l` 判）。
- **`npm run lint` 的 jsx-a11y 零告警。**
- **每个 chunk < 500 kB**，`node scripts/qa/check-chunks.mjs` 通过（`drawers` / `settings` 只能以动态 import 出现在首屏 chunk）。
- **vitest 断言只迁移不删除**：`PoolCard.splitFileName` → `fileNameLines`；`Inspector.test` 的默认层用例改为「有内容时」；旧页面测试（`ImportPage.test` / `ImportPageRuntime.test` / `ImportManagement.test` / `MissingMediaPanel.test` / `DeliverPage.test` / `SettingsPage.test`）**一行不改**。
- **`src/api.ts` 一行不改，`src-tauri/` 零改动，无 schema 变更。**
- **颜色 / 字号 / 间距只从令牌取**：`workspace.css` 与 `src/workspace/**` 不许出现颜色字面量、`px` 字号、非 4/8/12/16/24/32 的间距（Task 1a 的扫描测试是门禁）。
- **中文 only**：新壳与三个模态里不出现任何英文 kicker；缩写只留 LUT / AI / EP01 / ⌘K / I / O / PDF / CSV。
- **transition ≤ 150ms**，只用 `--motion-fast`。
- 提交尾部两行：`Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` 与 `Claude-Session: https://claude.ai/code/session_01AH25FGK6bsQkE1E9zpJQtq`。
- 合并前 `node scripts/qa/fast-gates.mjs` → **`gate.json.status` 必须 PASS**（`node -e "process.exit(require('./gate.json').status==='PASS'?0:1)"`）。
- **每条车道一个 `git worktree`**（`../tripcut-r9-t<N>`），共用 `CARGO_TARGET_DIR`；Task 1 独占先行；2/3/4 依赖 1 且互相可并行（只碰各自 `workspace.css` 分节）；5/6/7 依赖 1 且互相可并行；8 收口在 `main` 的 `chore/r9-wrapup`。
- **每个任务的最后一个 commit 之前**：`npm run preview:shots`，Read 每张 PNG，报告里按图列缺陷；控制端合并前看图。版本号**保持 0.3.0**。

### 已核实的事实（执行前先读）

1. `src/workspace/Drawer.tsx`（86 行）已含四条必须保留的行为：模态栈（`modalStack.ts`，Esc 只在栈顶响应）、`useFocusTrap(containerRef, open)`、`onMouseDown` 判遮罩本身才关闭、可见「关闭」按钮（AX 名 `关闭`，冒烟 `clickByLabel("关闭")` 用它）。Task 1c 把它迁到 `ui/Drawer.tsx` + `ui/Sheet.tsx`，`vite.config.ts` `app-core` 组的正则 `workspace[\\/](uiSettings|WorkspaceStore|modalStack|Drawer)` 要跟着改（Task 1d）。
2. `api.ts` **没有导入队列的暂停 / 继续命令**（只有 `cancel_import_batch`、`set_watched_folder_sync`、`rescan_watched_folders`）。任务书里「任务分页的 暂停/继续」无法接线；本计划按规格 §4.1 的记档执行：批次卡只有「停止本批」「撤销本批…」，关注文件夹的 `Toggle 自动同步` 即暂停 / 继续同步。
3. 假后端 `src/devMock/fixture.ts` 已覆盖 `list_watched_folders / list_import_batches / list_missing_clips / get_import_progress / get_export_status / get_jianying_availability / list_platform_presets / get_settings / get_settings_status / get_component_statuses / list_device_clocks`，三个模态的原生重写在 `preview:shots` 里都有数据可看。`preview-shots.mjs` 把 console 里 `no handler for command` 记为失败——新 UI 若调了假后端没有的命令，截图步骤直接红。
4. `PoolCard.tsx:13` 的 `splitFileName(name, tailLength=6)` 是中段省略的来源；`MediaPool.test.tsx` 未直接引用它，只有 `PoolCard` 用。`poolModel.clipAriaLabel` 生成的 AX 名不变。
5. `BandSegment.tsx` 已有缩略图 `<img>`（设计遍历 `01d5132` 加的），瓦片 160×130；下方空白来自 `.band-viewport` 撑满中下区，不是瓦片本身。
6. `Inspector.test.tsx:229`「默认层四段顺序固定且永远展开」与 `:304`「标签段渲染禁用的添加」两条与 R9「隐藏空段」相抵触，按迁移纪律改成带 fixture（有 tags、有 stack）的版本，不删。
7. `SettingsPage.tsx:642-643` 的串行保存队列：`const request = saveQueueRef.current.then(() => setSetting(key, value)); saveQueueRef.current = request.catch(() => undefined);`，外加 `saveVersionRef` 版本号防旧失败回滚新值、`confirmedSettingsRef` 回滚源、`appearance.` 前缀立即 `applyAppearanceSettings`。`useSettingsForm` 必须逐字保留这四件。
8. `preview-shots.mjs` 第 06 步等 `本次交付平台` 文本、第 07 步等 `隐私与诊断`；`shot()` 找不到元素记 FAIL 但继续截图。新增 `--kit` 时用同一 `shot()`。
9. `test-setup.ts` 把 jsdom 窗口撑到 1440×900；`ResizeObserver` 已 polyfill。
10. `eslint.config.js` 的 `ignores` 含 `scripts/**`，`kit.html` / `kitMain.tsx` 在 `src/devMock/` 下会被 lint，写法要过 jsx-a11y。

---

### Task 1: 令牌 + 套件 + 图标 + 套件预览

**依赖：** 无。**独占车道。** `git worktree add ../tripcut-r9-t1 -b feat/r9-kit`

#### Commit 1a — `tokens.css` + 令牌门禁测试

**Files:**
- Create `src/styles/tokens.css`（~140 行）
- Create `src/styles/tokens.test.ts`
- Modify `src/main.tsx`（`import "./styles/tokens.css";` 放在 `./styles.css` 之前）

**Interfaces:**
- Produces（CSS 自定义属性，全部挂 `:root`）：`--text-11/12/13/15/20`、`--lh-11/12/13/15/20`、`--space-1..6`、`--surface-ground/panel/card/raised`、`--well-bg`、`--shadow-card/raised/inset-well`、`--radius-6/10`、`--border-hair/strong/focus`、`--accent-ink`（= `var(--accent-contrast)`）、`--ok/--ok-tint/--warn/--warn-tint/--danger/--danger-tint/--info/--info-tint`、`--ring`、`--ring-selected`、`--motion-fast`、`--control-sm/md`。深色覆盖块两段（`prefers-color-scheme: dark` + `html[data-theme="dark"]`）只改 `--surface-card`、`--surface-raised`、`--shadow-*`、`--well-bg`。

- [ ] 先红 `src/styles/tokens.test.ts`：
  ```ts
  import { readFileSync } from "node:fs";
  import { resolve } from "node:path";
  import postcss from "postcss";
  import { describe, expect, it } from "vitest";

  const TOKENS = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");
  const WORKSPACE = readFileSync(resolve(process.cwd(), "src/styles/workspace.css"), "utf8");

  function declared(css: string): Set<string> {
    const names = new Set<string>();
    postcss.parse(css).walkDecls((decl) => {
      if (decl.prop.startsWith("--")) names.add(decl.prop);
    });
    return names;
  }

  describe("tokens.css", () => {
    const names = declared(TOKENS);
    it("五级字号与配套行高、六档间距、四级表面、三级阴影、两档圆角都在", () => {
      for (const n of ["11", "12", "13", "15", "20"]) {
        expect(names.has(`--text-${n}`), `--text-${n}`).toBe(true);
        expect(names.has(`--lh-${n}`), `--lh-${n}`).toBe(true);
      }
      for (const n of ["1", "2", "3", "4", "5", "6"]) expect(names.has(`--space-${n}`)).toBe(true);
      for (const s of ["ground", "panel", "card", "raised"]) expect(names.has(`--surface-${s}`)).toBe(true);
      for (const s of ["card", "raised", "inset-well"]) expect(names.has(`--shadow-${s}`)).toBe(true);
      for (const r of ["6", "10"]) expect(names.has(`--radius-${r}`)).toBe(true);
      for (const t of ["ok", "warn", "danger", "info"]) {
        expect(names.has(`--${t}`)).toBe(true);
        expect(names.has(`--${t}-tint`)).toBe(true);
      }
      for (const k of ["--border-hair", "--border-strong", "--ring", "--ring-selected", "--motion-fast", "--control-sm", "--control-md", "--well-bg"]) {
        expect(names.has(k), k).toBe(true);
      }
    });
    it("间距六档就是 4/8/12/16/24/32", () => {
      const values: Record<string, string> = {};
      postcss.parse(TOKENS).walkDecls(/^--space-/, (d) => { values[d.prop] = d.value; });
      expect(values).toEqual({ "--space-1": "4px", "--space-2": "8px", "--space-3": "12px", "--space-4": "16px", "--space-5": "24px", "--space-6": "32px" });
    });
    it("表面色引用既有调色板变量,深色主题才会自动跟随", () => {
      const values: Record<string, string> = {};
      postcss.parse(TOKENS).walkDecls(/^--surface-(ground|panel)$/, (d) => { values[d.prop] = d.value; });
      expect(values["--surface-ground"]).toBe("var(--bg)");
      expect(values["--surface-panel"]).toBe("var(--bg-elevated)");
    });
    it("唯一的 transition 时长是 150ms", () => {
      let motion = "";
      postcss.parse(TOKENS).walkDecls("--motion-fast", (d) => { motion = d.value; });
      expect(motion.startsWith("150ms")).toBe(true);
    });
    it("有深色覆盖块", () => {
      expect(TOKENS).toMatch(/prefers-color-scheme:\s*dark/);
      expect(TOKENS).toMatch(/html\[data-theme="dark"\]/);
    });
  });

  describe("workspace.css 只从令牌取值(规格 §1)", () => {
    const root = postcss.parse(WORKSPACE);
    it("没有颜色字面量", () => {
      const offenders: string[] = [];
      root.walkDecls((d) => {
        if (d.prop.startsWith("--")) return;
        if (/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(d.value)) offenders.push(`${d.prop}: ${d.value}`);
      });
      expect(offenders).toEqual([]);
    });
    it("font-size 只用 --text-* 令牌", () => {
      const offenders: string[] = [];
      root.walkDecls("font-size", (d) => { if (!/var\(--text-\d+\)/.test(d.value)) offenders.push(d.value); });
      expect(offenders).toEqual([]);
    });
    it("padding/margin/gap 不出现六档之外的 px", () => {
      const offenders: string[] = [];
      root.walkDecls(/^(padding|margin|gap|row-gap|column-gap)(-\w+)?$/, (d) => {
        for (const m of d.value.matchAll(/(-?\d+)px/g)) {
          if (!["0", "4", "8", "12", "16", "24", "32", "-1"].includes(m[1]!)) offenders.push(`${d.prop}: ${d.value}`);
        }
      });
      expect(offenders).toEqual([]);
    });
  });
  ```
  跑 `npx vitest run src/styles/tokens.test.ts` → 第一组红（文件不存在），第二组红（`workspace.css` 现在满是 `13px` 与 `10px`）。**第二组在本 commit 允许保持红，Task 8b 清完才绿；本 commit 只要求第一组绿**——在文件里给第二组加 `describe.todo` 标注「Task 8b 打开」，Task 8b 改回 `describe`。
- [ ] 实现 `tokens.css`（头注释写明「只定义变量；表面色引用 styles.css 调色板」），`main.tsx` 加 import。
- [ ] 命令：
  ```
  npx vitest run src/styles/tokens.test.ts
  npm run typecheck
  ```
- [ ] Commit：`feat(styles): tokens.css 设计令牌——五级字号/六档间距/四级表面/阴影/圆角/语义色/焦点环,深色经既有调色板跟随`

#### Commit 1b — 图标集 + Button / Chip / Badge / Kbd / Card / SectionHeader / Toolbar / EmptyState

**Files:**
- Create `src/workspace/ui/icons.tsx`（~240 行：33 个图标 = 任务书 24 个 + 设置九分区 `settings-appearance … settings-cache`）
- Create `src/workspace/ui/Button.tsx` `Chip.tsx` `Badge.tsx` `Kbd.tsx` `Card.tsx` `SectionHeader.tsx` `Toolbar.tsx` `EmptyState.tsx`（各 < 120 行）
- Create `src/workspace/ui/index.ts`（只做 re-export）
- Create `src/workspace/ui/icons.test.tsx` `Button.test.tsx` `Chip.test.tsx` `Badge.test.tsx` `Card.test.tsx` `SectionHeader.test.tsx` `Toolbar.test.tsx` `EmptyState.test.tsx` `Kbd.test.tsx`
- Create `src/styles/kit.css`（套件样式，~360 行；`main.tsx` 在 `workspace.css` 之前引入）

**Interfaces:**
```ts
// icons.tsx
export type IconName =
  | "import" | "deliver" | "settings" | "search" | "play" | "pause" | "prev" | "next"
  | "volume" | "volume-off" | "fullscreen" | "mark-in" | "mark-out" | "save" | "star" | "heart"
  | "x" | "check" | "chevron-down" | "chevron-right" | "grip" | "plus" | "close" | "info" | "warning"
  | "settings-appearance" | "settings-performance" | "settings-timeline" | "settings-tools"
  | "settings-analysis" | "settings-generation" | "settings-privacy" | "settings-about" | "settings-cache";
export const ICON_NAMES: readonly IconName[];
export function Icon({ name, size = 16, filled = false, className }: { name: IconName; size?: 12 | 16 | 20 | 32; filled?: boolean; className?: string }): JSX.Element; // <svg aria-hidden focusable=false stroke=currentColor stroke-width=1.5 fill=none>

// Button.tsx
export type ButtonVariant = "primary" | "secondary" | "ghost" | "icon";
export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  variant?: ButtonVariant; size?: "sm" | "md"; icon?: IconName; busy?: boolean; tone?: "neutral" | "danger";
}
export function Button(props: ButtonProps): JSX.Element; // variant=icon 时必须给 aria-label,否则 dev 抛错

// Chip.tsx
export function Chip({ selected, count, tone, icon, onClick, children, ...rest }: {...}): JSX.Element; // 有 onClick 渲染 <button aria-pressed>,否则 <span>

// Badge.tsx
export function Badge({ tone = "neutral", icon, children }: { tone?: "neutral" | "accent" | "warn" | "danger" | "ink"; icon?: IconName; children: ReactNode }): JSX.Element;

// Card.tsx
export function Card({ level = "card", interactive, selected, padding = 3, as = "div", className, children, ...rest }): JSX.Element;

// SectionHeader.tsx
export function SectionHeader({ title, meta, actions, size = "section", description }: {...}): JSX.Element; // size=pane 用 <div>,size=section 用 <h3>

// Toolbar.tsx
export function Toolbar({ children, ariaLabel, dense, className }): JSX.Element; // role=toolbar 当且仅当 ariaLabel 给了
Toolbar.Divider = function Divider(): JSX.Element;
Toolbar.Spacer = function Spacer(): JSX.Element;

// EmptyState.tsx
export function EmptyState({ icon, title, body, action, size = "pane", tone = "light" }): JSX.Element;

// Kbd.tsx
export function Kbd({ children }: { children: ReactNode }): JSX.Element;
```

- [ ] 先红 `src/workspace/ui/icons.test.tsx`：
  ```tsx
  // @vitest-environment jsdom
  import { render } from "@testing-library/react";
  import { describe, expect, it } from "vitest";
  import { ICON_NAMES, Icon } from "./icons";

  const REQUIRED = ["import","deliver","settings","search","play","pause","prev","next","volume","volume-off","fullscreen","mark-in","mark-out","save","star","heart","x","check","chevron-down","chevron-right","grip","plus","close","info","warning"] as const;

  describe("icons", () => {
    it("任务书的 24 个图标名都在(volume-off 是 volume 的配对态,算一对)", () => {
      for (const name of REQUIRED) expect(ICON_NAMES).toContain(name);
    });
    it("每个图标 16px 视窗、1.5 描边、currentColor、aria-hidden", () => {
      for (const name of ICON_NAMES) {
        const { container, unmount } = render(<Icon name={name} />);
        const svg = container.querySelector("svg")!;
        expect(svg.getAttribute("viewBox"), name).toBe("0 0 16 16");
        expect(svg.getAttribute("width")).toBe("16");
        expect(svg.getAttribute("stroke")).toBe("currentColor");
        expect(svg.getAttribute("stroke-width")).toBe("1.5");
        expect(svg.getAttribute("aria-hidden")).toBe("true");
        expect(svg.getAttribute("focusable")).toBe("false");
        expect(svg.children.length, `${name} 没有路径`).toBeGreaterThan(0);
        unmount();
      }
    });
    it("filled 的星 / 心用 fill=currentColor", () => {
      const { container } = render(<Icon name="star" filled />);
      expect(container.querySelector("svg")!.getAttribute("fill")).toBe("currentColor");
    });
  });
  ```
- [ ] 先红 `src/workspace/ui/Button.test.tsx`：
  ```tsx
  // @vitest-environment jsdom
  import { render, screen } from "@testing-library/react";
  import { describe, expect, it } from "vitest";
  import { Button } from "./Button";

  describe("Button", () => {
    it("四个 variant 各自落 class,默认 secondary/md", () => {
      const { rerender } = render(<Button>保存</Button>);
      expect(screen.getByRole("button", { name: "保存" }).className).toContain("ui-button--secondary");
      for (const variant of ["primary", "ghost"] as const) {
        rerender(<Button variant={variant}>保存</Button>);
        expect(screen.getByRole("button").className).toContain(`ui-button--${variant}`);
      }
      rerender(<Button variant="icon" icon="settings" aria-label="设置" />);
      expect(screen.getByRole("button", { name: "设置" }).className).toContain("ui-button--icon");
    });
    it("icon 变体没有 aria-label 就抛(不许出现没名字的图标按钮)", () => {
      expect(() => render(<Button variant="icon" icon="x" />)).toThrow(/aria-label/);
    });
    it("busy 时 aria-busy 且禁用,不再触发 onClick", () => {
      let clicks = 0;
      render(<Button busy onClick={() => { clicks += 1; }}>生成</Button>);
      const button = screen.getByRole("button", { name: "生成" });
      expect(button.getAttribute("aria-busy")).toBe("true");
      expect((button as HTMLButtonElement).disabled).toBe(true);
      button.click();
      expect(clicks).toBe(0);
    });
    it("带 icon 时图标在文字前且 aria-hidden", () => {
      render(<Button icon="import">导入素材</Button>);
      const button = screen.getByRole("button", { name: "导入素材" });
      expect(button.firstElementChild!.tagName).toBe("svg");
    });
  });
  ```
- [ ] 先红 `Chip.test.tsx` / `Badge.test.tsx` / `Card.test.tsx` / `SectionHeader.test.tsx` / `Toolbar.test.tsx` / `EmptyState.test.tsx` / `Kbd.test.tsx`（每份 3–4 例）：
  ```tsx
  // Chip.test.tsx
  it("有 onClick 时是 button 且 aria-pressed 跟 selected", () => {
    render(<Chip selected count={60} onClick={() => {}}>全部</Chip>);
    const chip = screen.getByRole("button", { name: "全部 60" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
  });
  it("没有 onClick 时是静态 span,不进 tab 序", () => {
    render(<Chip>只读</Chip>);
    expect(screen.queryByRole("button")).toBeNull();
  });
  // Badge.test.tsx
  it("tone 落 class,icon 可选", () => {
    const { container } = render(<Badge tone="warn" icon="warning">缺口 1</Badge>);
    expect(container.firstElementChild!.className).toContain("ui-badge--warn");
    expect(container.querySelector("svg")).not.toBeNull();
  });
  // Card.test.tsx
  it("interactive + selected 落 class,as=button 时是真按钮", () => {
    render(<Card as="button" interactive selected aria-label="卡">x</Card>);
    const card = screen.getByRole("button", { name: "卡" });
    expect(card.className).toContain("ui-card--interactive");
    expect(card.className).toContain("ui-card--selected");
  });
  it("level=raised 用浮层阴影 class", () => {
    const { container } = render(<Card level="raised">x</Card>);
    expect(container.firstElementChild!.className).toContain("ui-card--raised");
  });
  // SectionHeader.test.tsx
  it("size=section 是 h3,size=pane 不是 heading(栏 landmark 已有名字)", () => {
    const { rerender } = render(<SectionHeader title="本次交付" />);
    expect(screen.getByRole("heading", { level: 3, name: "本次交付" })).toBeTruthy();
    rerender(<SectionHeader size="pane" title="媒体池" meta="51 / 60 条" />);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText("51 / 60 条")).toBeTruthy();
  });
  // Toolbar.test.tsx
  it("给了 ariaLabel 才是 role=toolbar", () => {
    const { rerender } = render(<Toolbar ariaLabel="走带"><button>a</button></Toolbar>);
    expect(screen.getByRole("toolbar", { name: "走带" })).toBeTruthy();
    rerender(<Toolbar><button>a</button></Toolbar>);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
  it("Divider 是 aria-hidden 的分隔", () => {
    const { container } = render(<Toolbar><Toolbar.Divider /></Toolbar>);
    expect(container.querySelector(".ui-toolbar-divider")!.getAttribute("aria-hidden")).toBe("true");
  });
  // EmptyState.test.tsx
  it("标题是 p 不是 heading,图标 32px,action 原样渲染", () => {
    render(<EmptyState icon="import" title="还没有素材" body="导入一批素材后会出现在这里。" action={<button>导入素材</button>} />);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText("还没有素材").tagName).toBe("P");
    expect(document.querySelector("svg")!.getAttribute("width")).toBe("32");
    expect(screen.getByRole("button", { name: "导入素材" })).toBeTruthy();
  });
  // Kbd.test.tsx
  it("渲染 <kbd>", () => {
    render(<Kbd>⌘K</Kbd>);
    expect(document.querySelector("kbd")!.textContent).toBe("⌘K");
  });
  ```
- [ ] 实现八个组件 + `icons.tsx` + `kit.css`（class 前缀统一 `ui-`；全部值取自令牌；hover / focus-visible / disabled 三态每个组件都写；transition 只用 `var(--motion-fast)`）。
- [ ] 命令：
  ```
  npx vitest run src/workspace/ui
  npm run lint
  ```
- [ ] Commit：`feat(ui): 组件套件第一批——33 个 16px 描边图标、Button/Chip/Badge/Kbd/Card/SectionHeader/Toolbar/EmptyState`

#### Commit 1c — Field / Toggle / Select / Tabs + Drawer / Sheet（迁移既有模态壳）

**Files:**
- Create `src/workspace/ui/Field.tsx` `Toggle.tsx` `Select.tsx` `Tabs.tsx` `ModalSurface.tsx` `Drawer.tsx` `Sheet.tsx` + 对应 `.test.tsx`
- Delete `src/workspace/Drawer.tsx`
- Modify `src/workspace/ImportDrawer.tsx` `DeliverDrawer.tsx` `SettingsSheet.tsx`（只改 import 路径与 `side` 参数；内容仍是旧页面——Task 5/6/7 才换）
- Modify `src/workspace/ui/index.ts`
- Modify `src/styles/kit.css`

**Interfaces:**
```ts
// Field.tsx
export function Field({ label, help, htmlFor, inline = true, children }: { label: string; help?: ReactNode; htmlFor?: string; inline?: boolean; children: ReactNode }): JSX.Element; // <div class=ui-field><label for>…</label><div class=ui-field-control>{children}</div><p class=ui-field-help>…</p></div>
// Toggle.tsx
export function Toggle({ checked, onChange, label, disabled, id }: { checked: boolean; onChange(next: boolean): void; label: string; disabled?: boolean; id?: string }): JSX.Element; // <button role="switch" aria-checked aria-label={label}>
// Select.tsx
export function Select(props: ComponentPropsWithRef<"select">): JSX.Element; // 原生 select + chevron-down 覆层
// Tabs.tsx
export interface TabItem { id: string; label: string; count?: number }
export function Tabs({ items, value, onChange, ariaLabel }: { items: readonly TabItem[]; value: string; onChange(id: string): void; ariaLabel: string }): JSX.Element; // role=tablist,tab 名 = label(count 另放 aria-hidden span,不进 AX 名)
// ModalSurface.tsx(内部)
export function ModalSurface({ open, title, placement: "left" | "right" | "center", width, height?, onClose, actions?, children }): JSX.Element | null; // 迁自旧 Drawer.tsx:模态栈 + useFocusTrap + Esc 栈顶 + mousedown 遮罩 + 可见「关闭」
// Drawer.tsx
export function Drawer({ open, title, side, width, onClose, actions, children }: {...; side: "left" | "right" }): JSX.Element | null;
// Sheet.tsx
export function Sheet({ open, title, width = "960px", height = "80vh", onClose, actions, children }): JSX.Element | null;
```

- [ ] 先红 `src/workspace/ui/Drawer.test.tsx`（四条行为逐条从 `DeliverDrawer.test.tsx:100-142` 复制语义）：
  ```tsx
  // @vitest-environment jsdom
  import { fireEvent, render, screen } from "@testing-library/react";
  import { describe, expect, it, vi } from "vitest";
  import { Drawer } from "./Drawer";
  import { Sheet } from "./Sheet";

  describe("Drawer / Sheet 模态壳(迁自 workspace/Drawer.tsx,四条行为一条不丢)", () => {
    it("role=dialog aria-modal,AX 名 = title,标题栏有 20px 标题与可见「关闭」", () => {
      render(<Drawer open title="导入素材" side="left" width="600px" onClose={() => {}}>x</Drawer>);
      const dialog = screen.getByRole("dialog", { name: "导入素材" });
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
      expect(dialog.querySelector(".ui-modal-title")!.textContent).toBe("导入素材");
    });
    it("Esc 关闭;栈顶之下的模态不响应", () => {
      const closeA = vi.fn();
      const closeB = vi.fn();
      render(<><Drawer open title="A" side="left" width="600px" onClose={closeA}>a</Drawer><Sheet open title="B" onClose={closeB}>b</Sheet></>);
      fireEvent.keyDown(document, { key: "Escape" });
      expect(closeB).toHaveBeenCalledTimes(1);
      expect(closeA).not.toHaveBeenCalled();
    });
    it("在遮罩上按下才关;在抽屉内按下、拖到遮罩松手不关", () => {
      const onClose = vi.fn();
      render(<Drawer open title="A" side="right" width="600px" onClose={onClose}><p>内容</p></Drawer>);
      fireEvent.mouseDown(screen.getByText("内容"));
      fireEvent.click(document.querySelector(".ui-modal-overlay")!);
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.mouseDown(document.querySelector(".ui-modal-overlay")!);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    it("打开后焦点进入对话框(真机 Esc 关不掉的第一嫌疑是焦点根本没进来)", () => {
      render(<Drawer open title="A" side="left" width="600px" onClose={() => {}}><button>第一个</button></Drawer>);
      expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    });
    it("Sheet 居中且带 height", () => {
      render(<Sheet open title="设置" onClose={() => {}}>x</Sheet>);
      const dialog = screen.getByRole("dialog", { name: "设置" });
      expect(dialog.className).toContain("ui-modal--center");
      expect(dialog.style.height).toBe("80vh");
    });
    it("actions 渲染在标题栏右侧、关闭键之前", () => {
      render(<Drawer open title="A" side="left" width="600px" onClose={() => {}} actions={<button>立即扫描</button>}>x</Drawer>);
      const bar = document.querySelector(".ui-modal-titlebar")!;
      const buttons = [...bar.querySelectorAll("button")].map((b) => b.textContent);
      expect(buttons).toEqual(["立即扫描", "×关闭"]);
    });
  });
  ```
- [ ] 先红 `Toggle.test.tsx` / `Tabs.test.tsx` / `Field.test.tsx` / `Select.test.tsx`：
  ```tsx
  // Toggle.test.tsx
  it("是 role=switch,aria-checked 跟 checked,点击翻转", () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="联系表.pdf" />);
    const sw = screen.getByRole("switch", { name: "联系表.pdf" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    sw.click();
    expect(onChange).toHaveBeenCalledWith(true);
  });
  it("disabled 时不触发", () => {
    const onChange = vi.fn();
    render(<Toggle checked disabled onChange={onChange} label="剪映草稿" />);
    screen.getByRole("switch").click();
    expect(onChange).not.toHaveBeenCalled();
  });
  // Tabs.test.tsx
  it("tablist/tab 角色齐全,tab 的 AX 名不含计数", () => {
    render(<Tabs ariaLabel="导入分页" value="jobs" onChange={() => {}} items={[{ id: "source", label: "来源" }, { id: "jobs", label: "任务", count: 3 }, { id: "missing", label: "缺失素材", count: 2 }]} />);
    expect(screen.getByRole("tablist", { name: "导入分页" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "任务" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "缺失素材" })).toBeTruthy();
  });
  it("← → 在 tab 间移动并触发 onChange(roving)", () => {
    const onChange = vi.fn();
    render(<Tabs ariaLabel="x" value="a" onChange={onChange} items={[{ id: "a", label: "甲" }, { id: "b", label: "乙" }]} />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "甲" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("b");
  });
  // Field.test.tsx
  it("label 通过 htmlFor 关联控件,help 在下", () => {
    render(<Field label="本次交付平台" htmlFor="platform" help="不改本集设置"><select id="platform" /></Field>);
    expect(screen.getByLabelText("本次交付平台")).toBeTruthy();
    expect(screen.getByText("不改本集设置").className).toContain("ui-field-help");
  });
  // Select.test.tsx
  it("是原生 select,外套 chevron-down", () => {
    render(<Select aria-label="平台"><option>通用</option></Select>);
    expect(screen.getByRole("combobox", { name: "平台" }).tagName).toBe("SELECT");
    expect(document.querySelector("svg")).not.toBeNull();
  });
  ```
- [ ] 实现：`ModalSurface.tsx` 逐段搬 `workspace/Drawer.tsx`（含所有注释里的事故说明），加 `useEffect` 在 open 时 `containerRef.current?.focus()`（配合 `useFocusTrap`；R8 报告说真机 `AXFocusedUIElement` 是 missing value——这一行就是为它加的）。删除旧 `Drawer.tsx`；三个模态壳改 `import { Drawer } from "./ui/Drawer"` / `import { Sheet } from "./ui/Sheet"`。
- [ ] 跑既有 `src/workspace/ImportDrawer.test.tsx` `DeliverDrawer.test.tsx` `SettingsSheet.test.tsx` `axNames.test.tsx` → 必须仍绿。
- [ ] 命令：
  ```
  npx vitest run src/workspace
  npm run lint
  ```
- [ ] Commit：`feat(ui): Field/Toggle/Select/Tabs + Drawer/Sheet(迁自 workspace/Drawer.tsx,模态栈/焦点陷阱/遮罩/可见关闭四条行为保留,打开即聚焦)`

#### Commit 1d — 套件预览页 + `preview-shots --kit` + chunk 分组

**Files:**
- Create `kit.html`（仓库根，8 行：`<div id="kit">` + `<script type="module" src="/src/devMock/kitMain.tsx">`）
- Create `src/devMock/kitMain.tsx`（~20 行）
- Create `src/devMock/KitPreview.tsx`（~320 行：每个组件一节 `<section aria-label="…">`，所有 variant × 状态；末尾一块 `<div data-theme="dark" className="kit-dark">` 重复 Button / Card / Chip）
- Create `src/devMock/kitPreview.test.tsx`
- Modify `scripts/qa/preview-shots.mjs`（`--kit`：多截 `10-kit.png`，全页 `fullPage: true`；`--kit-only` 跳过工作区剧本）
- Modify `vite.config.ts`（`app-core` 正则去掉 `Drawer`；新增第一条 `{ name: "ui-kit", test: /[\\/]src[\\/]workspace[\\/]ui[\\/]/ }`；`build.rollupOptions` **不加** `kit.html`）
- Modify `src/devMock/viteMock.test.ts`（加一例：生产 build 的 input 不含 `kit.html`）
- Modify `package.json`（`"preview:kit": "node scripts/qa/preview-shots.mjs --kit-only"`）

**Interfaces:**
```ts
// KitPreview.tsx
export function KitPreview(): JSX.Element;
export const KIT_SECTIONS: readonly string[]; // ["图标","按钮","Chip 与 Badge","卡片","节标题","表单","Toggle 与 Select","Tabs","工具条","空状态","Kbd","抽屉与 Sheet","深色"]
```

- [ ] 先红 `src/devMock/kitPreview.test.tsx`：
  ```tsx
  // @vitest-environment jsdom
  import { render, screen } from "@testing-library/react";
  import { describe, expect, it } from "vitest";
  import { KIT_SECTIONS, KitPreview } from "./KitPreview";
  import { ICON_NAMES } from "../workspace/ui/icons";

  describe("KitPreview(套件 kitchen-sink)", () => {
    it("每个套件组件都有一节,节名是中文", () => {
      render(<KitPreview />);
      for (const name of KIT_SECTIONS) expect(screen.getByRole("region", { name })).toBeTruthy();
      expect(KIT_SECTIONS.every((s) => !/[A-Za-z]{4,}/.test(s.replace(/Chip|Badge|Toggle|Select|Tabs|Kbd|Sheet/g, "")))).toBe(true);
    });
    it("图标一节把 33 个图标全部画出来并标名", () => {
      render(<KitPreview />);
      const section = screen.getByRole("region", { name: "图标" });
      expect(section.querySelectorAll("svg").length).toBe(ICON_NAMES.length);
      for (const name of ICON_NAMES) expect(section.textContent).toContain(name);
    });
    it("按钮一节覆盖 4 variant × 2 size × (默认/禁用/busy)", () => {
      render(<KitPreview />);
      const section = screen.getByRole("region", { name: "按钮" });
      expect(section.querySelectorAll("button").length).toBeGreaterThanOrEqual(24);
    });
    it("有深色一栏(data-theme=dark)", () => {
      render(<KitPreview />);
      expect(document.querySelector('[data-theme="dark"]')).not.toBeNull();
    });
  });
  ```
- [ ] 先红 `src/devMock/viteMock.test.ts` 追加：
  ```ts
  it("kit.html 只在 mock 模式可访问,生产 build 不把它当入口", () => {
    const prod = resolveConfig({ mode: "production", command: "build" }) as { build?: { rolldownOptions?: { input?: unknown } } };
    expect(prod.build?.rolldownOptions?.input).toBeUndefined();
    expect(existsSync(resolve(process.cwd(), "kit.html"))).toBe(true);
  });
  ```
- [ ] `preview-shots.mjs`：
  ```js
  const KIT_ONLY = process.argv.includes("--kit-only");
  const WITH_KIT = KIT_ONLY || process.argv.includes("--kit");
  // … 工作区剧本(KIT_ONLY 时跳过)…
  if (WITH_KIT) {
    await page.setViewportSize(WIDE);
    await page.goto(`${vite.url}kit.html`, { waitUntil: "domcontentloaded" });
    await page.getByRole("region", { name: "按钮" }).waitFor({ timeout: STEP_TIMEOUT_MS });
    const file = join(outDir, "10-kit.png");
    await page.screenshot({ path: file, fullPage: true });
    log(`PASS 10-kit → ${file}`);
    // hover 态:把鼠标停在第一个 secondary 按钮上再截一张局部
    const hover = page.getByRole("region", { name: "按钮" }).getByRole("button").nth(1);
    await hover.hover();
    await page.waitForTimeout(200);
    await page.getByRole("region", { name: "按钮" }).screenshot({ path: join(outDir, "11-kit-hover.png") });
  }
  ```
- [ ] 跑 `npm run preview:kit`，**Read `10-kit.png` 与 `11-kit-hover.png`**，对照规格 §2 表逐项核：primary 有底、secondary 有边、ghost 透明 hover 出底、icon 28×28、Chip 选中态 tint、Card 阴影可见、EmptyState 图标 32 淡色、深色栏不刺眼。缺陷写进 `.superpowers/sdd/r9-task-1-report.md`。
- [ ] 命令：
  ```
  npx vitest run src/devMock src/workspace/ui
  npm run build && node scripts/qa/check-chunks.mjs
  npm run preview:kit
  node scripts/qa/fast-gates.mjs && node -e "process.exit(require('./gate.json').status==='PASS'?0:1)"
  ```
- [ ] Commit：`feat(qa): 套件预览页 kit.html + preview-shots --kit 截 10-kit/11-kit-hover,ui-kit 独立 chunk`

---

### Task 2: 主屏 chrome——顶栏、栏标题条、分隔条、状态条、空状态

**依赖：** Task 1。`git worktree add ../tripcut-r9-t2 -b feat/r9-chrome`

#### Commit 2a — 顶栏与栏标题条换套件

**Files:**
- Modify `src/workspace/TopBar.tsx`（按钮改 `Button`，集切换胶囊加 `chevron-down`，品牌记号改 `Icon`）
- Modify `src/workspace/EpisodeSwitcher.tsx`（只改触发按钮外观；AX 名 `切换集` 不变）
- Modify `src/workspace/PaneHead.tsx`（内部改用 `SectionHeader size="pane"`，导出签名不变，加 `actions` 透传）
- Modify `src/styles/workspace.css` 分节 2、3（顶栏底 + 阴影；栏面板 `--surface-panel`）
- Modify `src/workspace/WorkspaceShell.test.tsx`（追加）

- [ ] 先红 `WorkspaceShell.test.tsx` 追加：
  ```tsx
  it("顶栏三个按钮是套件按钮:导入素材 secondary、生成交付包 primary、设置 icon,都带图标", () => {
    render(<WorkspaceShell />);
    const importButton = screen.getByRole("button", { name: "导入素材" });
    expect(importButton.className).toContain("ui-button--secondary");
    expect(importButton.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("button", { name: "生成交付包" }).className).toContain("ui-button--primary");
    expect(screen.getByRole("button", { name: "设置" }).className).toContain("ui-button--icon");
    expect(screen.getByRole("button", { name: "切换集" }).querySelector("svg")).not.toBeNull();
  });
  it("栏标题条不是 heading,栏标题 + meta 都在", () => {
    render(<WorkspaceShell />);
    const pool = screen.getByRole("region", { name: "媒体池" });
    expect(within(pool).queryByRole("heading")).toBeNull();
    expect(within(pool).getByText("媒体池").className).toContain("ui-section-title");
  });
  ```
- [ ] 实现。`axNames.test.tsx` 的 `BANNED_ON_MAIN_SCREEN` 用例必须仍绿。
- [ ] 命令：`npx vitest run src/workspace/WorkspaceShell.test.tsx src/workspace/axNames.test.tsx src/workspace/EpisodeSwitcher.test.tsx && npm run lint`
- [ ] Commit：`style(workspace): 顶栏与栏标题条换套件按钮/节标题,顶栏抬起,栏面板分层`

#### Commit 2b — 分隔条 6px 可见抓手 + 状态条图标

**Files:**
- Modify `src/workspace/WorkspaceShell.tsx`（`Separator` 里渲染 `<span class="workspace-handle-grip" aria-hidden />`）
- Modify `src/workspace/StatusStrip.tsx`（短语前 `Icon`；库名前 `Icon check`）
- Modify `src/styles/workspace.css` 分节 3、4
- Modify `src/workspace/StatusStrip.test.tsx` `WorkspaceShell.test.tsx`

- [ ] 先红：
  ```tsx
  // WorkspaceShell.test.tsx 追加
  it("三条分隔条各有一个可见抓手,宽 6px 由令牌控制", () => {
    render(<WorkspaceShell />);
    for (const sep of screen.getAllByRole("separator")) {
      expect(sep.querySelector(".workspace-handle-grip")).not.toBeNull();
    }
    expect(WORKSPACE_CSS).toMatch(/--workspace-handle-size:\s*6px/);
    expect(WORKSPACE_CSS).toMatch(/\.workspace-handle:hover[^{]*\{[^}]*--accent/);
  });
  // StatusStrip.test.tsx 追加
  it("短语带图标:分析中 play、缺失素材 warning,库名前 check", async () => {
    apiMocks.getImportProgress.mockResolvedValue({ total: 60, done: 58, failed: 0, running: 1, waiting_for_permit: 0, paused_for_memory: false });
    apiMocks.listMissingClips.mockResolvedValue([{ clip_id: 1, file_name: "A.MP4", volume_uuid: "v", volume_label: null, rel_path: "A.MP4", missing_since: "" }]);
    render(<StatusStrip />);
    const strip = await screen.findByRole("status", { name: "后台状态" });
    await screen.findByText("分析 58/60");
    expect(screen.getByText("分析 58/60").querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("button", { name: /缺失素材 1/ }).querySelector("svg")).not.toBeNull();
    expect(strip.querySelector(".workspace-status-library svg")).not.toBeNull();
  });
  ```
- [ ] 实现。`StatusStrip.test.tsx` 现有 `describe("StatusStrip")` 若用的是自建 `vi.hoisted` 桩，改为 `createTestApiMock`（断言不减）。
- [ ] 命令：`npx vitest run src/workspace/StatusStrip.test.tsx src/workspace/WorkspaceShell.test.tsx`
- [ ] Commit：`style(workspace): 分隔条 6px 可见抓手(hover/拖动强调色),状态条短语带图标`

#### Commit 2c — 四栏空状态换 `EmptyState`

**Files:**
- Create `src/workspace/emptyStates.tsx`（~70 行：四个空状态的文案与图标常量 + `PoolEmpty` / `MonitorEmpty` / `BandEmpty` / `InspectorEmpty` 四个小组件）
- Modify `src/workspace/MediaPool.tsx`（无素材 / 筛选无命中两种）
- Modify `src/workspace/Monitor.tsx`（`Placeholder` 改用 `EmptyState tone="dark"`，井仍在——Task 3b 再做 16:9）
- Modify `src/workspace/ShotBand.tsx:357`（`band-empty` 改 `BandEmpty`）
- Modify `src/workspace/inspectorFields.tsx`（`EmptyInspectorNote` 改用 `InspectorEmpty`）
- Modify `src/workspace/MediaPool.test.tsx` `Monitor.test.tsx` `ShotBand.test.tsx` `Inspector.test.tsx`（追加）
- Modify `src/workspace/WorkspaceShell.test.tsx`（`getByRole("button",{name:"导入素材"})` → `getAllByRole(...)[0]`，并加一例）

- [ ] 先红：
  ```tsx
  // MediaPool.test.tsx 追加
  it("无素材时显示空状态:还没有素材 + 「导入素材」按钮打开导入抽屉", async () => {
    apiMocks.listClips.mockResolvedValue([]);
    render(<MediaPool />);
    expect(await screen.findByText("还没有素材")).toBeTruthy();
    within(screen.getByRole("region", { name: "媒体池" })).getByRole("button", { name: "导入素材" }).click();
    expect(getWorkspaceSnapshot().openDrawer).toBe("import");
  });
  it("筛选无命中时显示「没有匹配的素材」+ 清空筛选", async () => {
    __resetWorkspaceForTests({ filter: "rejected" });
    render(<MediaPool />); // fixture 里没有拒绝项
    expect(await screen.findByText("没有匹配的素材")).toBeTruthy();
    screen.getByRole("button", { name: "清空筛选" }).click();
    expect(getWorkspaceSnapshot().filter).toBe("all");
  });
  // Monitor.test.tsx 追加
  it("空选中的占位是 EmptyState(图标 + 标题 + 一句说明),不是空井", async () => {
    render(<Monitor />);
    const region = screen.getByRole("region", { name: "预览监视器" }) ?? document.body;
    expect(screen.getByText("从左侧媒体池选一条素材").tagName).toBe("P");
    expect(document.querySelector(".ui-empty svg")).not.toBeNull();
  });
  // ShotBand.test.tsx 追加
  it("无章节时显示 EmptyState「还没有章节」", async () => {
    apiMocks.getStoryboard.mockResolvedValue({ chapters: [], candidates: [], items: [] });
    render(<ShotBand />);
    expect(await screen.findByText("还没有章节")).toBeTruthy();
  });
  // Inspector.test.tsx 的「空选中时显示中性引导」用例改断言文案为「选一条素材查看详情」,并加:
  expect(document.querySelector(".ui-empty svg")).not.toBeNull();
  // WorkspaceShell.test.tsx 追加
  it("非空池时主屏只有一个「导入素材」按钮(顶栏)", async () => {
    render(<WorkspaceShell />);
    await screen.findAllByRole("gridcell");
    expect(screen.getAllByRole("button", { name: "导入素材" })).toHaveLength(1);
  });
  ```
- [ ] 实现。`Monitor.test` 既有「从左侧媒体池选一条素材」断言保留原句。
- [ ] `npm run preview:shots`，Read `01-workspace.png` `09-gap-slot.png` `08-narrow-1280.png`；报告 `.superpowers/sdd/r9-task-2-report.md` 列缺陷（预期仍有：井仍是米色、卡片文件名仍省略——那是 Task 3）。
- [ ] 命令：
  ```
  npx vitest run src/workspace
  npm run lint
  npm run preview:shots
  node scripts/qa/fast-gates.mjs && node -e "process.exit(require('./gate.json').status==='PASS'?0:1)"
  ```
- [ ] Commit：`feat(workspace): 四栏空状态换 EmptyState(图标+标题+说明+动作),空池可直接导入`

---

### Task 3: 媒体池 + 监视器

**依赖：** Task 1（与 Task 2/4 并行，只碰 `workspace.css` 分节 6、7）。`git worktree add ../tripcut-r9-t3 -b feat/r9-pool-monitor`

#### Commit 3a — 卡片两行文件名 + 元信息 + hover / 选中态 + Chip 筛选

**Files:**
- Modify `src/workspace/PoolCard.tsx`（删 `splitFileName`；用 `Card as="button" interactive selected`、`Badge`、`Icon star/heart/x`）
- Modify `src/workspace/poolModel.ts`（新增 `fileNameLines`）
- Modify `src/workspace/PoolFilters.tsx`（`Chip` + `Button ghost icon=chevron-down` 「更多筛选」；搜索框 `Icon search` 前缀）
- Modify `src/styles/workspace.css` 分节 6
- Modify `src/workspace/poolModel.test.ts`（若无则创建）、`MediaPool.test.tsx`

**Interfaces:**
```ts
// poolModel.ts
/** 两行文件名:在最接近中点的 `_` 处断;没有 `_` 就按中点断;第二行永远含扩展名。短名只有一行。 */
export function fileNameLines(name: string, maxLine = 18): [string, string | null];
```

- [ ] 先红 `src/workspace/poolModel.test.ts` 追加（迁移 `splitFileName` 的「扩展名总在」语义）：
  ```ts
  describe("fileNameLines", () => {
    it("在最接近中点的 _ 处断行,不做中段省略", () => {
      expect(fileNameLines("20260812_昆明长水机场_出发_01.MP4")).toEqual(["20260812_昆明长水机场_", "出发_01.MP4"]);
    });
    it("扩展名与序号永远在第二行末尾(迁自 splitFileName 的 tail 语义)", () => {
      const [, tail] = fileNameLines("DJI_20260812_083411_0003_D.MP4");
      expect(tail!.endsWith("_D.MP4")).toBe(true);
    });
    it("没有下划线就按中点断", () => {
      expect(fileNameLines("ABCDEFGHIJKLMNOPQRSTUVWX.MOV", 12)).toEqual(["ABCDEFGHIJKL", "MNOPQRSTUVWX.MOV"]);
    });
    it("短名只有一行", () => {
      expect(fileNameLines("C0047.MP4")).toEqual(["C0047.MP4", null]);
    });
  });
  ```
- [ ] 先红 `MediaPool.test.tsx` 追加：
  ```tsx
  it("卡片文件名分两行,不含省略号,title 是完整名", async () => {
    render(<MediaPool />);
    const cell = (await screen.findAllByRole("gridcell"))[0]!;
    const name = cell.querySelector(".pool-card-name")!;
    expect(name.textContent).not.toContain("…");
    expect(name.querySelectorAll(".pool-card-name-line").length).toBeGreaterThanOrEqual(1);
    expect(name.getAttribute("title")).toBe(fixtureClips[0]!.file_name);
  });
  it("卡片是套件 Card:interactive,选中时 selected class", async () => {
    render(<MediaPool />);
    const cell = (await screen.findAllByRole("gridcell"))[0]!;
    expect(cell.className).toContain("ui-card--interactive");
    cell.click();
    expect(cell.className).toContain("ui-card--selected");
  });
  it("评级用图标:收藏 heart、拒绝 x、星级实心 star", async () => {
    render(<MediaPool />);
    await screen.findAllByRole("gridcell");
    expect(document.querySelector(".pool-card-rating.favorite svg")).not.toBeNull();
    expect(document.querySelector(".pool-card-rating.rejected svg")).not.toBeNull();
    expect(document.querySelectorAll(".pool-card-rating.stars svg").length).toBeGreaterThan(0);
  });
  it("筛选 chips 是套件 Chip(aria-pressed),更多筛选带 chevron", async () => {
    render(<MediaPool />);
    expect((await screen.findByRole("button", { name: /^全部/ })).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "更多筛选" }).querySelector("svg")).not.toBeNull();
  });
  ```
  `MediaPool.test.tsx:105` 的 AX 名用例保持原样（`clipAriaLabel` 不变）。
- [ ] 实现（CSS：`.pool-card:hover { transform: translateY(-1px); border-color: var(--border-strong); box-shadow: var(--shadow-raised) }`、`.pool-card.ui-card--selected { box-shadow: var(--ring-selected) }`，两行 clamp）。
- [ ] 命令：`npx vitest run src/workspace/poolModel.test.ts src/workspace/MediaPool.test.tsx src/workspace/axNames.test.tsx && npm run lint`
- [ ] Commit：`style(pool): 卡片两行文件名(在 _ 断行,无中段省略)、图标评级、hover 上浮、选中双环,筛选条换 Chip`

#### Commit 3b — 监视器 16:9 深井 + 文件名 chip + 套件工具条

**Files:**
- Modify `src/workspace/Monitor.tsx`（井结构：`.monitor-stage > .monitor-well[16:9]`；`Placeholder` 深底 `EmptyState tone="dark" size="inline"`）
- Modify `src/workspace/MonitorControls.tsx`（`Toolbar` + `Button variant="icon" icon=…`；文字按钮 `❚❚ ▶ 🔇 🔊` 全部换图标；AX 名不变）
- Modify `src/PlayerOverlay.tsx`（**只**在 `variant="embedded"` 分支里把 viewport 矩形取自 `.monitor-well` 的 `getBoundingClientRect`——若现有实现已按容器 ref 取则不改；确认后写进报告）
- Modify `src/styles/workspace.css` 分节 7
- Modify `src/workspace/Monitor.test.tsx`

- [ ] 先红 `Monitor.test.tsx` 追加：
  ```tsx
  it("井是 16:9、深底、圆角 10、内阴影;文件名 chip 在井内左上", async () => {
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: fixtureClips[0]!.id } });
    render(<Monitor />);
    await screen.findByRole("button", { name: "播放" });
    const well = document.querySelector(".monitor-well")!;
    expect(well.className).toContain("monitor-well--video");
    expect(WORKSPACE_CSS).toMatch(/\.monitor-well\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9/);
    expect(WORKSPACE_CSS).toMatch(/\.monitor-well\s*\{[^}]*var\(--well-bg\)/);
    expect(WORKSPACE_CSS).toMatch(/\.monitor-well\s*\{[^}]*var\(--shadow-inset-well\)/);
    expect(well.querySelector(".monitor-well-name")!.className).toContain("ui-chip");
  });
  it("控件条是套件 Toolbar,走带按钮全是图标按钮且 AX 名不变", async () => {
    __resetWorkspaceForTests({ selection: { kind: "clip", clipId: fixtureClips[0]!.id } });
    render(<Monitor />);
    await screen.findByRole("button", { name: "播放" });
    for (const name of ["播放", "后退一秒", "前进一秒", "静音", "入点", "出点", "全屏沉浸"]) {
      const button = screen.getByRole("button", { name });
      expect(button.querySelector("svg"), name).not.toBeNull();
      expect(button.textContent?.replace(/\s/g, "")).not.toMatch(/[▶❚🔇🔊]/);
    }
    expect(screen.getByRole("button", { name: "保存片段" }).className).toContain("ui-button--primary");
    expect(document.querySelector(".ui-toolbar")).not.toBeNull();
  });
  ```
  `Monitor.test.tsx:150-260` 全部既有用例保持绿（AX 名、`formatTimecode`、I→O→S、沉浸态）。
- [ ] 实现。`npm run preview:shots`，Read `01-workspace.png` `02-selected.png` `04-inspector-open.png`：井是否深色 16:9 居中、chip 是否在井内、工具条图标是否清晰、卡片文件名是否可读。报告 `.superpowers/sdd/r9-task-3-report.md`，**必须写明**：假后端截不到 mpv 画面，真机 `playerSetViewport` 对齐待 Task 8 实机核。
- [ ] 命令：
  ```
  npx vitest run src/workspace/Monitor.test.tsx src/PlayerOverlay.test.tsx
  npm run lint
  npm run preview:shots
  node scripts/qa/fast-gates.mjs && node -e "process.exit(require('./gate.json').status==='PASS'?0:1)"
  ```
- [ ] Commit：`style(monitor): 16:9 深色 letterbox 井(圆角+内阴影),文件名 chip,走带/打点换套件工具条与图标`

---

### Task 4: 镜头带 + 检查器

**依赖：** Task 1（与 2/3 并行，只碰 `workspace.css` 分节 8、9）。`git worktree add ../tripcut-r9-t4 -b feat/r9-band-inspector`

#### Commit 4a — 镜头带：高度随内容、章节头工具条、常显滚动条、拖动 ghost

**Files:**
- Modify `src/workspace/shotBandModel.ts`（新增 `bandMinHeight(mode)` 与 `BAND_TILE_HEIGHT = 130`、`BAND_CHAPTER_HEAD_HEIGHT = 28`）
- Modify `src/workspace/ShotBand.tsx`（`band-viewport` 固定高；`DragOverlay` 渲染瓦片 ghost；插入线）
- Modify `src/workspace/BandChapters.tsx`（章节头 = `Toolbar dense` + `Badge`）
- Modify `src/workspace/BandSegment.tsx`（瓦片 = `Card interactive selected`；拖柄 `Icon grip`；空槽位按钮换 `Button`）
- Modify `src/workspace/WorkspaceShell.tsx`（中栏下 `Panel minSize={bandMinHeight(bandMode)}`）
- Modify `src/workspace/useBandDrag.ts`（暴露 `overKey`）
- Modify `src/styles/workspace.css` 分节 8
- Modify `src/workspace/shotBandModel.test.ts` `ShotBand.test.tsx`

**Interfaces:**
```ts
export function bandMinHeight(mode: BandMode): number; // story: 28+130+10+16 = 184; 其它: 284
```

- [ ] 先红：
  ```ts
  // shotBandModel.test.ts 追加
  it("镜头带最小高按内容算:故事模式 184,附属带展开 284", () => {
    expect(bandMinHeight("story")).toBe(184);
    for (const mode of ["music", "journey", "destination", "template"] as const) expect(bandMinHeight(mode)).toBe(284);
  });
  ```
  ```tsx
  // ShotBand.test.tsx 追加
  it("带视口高度固定为内容高,不随中栏撑开(瓦片下方不留白)", async () => {
    render(<ShotBand />);
    await screen.findAllByRole("gridcell");
    const viewport = document.querySelector<HTMLElement>(".band-viewport")!;
    expect(viewport.style.getPropertyValue("--band-content-height")).toBe("184px");
    expect(WORKSPACE_CSS).toMatch(/\.band-viewport\s*\{[^}]*height:\s*var\(--band-content-height\)/);
    expect(WORKSPACE_CSS).toMatch(/\.band-viewport\s*\{[^}]*overflow-x:\s*scroll/);
    expect(WORKSPACE_CSS).toMatch(/\.band-viewport\s*\{[^}]*scrollbar-gutter:\s*stable/);
  });
  it("章节头是 dense 工具条:序号 Badge、标题、时长、n 镜、缺口 Badge(warn)", async () => {
    render(<ShotBand />);
    const chapter = (await screen.findAllByRole("rowgroup"))[1]!; // 第 2 章有缺口
    const head = chapter.querySelector(".band-chapter-head")!;
    expect(head.className).toContain("ui-toolbar");
    expect(head.querySelector(".ui-badge--warn")!.textContent).toContain("缺口");
  });
  it("瓦片是 Card interactive;拖柄是 grip 图标且 AX 名不变", async () => {
    render(<ShotBand />);
    const cell = (await screen.findAllByRole("gridcell"))[0]!;
    expect(cell.className).toContain("ui-card--interactive");
    expect(screen.getAllByRole("button", { name: /^拖动 镜头/ })[0]!.querySelector("svg")).not.toBeNull();
  });
  it("拖动中 DragOverlay 是瓦片 ghost(含缩略图),源瓦片 dragging class", async () => {
    render(<ShotBand />);
    const cells = await screen.findAllByRole("gridcell");
    const handle = within(cells[0]!).getByRole("button", { name: /^拖动/ });
    fireEvent.pointerDown(handle, { clientX: 10, clientY: 10, button: 0, isPrimary: true });
    fireEvent.pointerMove(document, { clientX: 60, clientY: 12 });
    await waitFor(() => expect(document.querySelector(".band-drag-ghost img")).not.toBeNull());
    expect(cells[0]!.className).toContain("dragging");
    fireEvent.pointerUp(document);
  });
  ```
  `ShotBand.test.tsx` 既有 664 行用例（拖排回调、Take、空槽位、AX 名）全部保持。
- [ ] 实现。`bandMinHeight` 同时喂 `WorkspaceShell` 的 `Panel minSize`，中栏纵向分隔条拖到底就是内容高——多出的高度归监视器。
- [ ] 命令：`npx vitest run src/workspace/ShotBand.test.tsx src/workspace/shotBandModel.test.ts src/workspace/BandAccessory.test.tsx src/workspace/WorkspaceShell.test.tsx && npm run lint`
- [ ] Commit：`style(band): 带高随内容(184/284)不再留白,章节头工具条,瓦片 Card+grip,常显滚动条,拖动瓦片 ghost 与插入线`

#### Commit 4b — 检查器：隐藏空段、Take 缩略图条、chevron 折叠行

**Files:**
- Modify `src/workspace/inspectorModel.ts`（新增 `visibleDefaultSections`）
- Modify `src/workspace/Inspector.tsx`（默认层按 `visibleDefaultSections` 渲染；每段 `Card` + `SectionHeader size="pane"`）
- Modify `src/workspace/inspectorFields.tsx`（`RatingControls` 用 `Button secondary size=sm` + `Kbd`、五星 `Button icon star`；`TagsSection` 去掉占位句；`TakeSwitcher` 缩略图卡 96×54）
- Modify `src/workspace/InspectorSections.tsx`（`summary` 里 `Icon chevron-right` + 状态字；`GapInspector` 用 `Card` + `Button`）
- Modify `src/styles/workspace.css` 分节 9
- Modify `src/workspace/inspectorModel.test.ts`（若无则创建）、`Inspector.test.tsx`

**Interfaces:**
```ts
export type DefaultSectionId = "rating" | "tags" | "chapter" | "takes";
export function visibleDefaultSections(input: { tagCount: number; hasPlacement: boolean; canReassign: boolean; hasStack: boolean }): DefaultSectionId[];
// rating 永远在;tags 当 tagCount>0;chapter 当 hasPlacement||canReassign;takes 当 hasStack。顺序固定 rating→tags→chapter→takes。
```

- [ ] 先红：
  ```ts
  // inspectorModel.test.ts 追加
  describe("visibleDefaultSections(规格 §3.8:空段不渲染)", () => {
    it("全有时四段顺序固定", () => {
      expect(visibleDefaultSections({ tagCount: 3, hasPlacement: true, canReassign: true, hasStack: true })).toEqual(["rating", "tags", "chapter", "takes"]);
    });
    it("没标签、不在任何章、没有 Take 时只剩评级", () => {
      expect(visibleDefaultSections({ tagCount: 0, hasPlacement: false, canReassign: false, hasStack: false })).toEqual(["rating"]);
    });
    it("可改章但尚未归章时章节段仍显示(有事可做)", () => {
      expect(visibleDefaultSections({ tagCount: 0, hasPlacement: false, canReassign: true, hasStack: false })).toEqual(["rating", "chapter"]);
    });
  });
  ```
  ```tsx
  // Inspector.test.tsx:229「默认层四段顺序固定且永远展开」改为(断言不减,加 fixture 条件):
  it("有内容时默认层四段顺序固定且永远展开;空段不渲染,没有占位句", async () => {
    apiMocks.getAiDescription.mockResolvedValue({ description: "x", tags: ["机场", "出发", "清晨"], provider: "mock" });
    selectClipInStack(); // fixture:该 clip 在 stack 且在第 1 章
    render(<Inspector />);
    await screen.findByText("同镜头 Take 切换");
    const titles = [...document.querySelectorAll(".inspector-default-section .ui-section-title")].map((n) => n.textContent);
    expect(titles).toEqual(["评级与收藏", "标签", "所属章节 / 槽位", "同镜头 Take 切换"]);
    expect(screen.queryByText(/暂无标签/)).toBeNull();
    expect(screen.queryByText(/不属于任何 Take Stack/)).toBeNull();
  });
  it("没标签、没 Take 的素材只有评级段(与章节段,若可归章)", async () => {
    apiMocks.getAiDescription.mockResolvedValue(null);
    selectLoneClip();
    render(<Inspector />);
    await screen.findByText("评级与收藏");
    expect(screen.queryByText("标签")).toBeNull();
    expect(screen.queryByText("同镜头 Take 切换")).toBeNull();
  });
  // :304 「标签段渲染禁用的添加」保留,前置 mock tags 非空。
  it("折叠行:chevron 图标 + 段名 + 状态字;展开时 chevron 旋转 class", async () => {
    selectLoneClip();
    render(<Inspector />);
    const summary = await screen.findByText("技术检查");
    const row = summary.closest("summary")!;
    expect(row.querySelector("svg")).not.toBeNull();
    fireEvent.click(row);
    await waitFor(() => expect(row.closest("details")!.open).toBe(true));
    expect(row.querySelector(".inspector-chevron")!.className).toContain("is-open");
  });
  it("Take 条是缩略图卡,当前项 selected", async () => {
    selectClipInStack();
    render(<Inspector />);
    const strip = await screen.findByRole("group", { name: /的候选$/ });
    expect(strip.querySelectorAll("img").length).toBeGreaterThan(0);
    expect(strip.querySelector(".ui-card--selected")).not.toBeNull();
  });
  it("评级按钮带快捷键 Kbd,五星是图标按钮", async () => {
    selectLoneClip();
    render(<Inspector />);
    expect((await screen.findByRole("button", { name: "收藏" })).querySelector("kbd")!.textContent).toBe("F");
    expect(screen.getAllByRole("button", { name: /星$/ }).length).toBe(5);
  });
  ```
- [ ] 实现。`Inspector.test.tsx` 其余用例（summary 常驻、记忆、空槽位分支、状态字）保持绿。
- [ ] `npm run preview:shots`，Read `02-selected.png` `04-inspector-open.png` `01-workspace.png` `03-band-music.png`：带下方是否还有白、检查器是否还有占位句、折叠行 chevron 是否可见。报告 `.superpowers/sdd/r9-task-4-report.md`。
- [ ] 命令：
  ```
  npx vitest run src/workspace
  npm run lint
  npm run preview:shots
  node scripts/qa/fast-gates.mjs && node -e "process.exit(require('./gate.json').status==='PASS'?0:1)"
  ```
- [ ] Commit：`style(inspector): 空段不渲染(评级常驻/标签·章节·Take 按内容),Kbd 评级按钮与图标五星,Take 缩略图条,chevron 折叠行`

---

### Task 5: 导入抽屉原生化

**依赖：** Task 1。`git worktree add ../tripcut-r9-t5 -b feat/r9-import-drawer`

#### Commit 5a — 抽 `useImportSources` / `useImportJobs` / `useMissingMedia`,旧组件改为消费它们

**Files:**
- Create `src/workspace/import/useImportSources.ts`（~170 行）`useImportJobs.ts`（~230 行）`useMissingMedia.ts`（~80 行）`importModel.ts`（~60 行：`analysisProgress`、`batchStatusLabel`、`groupByVolume` 从旧文件移入）
- Create `src/workspace/import/useImportSources.test.tsx` `useImportJobs.test.tsx` `useMissingMedia.test.tsx`
- Modify `src/ImportPage.tsx`（`ImportPage()` 主体改为调 `useImportSources` + `useImportJobs`；`analysisProgress` / `PermitWaitingHint` 保留导出，`analysisProgress` 改为 re-export；JSX 一行不改）
- Modify `src/ImportManagement.tsx`（改为消费 `useImportJobs().batches/arm/...`；JSX 不改）
- Modify `src/MissingMediaPanel.tsx`（改为消费 `useMissingMedia`；JSX 不改）

**Interfaces:**
```ts
// useImportSources.ts
export interface ImportSources {
  watched: readonly WatchedFolder[]; notice: string | null; error: string | null; choosing: boolean;
  dragActive: boolean; toolchainMissing: boolean; folder: string | null;
  chooseFolder(): Promise<void>; rescan(): Promise<void>; setAutoSync(id: number, on: boolean): Promise<void>;
  remove(id: number): Promise<void>; refreshWatched(): Promise<void>;
}
export function useImportSources(options: { onImported?: () => void } = {}): ImportSources;
// useImportJobs.ts
export interface ImportJobs {
  progress: ImportProgress; clips: readonly ClipListItem[]; readyClips: readonly ClipListItem[];
  quality: AnalysisProgress; motion: AnalysisProgress; refreshError: string | null;
  batches: readonly ImportBatch[]; busy: boolean; notice: string | null;
  confirmation: { request: RemovalRequest; preview: RemovalPreview } | null;
  refresh(): Promise<void>; arm(request: RemovalRequest): void; confirmRemoval(): Promise<void>; cancelConfirmation(): void;
  cancelBatch(id: number): Promise<void>; dismissNotices(): Promise<void>;
}
export function useImportJobs(options: { onChanged?: () => void; pollMs?: number } = {}): ImportJobs;
// useMissingMedia.ts
export interface MissingMedia { clips: readonly MissingClip[]; groups: readonly VolumeGroup[]; busy: string | null; results: Record<string, RelinkOutcome>; notice: string | null; relink(volumeUuid: string): Promise<void>; refresh(): void; }
export function useMissingMedia(): MissingMedia;
```

- [ ] 先红 `useImportJobs.test.tsx`（断言**复制**自 `ImportPageRuntime.test.tsx:107-160` 与 `ImportManagement.test.tsx`）：
  ```tsx
  // @vitest-environment jsdom
  import { act, renderHook, waitFor } from "@testing-library/react";
  import { beforeEach, describe, expect, it, vi } from "vitest";
  const apiMock = await vi.hoisted(async () => (await import("../testApiMock")).createTestApiMock({}));
  vi.mock("../../api", () => apiMock);
  import { useImportJobs } from "./useImportJobs";

  beforeEach(() => {
    vi.useFakeTimers();
    apiMock.getClipsRevision.mockResolvedValue("rev-1");
    apiMock.listClips.mockResolvedValue([]);
    apiMock.getCurrentEpisode.mockResolvedValue({ id: 1 });
    apiMock.listImportBatches.mockResolvedValue([{ id: 7, source: "/fixture/card", status: "scanning", total: 2, done: 0, running: 1, failed: 0, duplicates: 0, imported: 1 }]);
    apiMock.previewImportRemoval.mockResolvedValue({ clips: 1, favorites: 2, selections: 1, cache_entries: 3 });
  });

  describe("useImportJobs(迁自 ImportPageRuntime.test / ImportManagement.test)", () => {
    it("revision 不变时跳过 listClips,只刷进度", async () => {
      const { result } = renderHook(() => useImportJobs({ pollMs: 1500 }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(apiMock.listClips).toHaveBeenCalledTimes(1);
      expect(apiMock.getImportProgress).toHaveBeenCalledTimes(2);
      expect(result.current.refreshError).toBeNull();
    });
    it("revision 变了就整表重拉", async () => {
      apiMock.getClipsRevision.mockResolvedValueOnce("rev-1").mockResolvedValueOnce("rev-2");
      renderHook(() => useImportJobs({ pollMs: 1500 }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(apiMock.listClips).toHaveBeenCalledTimes(2);
    });
    it("getClipsRevision 抛错回落全量,不卡死", async () => {
      apiMock.getClipsRevision.mockRejectedValue(new Error("boom"));
      renderHook(() => useImportJobs({ pollMs: 1500 }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(apiMock.listClips).toHaveBeenCalledTimes(2);
    });
    it("页面隐藏时停表,可见后立刻补跑", async () => {
      renderHook(() => useImportJobs({ pollMs: 1500 }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
      expect(apiMock.getImportProgress).toHaveBeenCalledTimes(1);
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(apiMock.getImportProgress).toHaveBeenCalledTimes(2);
    });
    it("arm 先预览不删;cancelConfirmation 后仍不删", async () => {
      const { result } = renderHook(() => useImportJobs());
      await act(async () => { result.current.arm({ batch_id: null, clip_ids: [5], all: false }); await vi.advanceTimersByTimeAsync(0); });
      expect(apiMock.previewImportRemoval).toHaveBeenCalledWith({ batch_id: null, clip_ids: [5], all: false });
      expect(result.current.confirmation?.preview.clips).toBe(1);
      act(() => result.current.cancelConfirmation());
      expect(apiMock.removeImportedMaterial).not.toHaveBeenCalled();
    });
    it("停止本批只 cancel,不删已入库;onChanged 被调", async () => {
      const onChanged = vi.fn();
      const { result } = renderHook(() => useImportJobs({ onChanged }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await result.current.cancelBatch(7); });
      expect(apiMock.cancelImportBatch).toHaveBeenCalledWith(7);
      expect(apiMock.removeImportedMaterial).not.toHaveBeenCalled();
      expect(onChanged).toHaveBeenCalled();
      expect(result.current.notice).toContain("已入库素材保留");
    });
    it("撤销本批只针对该批,通知带实际删除数", async () => {
      apiMock.removeImportedMaterial.mockResolvedValue(1);
      const { result } = renderHook(() => useImportJobs());
      await act(async () => { result.current.arm({ batch_id: 7, clip_ids: [], all: false }); await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await result.current.confirmRemoval(); });
      expect(apiMock.removeImportedMaterial).toHaveBeenCalledWith({ batch_id: 7, clip_ids: [], all: false });
      expect(result.current.notice).toContain("已移除 1 条素材");
    });
  });
  ```
- [ ] 先红 `useImportSources.test.tsx`（迁自 `ImportPageRuntime.test.tsx:161-202` 的拖放四例 + 关注文件夹操作）：
  ```tsx
  vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: (cb: (e: unknown) => void) => { dropHandler = cb; return Promise.resolve(() => { dropHandler = null; }); } }) }));
  let dropHandler: ((e: unknown) => void) | null = null;
  it("拖入高亮,松手导入并调 onImported,空 drop 只清高亮", async () => {
    apiMock.importPaths.mockResolvedValue([{ folder: "/a", total: 2, enqueued: 2, skipped: 0 }]);
    const onImported = vi.fn();
    const { result } = renderHook(() => useImportSources({ onImported }));
    await act(async () => { await Promise.resolve(); });
    act(() => dropHandler!({ payload: { type: "enter" } }));
    expect(result.current.dragActive).toBe(true);
    await act(async () => { dropHandler!({ payload: { type: "drop", paths: ["/a/1.mp4", "/a/2.mp4"] } }); await Promise.resolve(); await Promise.resolve(); });
    expect(apiMock.importPaths).toHaveBeenCalledWith(["/a/1.mp4", "/a/2.mp4"]);
    expect(result.current.dragActive).toBe(false);
    expect(result.current.notice).toBe("已发现 2 个视频，新增 2 项");
    expect(onImported).toHaveBeenCalled();
    act(() => dropHandler!({ payload: { type: "enter" } }));
    await act(async () => { dropHandler!({ payload: { type: "drop", paths: [] } }); });
    expect(apiMock.importPaths).toHaveBeenCalledTimes(1);
    expect(result.current.dragActive).toBe(false);
  });
  it("卸载后不再监听拖放", async () => {
    const { unmount } = renderHook(() => useImportSources());
    await act(async () => { await Promise.resolve(); });
    unmount();
    expect(dropHandler).toBeNull();
  });
  it("立即扫描:NAS 断线时说清「未扫描」而不是「没有新素材」", async () => {
    apiMock.rescanWatchedFolders.mockResolvedValue({ enqueued: 0, scanned: 1, unavailable: 1 });
    const { result } = renderHook(() => useImportSources());
    await act(async () => { await result.current.rescan(); });
    expect(result.current.notice).toBe("没有新素材;1 个文件夹当前不可用(未挂载或已移除),本轮未扫描");
  });
  it("选择文件夹:取消不启动导入;成功后通知含 skipped 说明", async () => {
    apiMock.pickImportFolder.mockResolvedValueOnce(null).mockResolvedValueOnce("/Volumes/CARD");
    apiMock.startImport.mockResolvedValue({ folder: "/Volumes/CARD", total: 5, enqueued: 3, skipped: 2 });
    const { result } = renderHook(() => useImportSources());
    await act(async () => { await result.current.chooseFolder(); });
    expect(apiMock.startImport).not.toHaveBeenCalled();
    await act(async () => { await result.current.chooseFolder(); });
    expect(result.current.notice).toBe("已发现 5 个视频，新增 3 项，跳过 2 项已入库或已排队素材（可能属于其他集）");
  });
  ```
- [ ] 先红 `useMissingMedia.test.tsx`（四例逐条复制 `MissingMediaPanel.test.tsx` 的语义：分组 / 空 / 重绑摘要 / 取消不调 relink）。
- [ ] 实现三个 hooks；旧三组件改为消费。**判据**：`npx vitest run src/ImportPage.test.tsx src/ImportPageRuntime.test.tsx src/ImportManagement.test.tsx src/MissingMediaPanel.test.tsx` **一行不改仍绿**。
- [ ] 命令：`npx vitest run src/workspace/import src/ImportPage.test.tsx src/ImportPageRuntime.test.tsx src/ImportManagement.test.tsx src/MissingMediaPanel.test.tsx && npm run typecheck && wc -l src/ImportPage.tsx`
- [ ] Commit：`refactor(import): 抽 useImportSources/useImportJobs/useMissingMedia,ImportPage/ImportManagement/MissingMediaPanel 改为消费(既有测试一行不改)`

#### Commit 5b — 原生 `ImportDrawer`：来源 / 任务 / 缺失素材

**Files:**
- Rewrite `src/workspace/ImportDrawer.tsx`（~90 行：`Drawer` + `Tabs` + 三分页懒切换）
- Create `src/workspace/import/ImportSourcesTab.tsx`（~170 行）`ImportJobsTab.tsx`（~220 行）`ImportMissingTab.tsx`（~110 行）
- Modify `src/styles/workspace.css` 分节 5（新增 `.import-drawer-*` 规则；删 `.workspace-drawer-body > .import-panel` 那段）
- Modify `src/workspace/ImportDrawer.test.tsx`（既有 8 例保留 + 追加）
- Modify `vite.config.ts`（`drawers` 组加 `workspace[\\/]import[\\/]`）

- [ ] 先红 `ImportDrawer.test.tsx` 追加：
  ```tsx
  it("来源分页:说明 + 「添加素材文件夹」primary + 关注文件夹卡(路径/上次同步/自动同步 switch/移除),没有英文 kicker", async () => {
    apiMocks.listWatchedFolders.mockResolvedValue([{ id: 1, path: "/Volumes/TRIP_2026", auto_sync: true, added_at: "", last_scan_at: "2026-09-11T08:00:00Z" }]);
    render(<WorkspaceShell />);
    screen.getByRole("button", { name: "导入素材" }).click();
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    expect(within(dialog).getByRole("button", { name: "添加素材文件夹" }).className).toContain("ui-button--primary");
    expect(await within(dialog).findByText("/Volumes/TRIP_2026")).toBeTruthy();
    expect(within(dialog).getByText("上次同步 2026-09-11 08:00")).toBeTruthy();
    expect(within(dialog).getByRole("switch", { name: "自动同步" }).getAttribute("aria-checked")).toBe("true");
    expect(within(dialog).getByRole("button", { name: "移除" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "立即扫描" })).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/SOURCE|WATCHED|INGEST/);
  });
  it("来源分页没有关注文件夹时显示 EmptyState", async () => {
    apiMocks.listWatchedFolders.mockResolvedValue([]);
    render(<WorkspaceShell />);
    screen.getByRole("button", { name: "导入素材" }).click();
    expect(await screen.findByText("还没有关注的文件夹")).toBeTruthy();
  });
  it("任务分页:进度卡三行阶段 + 批次卡「停止本批」/「撤销本批…」", async () => {
    apiMocks.getImportProgress.mockResolvedValue({ total: 60, done: 58, failed: 1, running: 1, waiting_for_permit: 0, paused_for_memory: false });
    apiMocks.listImportBatches.mockResolvedValue([{ id: 7, source: "/Volumes/CARD/2026-08-12", status: "scanning", total: 12, done: 10, running: 2, failed: 0, duplicates: 0, imported: 12 }]);
    __resetWorkspaceForTests({ openDrawer: "import", importTab: "jobs" });
    render(<WorkspaceShell />);
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    expect(await within(dialog).findByText("已处理 59 / 60")).toBeTruthy();
    for (const stage of ["索引", "画质分析", "运镜分析"]) expect(within(dialog).getByText(stage)).toBeTruthy();
    expect(within(dialog).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("59");
    expect(within(dialog).getByText("2026-08-12")).toBeTruthy();
    expect(within(dialog).getByText("正在扫描").className).toContain("ui-badge");
    expect(within(dialog).getByRole("button", { name: "停止本批" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "撤销本批…" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /移除选中/ })).toBeNull();
  });
  it("撤销本批走确认框(alertdialog「确认移除素材」,文案含「原视频不会删除」)", async () => {
    apiMocks.listImportBatches.mockResolvedValue([{ id: 7, source: "/x", status: "completed", total: 1, done: 1, running: 0, failed: 0, duplicates: 0, imported: 1 }]);
    apiMocks.previewImportRemoval.mockResolvedValue({ clips: 1, favorites: 0, selections: 0, cache_entries: 0 });
    __resetWorkspaceForTests({ openDrawer: "import", importTab: "jobs" });
    render(<WorkspaceShell />);
    (await screen.findByRole("button", { name: "撤销本批…" })).click();
    const confirm = await screen.findByRole("alertdialog", { name: "确认移除素材" });
    expect(confirm.textContent).toContain("原视频不会删除");
  });
  it("缺失素材分页:按卷分组 + 「重新定位」调 relinkVolume,结果摘要文案不变", async () => {
    apiMocks.listMissingClips.mockResolvedValue([{ clip_id: 1, file_name: "A.MOV", volume_uuid: "vol-1", volume_label: "SD Card", rel_path: "DCIM/A.MOV", missing_since: "" }]);
    apiMocks.pickRelinkFolder.mockResolvedValue("/Volumes/New");
    apiMocks.relinkVolume.mockResolvedValue({ relinked: 1, rejected: [], still_missing: 0 });
    __resetWorkspaceForTests({ openDrawer: "import", importTab: "missing" });
    render(<WorkspaceShell />);
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    expect(await within(dialog).findByText("SD Card")).toBeTruthy();
    expect(within(dialog).getByText("1 个文件缺失").className).toContain("ui-badge--warn");
    within(dialog).getByRole("button", { name: "重新定位" }).click();
    await waitFor(() => expect(apiMocks.relinkVolume).toHaveBeenCalledWith("vol-1", "/Volumes/New"));
    expect(await within(dialog).findByText(/已重绑 1/)).toBeTruthy();
  });
  it("没有缺失素材时显示「所有素材都在原位」", async () => {
    apiMocks.listMissingClips.mockResolvedValue([]);
    __resetWorkspaceForTests({ openDrawer: "import", importTab: "missing" });
    render(<WorkspaceShell />);
    expect(await screen.findByText("所有素材都在原位")).toBeTruthy();
  });
  it("拖入时抽屉内出现「松开即导入」覆盖层(role=status);平时不在树里", async () => {
    render(<WorkspaceShell />);
    screen.getByRole("button", { name: "导入素材" }).click();
    await screen.findByRole("dialog", { name: "导入素材" });
    expect(screen.queryByText("松开即导入")).toBeNull();
    act(() => dropHandler!({ payload: { type: "enter" } }));
    expect((await screen.findByRole("status", { name: "" })).textContent).toContain("松开即导入");
  });
  it("抽屉里不渲染素材清单(素材在媒体池)", async () => {
    render(<WorkspaceShell />);
    screen.getByRole("button", { name: "导入素材" }).click();
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    expect(dialog.querySelector(".import-list")).toBeNull();
  });
  ```
  既有 8 例（dialog / 三分页名 / Esc / 焦点回落 / dropOverlay.hidden / 宽度 / 任务入口）保持绿。`axNames.test.tsx` 里的 `@tauri-apps/api/webview` 桩现在给 hook 用，保留。
- [ ] 实现。`ImportDrawer.tsx` 不再 import `ImportPage` / `ImportManagement` / `MissingMediaPanel`。
- [ ] `npm run preview:shots`，Read `05-import-drawer.png`：无英文 kicker、卡片有层级、按钮统一、左内边距正常。报告 `.superpowers/sdd/r9-task-5-report.md`。
- [ ] 命令：
  ```
  npx vitest run src/workspace/ImportDrawer.test.tsx src/workspace/axNames.test.tsx src/workspace/import
  npm run lint && npm run build && node scripts/qa/check-chunks.mjs
  npm run preview:shots
  node scripts/qa/fast-gates.mjs && node -e "process.exit(require('./gate.json').status==='PASS'?0:1)"
  ```
- [ ] Commit：`feat(import): 导入抽屉原生重写——来源(关注文件夹卡+添加)/任务(进度卡三阶段+批次卡)/缺失素材(按卷重新定位),零英文 kicker`

---

### Task 6: 交付抽屉原生化

**依赖：** Task 1。`git worktree add ../tripcut-r9-t6 -b feat/r9-deliver-drawer`

#### Commit 6a — 抽 `useExportProgress` / `useDeliverForm`,`DeliverPage` 改为消费

**Files:**
- Create `src/workspace/deliver/useExportProgress.ts`（~110 行）`useDeliverForm.ts`（~200 行）`deliverModel.ts`（~90 行：`PLATFORM_LABELS`、`ROUGH_CUT_TARGET_*`、`closestTargetWithinBudget`、`presetBudgetSeconds`、`STAGE_LABELS`、`formatDuration`、`itemStatusLabel` 从 `DeliverPage` 移入并从那里 re-export）
- Create `src/workspace/deliver/useExportProgress.test.tsx` `useDeliverForm.test.tsx` `deliverModel.test.ts`
- Modify `src/DeliverPage.tsx`（`DeliverPage()` 改为 `const progress = useExportProgress(); const form = useDeliverForm(progress);` 然后原样喂 `DeliverView`；`DeliverView` 一行不改）

**Interfaces:**
```ts
export interface ExportProgress { status: ExportStatus; jobId: number | null; setJobId(id: number | null): void; setStatus(s: ExportStatus): void; refresh(): Promise<void>; active: boolean; }
export function useExportProgress(): ExportProgress; // 750ms(active)/2000ms 轮询 + tripcut:episode-changed 重置
export interface DeliverForm {
  episodePlatform: TargetPlatform; overridePlatform: TargetPlatform; setOverridePlatform(p: TargetPlatform): void;
  targetSeconds: TargetSecondsOption; setTargetSeconds(t: TargetSecondsOption): void;
  includeContactSheet: boolean; setIncludeContactSheet(v: boolean): void;
  jianying: JianyingAvailability; nativeBusy: boolean; nativeResult: JianyingDraftResult | null; nativeNotice: string | null;
  destination: string | null; busy: boolean; error: string | null; canGenerate: boolean; canGenerateNative: boolean;
  generate(): Promise<void>; generateNative(): Promise<void>; cancel(): Promise<void>; reveal(): Promise<void>;
}
export function useDeliverForm(progress: ExportProgress): DeliverForm; // 含 tripcut:action deliver-export、tripcut:deliver-availability 广播
```

- [ ] 先红 `useDeliverForm.test.tsx`（断言复制自 `DeliverPage.test.tsx:337-480`）：
  ```tsx
  it("override 默认等于本集平台;等于时 startExport 不传 platform", async () => {
    const { result } = renderHook(() => { const p = useExportProgress(); return useDeliverForm(p); });
    await waitFor(() => expect(result.current.overridePlatform).toBe("xiaohongshu"));
    await act(async () => { await result.current.generate(); });
    expect(apiMock.startExport).toHaveBeenCalledWith("/Volumes/DELIVERY", undefined, true, 60);
  });
  it("改成别的平台才把 overridePlatform 传给 startExport", async () => {
    const { result } = renderHook(() => { const p = useExportProgress(); return useDeliverForm(p); });
    await waitFor(() => expect(result.current.overridePlatform).toBe("xiaohongshu"));
    act(() => result.current.setOverridePlatform("douyin"));
    await act(async () => { await result.current.generate(); });
    expect(apiMock.startExport.mock.calls[0]![1]).toBe("douyin");
  });
  it("联系表默认勾选,关掉后传 false", async () => {
    const { result } = renderHook(() => { const p = useExportProgress(); return useDeliverForm(p); });
    await waitFor(() => expect(result.current.includeContactSheet).toBe(true));
    act(() => result.current.setIncludeContactSheet(false));
    await act(async () => { await result.current.generate(); });
    expect(apiMock.startExport.mock.calls[0]![2]).toBe(false);
  });
  it("平台预设无预算时默认「完整」(null);有预算时取不超预算的最大档", async () => {
    apiMock.listPlatformPresets.mockResolvedValue([]);
    const a = renderHook(() => { const p = useExportProgress(); return useDeliverForm(p); });
    await waitFor(() => expect(a.result.current.episodePlatform).toBe("xiaohongshu"));
    expect(a.result.current.targetSeconds).toBeNull();
    apiMock.listPlatformPresets.mockResolvedValue(platformPresets); // 90s 预算
    const b = renderHook(() => { const p = useExportProgress(); return useDeliverForm(p); });
    await waitFor(() => expect(b.result.current.targetSeconds).toBe(60));
  });
  it("剪映草稿失败自动降级为稳定包,notice 说明原因", async () => {
    apiMock.getJianyingAvailability.mockResolvedValue({ installed_version: "11.4", supported: true, reason: "" });
    apiMock.generateJianyingDraft.mockRejectedValue(new Error("字幕自检失败"));
    const { result } = renderHook(() => { const p = useExportProgress(); return useDeliverForm(p); });
    await waitFor(() => expect(result.current.jianying.supported).toBe(true));
    await act(async () => { await result.current.generateNative(); });
    expect(apiMock.startExport).toHaveBeenCalledTimes(1);
    expect(result.current.nativeNotice).toContain("已降级并开始生成稳定交付包");
  });
  it("挂载即广播 deliver-availability,卸载广播 false", async () => {
    const seen: boolean[] = [];
    window.addEventListener("tripcut:deliver-availability", (e) => seen.push((e as CustomEvent<boolean>).detail));
    const { unmount } = renderHook(() => { const p = useExportProgress(); return useDeliverForm(p); });
    await waitFor(() => expect(seen).toContain(true));
    unmount();
    expect(seen.at(-1)).toBe(false);
  });
  ```
- [ ] 先红 `useExportProgress.test.tsx`：
  ```tsx
  it("空闲 2s 一轮,进行中 750ms 一轮", async () => {
    vi.useFakeTimers();
    apiMock.getExportStatus.mockResolvedValue(idleStatus);
    renderHook(() => useExportProgress());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(apiMock.getExportStatus).toHaveBeenCalledTimes(2);
    apiMock.getExportStatus.mockResolvedValue({ ...idleStatus, status: "running", stage: "remuxing", job_id: 9 });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    const before = apiMock.getExportStatus.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(apiMock.getExportStatus.mock.calls.length).toBe(before + 1);
    vi.useRealTimers();
  });
  it("tripcut:episode-changed 清空 job 并重取", async () => {
    apiMock.getExportStatus.mockResolvedValue({ ...idleStatus, job_id: 9, status: "done", stage: "complete" });
    const { result } = renderHook(() => useExportProgress());
    await waitFor(() => expect(result.current.jobId).toBe(9));
    apiMock.getExportStatus.mockResolvedValue(idleStatus);
    act(() => { window.dispatchEvent(new Event("tripcut:episode-changed")); });
    await waitFor(() => expect(result.current.jobId).toBeNull());
  });
  ```
- [ ] 实现；**判据**：`npx vitest run src/DeliverPage.test.tsx` 一行不改仍绿。
- [ ] 命令：`npx vitest run src/workspace/deliver src/DeliverPage.test.tsx && npm run typecheck`
- [ ] Commit：`refactor(deliver): 抽 useExportProgress/useDeliverForm 与 deliverModel,DeliverPage 改为消费(既有测试一行不改)`

#### Commit 6b — 原生 `DeliverDrawer`：一张表单 + 进度卡 + 结果卡

**Files:**
- Rewrite `src/workspace/DeliverDrawer.tsx`（~60 行壳）
- Create `src/workspace/deliver/DeliverForm.tsx`（~150 行）`DeliverProgressCard.tsx`（~110 行）`DeliverResultCard.tsx`（~90 行）`DeliverContents.tsx`（~50 行：`<details>` 四条说明）
- Modify `src/styles/workspace.css` 分节 5
- Modify `src/workspace/DeliverDrawer.test.tsx`（既有 5 例保留 + 追加）
- Modify `vite.config.ts`（`drawers` 组加 `workspace[\\/]deliver[\\/]`）

- [ ] 先红 `DeliverDrawer.test.tsx` 追加：
  ```tsx
  it("表单四行:本次交付平台 Select、参考粗剪时长 Select、联系表.pdf switch、剪映草稿 switch(不支持时禁用并显示原因)", async () => {
    render(<WorkspaceShell />);
    screen.getByRole("button", { name: "生成交付包" }).click();
    const dialog = await screen.findByRole("dialog", { name: "生成交付包" });
    expect(within(dialog).getByRole("combobox", { name: "本次交付平台" }).tagName).toBe("SELECT");
    expect((within(dialog).getByRole("combobox", { name: "本次交付平台" }) as HTMLSelectElement).value).toBe("xiaohongshu");
    expect(within(dialog).getByRole("combobox", { name: "参考粗剪时长" })).toBeTruthy();
    expect(within(dialog).getByRole("switch", { name: "联系表.pdf" }).getAttribute("aria-checked")).toBe("true");
    const jianying = within(dialog).getByRole("switch", { name: "剪映草稿" });
    expect((jianying as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText("未检测")).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/DELIVERY ITEMS|ESTIMATED|STABLE PACKAGE|NATIVE DRAFT/);
  });
  it("交付项汇总是一行", async () => {
    render(<WorkspaceShell />);
    screen.getByRole("button", { name: "生成交付包" }).click();
    const dialog = await screen.findByRole("dialog", { name: "生成交付包" });
    expect(await within(dialog).findByText("4 项 · 3 段精选片段 · 1 条整条收藏 · 预计 3:05")).toBeTruthy();
  });
  it("主按钮「生成交付包」primary;点它选目录并 startExport", async () => {
    render(<WorkspaceShell />);
    screen.getByRole("button", { name: "生成交付包" }).click();
    const dialog = await screen.findByRole("dialog", { name: "生成交付包" });
    const button = within(dialog).getByRole("button", { name: "生成交付包" });
    expect(button.className).toContain("ui-button--primary");
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    button.click();
    await waitFor(() => expect(apiMock.startExport).toHaveBeenCalled());
  });
  it("进行中显示进度卡:阶段名 + progressbar + 每项状态 Badge + 取消", async () => {
    apiMock.getExportStatus.mockResolvedValue({ ...idleStatus, job_id: 9, status: "running", stage: "remuxing", completed_items: 1, failed_items: 1, items: [{ clip_id: 1, file_name: "A.MP4", status: "done", error: null }, { clip_id: 2, file_name: "B.MP4", status: "failed", error: "解码失败" }] as never });
    render(<WorkspaceShell />);
    screen.getByRole("button", { name: "生成交付包" }).click();
    const dialog = await screen.findByRole("dialog", { name: "生成交付包" });
    expect(await within(dialog).findByText("整理精选片段")).toBeTruthy();
    expect(within(dialog).getByRole("progressbar")).toBeTruthy();
    expect(within(dialog).getByText("失败").className).toContain("ui-badge--danger");
    expect(within(dialog).getByText("解码失败")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeTruthy();
  });
  it("完成后结果卡:交付完成 + 路径 + 「打开文件夹」调 revealExport", async () => {
    apiMock.getExportStatus.mockResolvedValue({ ...idleStatus, job_id: 9, status: "done", stage: "complete", output_path: "/Volumes/DELIVERY/EP05" });
    render(<WorkspaceShell />);
    screen.getByRole("button", { name: "生成交付包" }).click();
    const dialog = await screen.findByRole("dialog", { name: "生成交付包" });
    expect(await within(dialog).findByText("交付完成")).toBeTruthy();
    expect(within(dialog).getByText("/Volumes/DELIVERY/EP05")).toBeTruthy();
    within(dialog).getByRole("button", { name: "打开文件夹" }).click();
    await waitFor(() => expect(apiMock.revealExport).toHaveBeenCalledWith(9));
  });
  it("「交付包里有什么」是折叠段,默认收起,没有 01/02/03 水印", async () => {
    render(<WorkspaceShell />);
    screen.getByRole("button", { name: "生成交付包" }).click();
    const dialog = await screen.findByRole("dialog", { name: "生成交付包" });
    const details = dialog.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("交付包里有什么");
    expect(dialog.querySelector(".deliver-part-index")).toBeNull();
  });
  ```
  既有 5 例（滑入 + `本次交付平台` / Esc / 可见关闭 / 遮罩 / `联系表`）保持绿——`联系表` 由 switch 的 AX 名 `联系表.pdf` 命中 `getByText(/联系表/)`（若既有用例用的是 `getByLabelText("联系表")`，改成 `getByRole("switch",{name:"联系表.pdf"})`，断言不减）。
- [ ] 实现；`DeliverDrawer.tsx` 不再 import `DeliverPage`。
- [ ] `npm run preview:shots`，Read `06-deliver-drawer.png`。报告 `.superpowers/sdd/r9-task-6-report.md`。
- [ ] 命令：
  ```
  npx vitest run src/workspace/DeliverDrawer.test.tsx src/workspace/deliver src/workspace/axNames.test.tsx
  npm run lint && npm run build && node scripts/qa/check-chunks.mjs
  npm run preview:shots
  node scripts/qa/fast-gates.mjs && node -e "process.exit(require('./gate.json').status==='PASS'?0:1)"
  ```
- [ ] Commit：`feat(deliver): 交付抽屉原生重写——单表单(平台/时长/联系表/剪映)+一行汇总+主按钮,进度卡与结果卡(打开文件夹),说明折叠`

---

### Task 7: 设置 sheet 原生化

**依赖：** Task 1。`git worktree add ../tripcut-r9-t7 -b feat/r9-settings-sheet`

#### Commit 7a — 抽 `useSettingsForm`（保存队列 + 校验一字不动）,`SettingsPage` 改为消费

**Files:**
- Create `src/workspace/settings/useSettingsForm.ts`（~360 行）
- Create `src/workspace/settings/settingsModel.ts`（~80 行：`clampMinimaxBudgetInput`、`llmLedgerStatusLabel`、`generationLedgerStatusLabel`、`llmLedgerPurposeLabel`、`clockSourceLabel`、`bytesLabel`、`MINIMAX_*` 常量从 `SettingsPage` 移入并 re-export）
- Create `src/workspace/settings/useSettingsForm.test.tsx` `settingsModel.test.ts`
- Modify `src/SettingsPage.tsx`（`SettingsPage()` 主体状态全部换成 `const form = useSettingsForm();`，JSX 只改变量来源；导出面（`SETTINGS_SECTIONS`、`clampMinimaxBudgetInput` 等）保持）

**Interfaces:**
```ts
export interface SettingsForm {
  settings: SettingsMap; settingsLoaded: boolean; notice: string; rollbackNotice: string | null; busy: boolean;
  status: SettingsStatus | null; componentStatuses: ComponentStatus[]; appInfo: AppInfo | null;
  llmStatus: LlmStatus | null; llmLedger: LlmLedgerEntry[];
  minimaxHasKey: boolean; minimaxKeyDraft: string; setMinimaxKeyDraft(v: string): void; minimaxKeyBusy: boolean; minimaxKeyNotice: string | null;
  minimaxBudgetClampNote: string | null; generationStatus: GenerationAvailability | null; generationLedger: GenerationLedgerSummary | null;
  deviceClocks: DeviceClockSetting[]; clockDrafts: Record<string, string>; setClockDraft(model: string, v: string): void;
  updater: UpdaterView; cacheConfirm: boolean; workspaceV2: boolean;
  save(key: string, value: string): Promise<boolean>;   // 版本号 + 串行队列 + 失败回滚 + appearance 立即应用,逐字迁自 SettingsPage.tsx:625-660
  savePath(key: string, value: string): Promise<void>;
  saveMinimaxBudget(raw: string): Promise<void>;         // clampMinimaxBudgetInput + clamp note
  saveMinimaxKey(): Promise<void>; clearMinimaxKey(): Promise<void>;
  saveDeviceClock(model: string): Promise<void>;         // 秒数校验文案「设备时钟偏移必须是有效秒数」不变
  runSelfCheck(): Promise<void>; openLogs(): Promise<void>; clearCache(): Promise<void>;
  rollbackTool(componentId: string): Promise<void>;
  runUpdateCheck(): Promise<void>; runUpdateInstall(): Promise<void>; runRestart(): Promise<void>;
  toggleWorkspaceFlag(): Promise<void>;                  // 先落盘再广播 tripcut:workspace-flag-changed
  refreshStatus(): Promise<void>;
}
export function useSettingsForm(): SettingsForm;
```

- [ ] 先红 `useSettingsForm.test.tsx`：
  ```tsx
  it("载入合并 DEFAULT_SETTINGS 与库值,notice 变「设置已从本地项目载入」", async () => {
    apiMock.getSettings.mockResolvedValue({ "appearance.theme": "dark" });
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(result.current.settings["appearance.theme"]).toBe("dark");
    expect(result.current.notice).toBe("设置已从本地项目载入");
  });
  it("save 串行:第二条等第一条落定才发(SettingsPage.tsx:642 的队列语义)", async () => {
    const order: string[] = [];
    let release!: () => void;
    apiMock.setSetting.mockImplementation(async (key: string) => { order.push(`start:${key}`); if (key === "a") await new Promise<void>((r) => { release = r; }); order.push(`end:${key}`); });
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    const p1 = result.current.save("a", "1");
    const p2 = result.current.save("b", "2");
    await Promise.resolve();
    expect(order).toEqual(["start:a"]);
    release();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });
  it("save 失败回滚到已确认值,且旧失败不覆盖新成功(版本号)", async () => {
    apiMock.getSettings.mockResolvedValue({ "performance.worker_count": "4" });
    let rejectFirst!: (e: Error) => void;
    apiMock.setSetting.mockImplementationOnce(() => new Promise<void>((_, rej) => { rejectFirst = rej; })).mockResolvedValue(undefined);
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    const first = result.current.save("performance.worker_count", "6");
    const second = result.current.save("performance.worker_count", "8");
    rejectFirst(new Error("磁盘只读"));
    await first; await second;
    expect(result.current.settings["performance.worker_count"]).toBe("8");
    expect(result.current.notice).toBe("已保存，worker 并发将在重启后生效");
  });
  it("未载入前 save 返回 false 并提示", async () => {
    apiMock.getSettings.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useSettingsForm());
    expect(await result.current.save("x", "y")).toBe(false);
    expect(result.current.notice).toBe("核心设置尚未载入，暂不能编辑");
  });
  it("appearance.* 保存时立刻 applyAppearanceSettings", async () => {
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    await act(async () => { await result.current.save("appearance.theme", "dark"); });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
  it("月预算超 500 被夹住并给 clamp note", async () => {
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    await act(async () => { await result.current.saveMinimaxBudget("900"); });
    expect(apiMock.setSetting).toHaveBeenCalledWith("generation.minimax_monthly_budget_usd", "500");
    expect(result.current.minimaxBudgetClampNote).not.toBeNull();
  });
  it("设备时钟偏移不是数字时拒绝并提示", async () => {
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    act(() => result.current.setClockDraft("DJI Pocket 4", "abc"));
    await act(async () => { await result.current.saveDeviceClock("DJI Pocket 4"); });
    expect(apiMock.setDeviceClockOffset).not.toHaveBeenCalled();
    expect(result.current.notice).toBe("设备时钟偏移必须是有效秒数");
  });
  it("切换界面旗:先落盘再广播;写失败不广播", async () => {
    const seen: unknown[] = [];
    window.addEventListener("tripcut:workspace-flag-changed", (e) => seen.push((e as CustomEvent).detail));
    apiMock.setSetting.mockRejectedValueOnce(new Error("x")).mockResolvedValue(undefined);
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    await act(async () => { await result.current.toggleWorkspaceFlag(); });
    expect(seen).toEqual([]);
    await act(async () => { await result.current.toggleWorkspaceFlag(); });
    expect(seen).toEqual([{ workspaceV2: false }]);
  });
  ```
- [ ] 实现；**判据**：`npx vitest run src/SettingsPage.test.tsx src/HelpOverlay.test.tsx src/ReleaseFrontendFixes.test.tsx` 一行不改仍绿；`wc -l src/SettingsPage.tsx` 明显下降（目标 < 1250，仍是旧壳文件，不受 400 行限制——它在 R10 删）。
- [ ] 命令：`npx vitest run src/workspace/settings src/SettingsPage.test.tsx && npm run typecheck`
- [ ] Commit：`refactor(settings): 抽 useSettingsForm(串行保存队列/版本回滚/校验/updater/minimax/时钟 一字不动),SettingsPage 改为消费(既有测试一行不改)`

#### Commit 7b — 原生 `SettingsSheet` 壳 + 左 nav + 外观 / 性能 / 旅行时间 / 工具链

**Files:**
- Rewrite `src/workspace/SettingsSheet.tsx`（~110 行：`Sheet` + 内联 notice + `SettingsNav` + 右侧按 `activeSection` 渲染全部分区（滚动定位）+ `SettingsFormContext`）
- Create `src/workspace/settings/SettingsNav.tsx`（~70 行）`SettingsFormContext.ts`（~20 行）`AppearanceSection.tsx`（~110 行）`PerformanceSection.tsx`（~120 行）`TimelineSection.tsx`（~100 行）`ToolsSection.tsx`（~200 行：工具读数 / 组件回滚 / 自检）
- Modify `src/workspace/ui/icons.tsx`（九个 `settings-*` 图标已在 1b；此处不改）
- Modify `src/styles/workspace.css` 分节 5（`.settings-sheet-*`；删 `.settings-page--sheet` 那段）
- Modify `src/workspace/SettingsSheet.test.tsx`
- Modify `vite.config.ts`（`settings` 组加 `workspace[\\/]settings[\\/]`）

- [ ] 先红 `SettingsSheet.test.tsx` 追加（既有 2 例保留）：
  ```tsx
  it("标题栏下有内联 notice(role=status),左 nav 九项中文无 eyebrow,「缓存与重建」在最后且 danger", async () => {
    render(<WorkspaceShell />);
    screen.getByRole("button", { name: "设置" }).click();
    const dialog = await screen.findByRole("dialog", { name: "设置" });
    expect(within(dialog).getByRole("status").textContent).toMatch(/设置已从本地项目载入|正在读取本地设置/);
    const nav = within(dialog).getByRole("navigation", { name: "设置分类" });
    const items = within(nav).getAllByRole("button").map((b) => b.textContent);
    expect(items.at(-1)).toContain("缓存与重建");
    expect(within(nav).getAllByRole("button").at(-1)!.className).toContain("is-danger");
    expect(nav.textContent).not.toMatch(/APPEARANCE|PERFORMANCE|SETTINGS/);
    expect(dialog.textContent).not.toMatch(/\d\d \/ [A-Z]/);
  });
  it("外观分区:主题三段、缩放四段、界面开关(切回旧界面)", async () => {
    render(<WorkspaceShell />);
    screen.getByRole("button", { name: "设置" }).click();
    const dialog = await screen.findByRole("dialog", { name: "设置" });
    expect(within(dialog).getByRole("heading", { level: 3, name: "外观" })).toBeTruthy();
    for (const label of ["跟随系统", "浅色", "深色", "90%", "100%", "115%", "130%"]) expect(within(dialog).getByRole("button", { name: label })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "切回旧界面" })).toBeTruthy();
    within(dialog).getByRole("button", { name: "深色" }).click();
    await waitFor(() => expect(apiMock.setSetting).toHaveBeenCalledWith("appearance.theme", "dark"));
  });
  it("性能分区:worker 并发 Select、自动代理 Toggle", async () => {
    render(<WorkspaceShell />);
    screen.getByRole("button", { name: "设置" }).click();
    const dialog = await screen.findByRole("dialog", { name: "设置" });
    expect(within(dialog).getByRole("combobox", { name: "worker 并发" })).toBeTruthy();
    expect(within(dialog).getByRole("switch", { name: "自动生成 540p 代理" })).toBeTruthy();
  });
  it("工具链分区:ffmpeg/ffprobe 读数与「运行自检」", async () => {
    render(<WorkspaceShell />);
    screen.getByRole("button", { name: "设置" }).click();
    const dialog = await screen.findByRole("dialog", { name: "设置" });
    expect(await within(dialog).findByText(/ffmpeg/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /自检/ })).toBeTruthy();
  });
  ```
- [ ] 实现：各分区文件只从 `useSettingsFormContext()` 取；分区间用 `SectionHeader size="section"` + `Field`；文案从 `SettingsPage.tsx` 对应段**逐字**搬。
- [ ] 命令：`npx vitest run src/workspace/SettingsSheet.test.tsx src/workspace/axNames.test.tsx && npm run lint`
- [ ] Commit：`feat(settings): 设置 sheet 原生壳——内联 notice、九项中文 nav、外观/性能/旅行时间/工具链四分区用 Field 行`

#### Commit 7c — 分析与 AI / 云端补镜 / 隐私与诊断 / 帮助与关于 / 缓存与重建

**Files:**
- Create `src/workspace/settings/AnalysisSection.tsx`（~200 行：阈值 range 行 + LLM 开关 + 账本）`GenerationSection.tsx`（~220 行：MiniMax key / 预算 / 账本）`PrivacySection.tsx`（~120 行）`AboutSection.tsx`（~200 行：版本 / 更新检查三步 / 快捷键 / 许可折叠）`CacheSection.tsx`（~70 行）
- Modify `src/workspace/SettingsSheet.tsx`（挂上五段）
- Modify `src/workspace/SettingsSheet.test.tsx`（追加；**复制** `SettingsPage.test.tsx:181-330` 里 updater 与 MiniMax 的断言）

- [ ] 先红追加：
  ```tsx
  it("隐私与诊断 / 云端补镜 两个冒烟锚点在 sheet 里", async () => {
    render(<WorkspaceShell />);
    screen.getByRole("button", { name: "设置" }).click();
    const dialog = await screen.findByRole("dialog", { name: "设置" });
    expect(within(dialog).getByRole("heading", { level: 3, name: "隐私与诊断" })).toBeTruthy();
    expect(within(dialog).getByRole("heading", { level: 3, name: "云端补镜" })).toBeTruthy();
  });
  it("云端补镜:默认关闭、generated/ 持久提示、从不回显 key,保存后只显示「已配置」(迁自 SettingsPage.test R7 Task 7)", async () => {
    apiMock.hasMinimaxKey.mockResolvedValueOnce(false).mockResolvedValue(true);
    render(<WorkspaceShell />);
    screen.getByRole("button", { name: "设置" }).click();
    const dialog = await screen.findByRole("dialog", { name: "设置" });
    expect(await within(dialog).findByText(/generated\//)).toBeTruthy();
    const input = within(dialog).getByLabelText("MiniMax API Key") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-secret" } });
    within(dialog).getByRole("button", { name: "保存 Key" }).click();
    await waitFor(() => expect(apiMock.setMinimaxKey).toHaveBeenCalledWith("sk-secret"));
    expect(await within(dialog).findByText("已配置")).toBeTruthy();
    expect(dialog.textContent).not.toContain("sk-secret");
  });
  it("月预算输入 900 被夹到 500 并报告", async () => {
    render(<WorkspaceShell />);
    screen.getByRole("button", { name: "设置" }).click();
    const dialog = await screen.findByRole("dialog", { name: "设置" });
    const budget = await within(dialog).findByLabelText("月预算(美元)");
    fireEvent.change(budget, { target: { value: "900" } });
    fireEvent.blur(budget);
    await waitFor(() => expect(apiMock.setSetting).toHaveBeenCalledWith("generation.minimax_monthly_budget_usd", "500"));
    expect(within(dialog).getByText(/已按上限 500/)).toBeTruthy();
  });
  it("帮助与关于:「检查更新」按钮 + 常驻状态行;检查前没有安装/重启按钮", async () => {
    render(<WorkspaceShell />);
    screen.getByRole("button", { name: "设置" }).click();
    const dialog = await screen.findByRole("dialog", { name: "设置" });
    expect(within(dialog).getByRole("button", { name: "检查更新" })).toBeTruthy();
    expect(within(dialog).getByTestId("updater-status")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /安装|重启/ })).toBeNull();
  });
  it("缓存与重建:两次点击才执行,第一次提示确认", async () => {
    render(<WorkspaceShell />);
    screen.getByRole("button", { name: "设置" }).click();
    const dialog = await screen.findByRole("dialog", { name: "设置" });
    const button = within(dialog).getByRole("button", { name: "清理缓存并重建" });
    button.click();
    expect(apiMock.clearCacheAndRebuild).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("status").textContent).toContain("请再次点击确认");
    button.click();
    await waitFor(() => expect(apiMock.clearCacheAndRebuild).toHaveBeenCalled());
  });
  it("sheet 里没有任何英文 kicker / 序号水印", async () => {
    render(<WorkspaceShell />);
    screen.getByRole("button", { name: "设置" }).click();
    const dialog = await screen.findByRole("dialog", { name: "设置" });
    expect(dialog.textContent).not.toMatch(/\b(SETTINGS|APPEARANCE|PERFORMANCE|TOOLCHAIN|ANALYSIS|MINIMAX|PRIVACY|DIAGNOSTICS|HELP|ABOUT|CACHE|REBUILD|JOURNEY TIME)\b/);
  });
  ```
- [ ] 实现；`SettingsSheet.tsx` 不再 import `SettingsPage`。`updater-status` 用 `data-testid`（与 `SettingsPage.test` 同名）。
- [ ] `npm run preview:shots`，Read `07-settings-sheet.png`。报告 `.superpowers/sdd/r9-task-7-report.md`。
- [ ] 命令：
  ```
  npx vitest run src/workspace/SettingsSheet.test.tsx src/workspace/settings src/SettingsPage.test.tsx
  npm run lint && npm run build && node scripts/qa/check-chunks.mjs
  npm run preview:shots
  node scripts/qa/fast-gates.mjs && node -e "process.exit(require('./gate.json').status==='PASS'?0:1)"
  ```
- [ ] Commit：`feat(settings): 分析与 AI/云端补镜/隐私与诊断/帮助与关于/缓存与重建 五分区原生化,updater 与 MiniMax 断言迁入 sheet 测试`

---

### Task 8: 收口——冒烟 AX 核对 / 死规则清理 / 文档 / 报告

**依赖：** Task 1–7 全部合并到 `main`。**不开新 worktree，在 `main` 的 `chore/r9-wrapup` 上做。**

#### Commit 8a — 冒烟 AX 核对 + 校准

**Files:**
- Modify `scripts/qa/smoke-gui.mjs`（只改两处锚点：缺失素材按钮 `选择新位置` → `重新定位`（若脚本引用了它）；交付抽屉「联系表」断言改为 `getByRole switch 联系表.pdf` 语义——其余锚点一字不改）
- Modify `src/workspace/axNames.test.tsx`（追加：抽屉 / sheet 内冻结串用例）

- [ ] 先红 `axNames.test.tsx` 追加：
  ```tsx
  it("三个模态里的冒烟锚点一字不差", async () => {
    render(<WorkspaceShell />);
    dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: "source" });
    const importDialog = await screen.findByRole("dialog", { name: "导入素材" });
    for (const tab of ["来源", "任务", "缺失素材"]) expect(within(importDialog).getByRole("tab", { name: tab })).toBeTruthy();
    expect(screen.queryByText("松开即导入")).toBeNull();
    dispatchWorkspace({ type: "open-drawer", drawer: "deliver" });
    const deliver = await screen.findByRole("dialog", { name: "生成交付包" });
    expect(within(deliver).getByText("本次交付平台")).toBeTruthy();
    expect(within(deliver).getByRole("switch", { name: "联系表.pdf" })).toBeTruthy();
    dispatchWorkspace({ type: "open-drawer", drawer: "settings" });
    const settings = await screen.findByRole("dialog", { name: "设置" });
    expect(within(settings).getByText("隐私与诊断")).toBeTruthy();
    expect(within(settings).getByText("云端补镜")).toBeTruthy();
  });
  ```
- [ ] **校准**：临时把 `DeliverForm.tsx` 的 `本次交付平台` 改成 `本次交付平台2`，跑 `node scripts/qa/preview-shots.mjs` 确认第 06 步 FAIL；改回确认 PASS。不做这一步不许信绿。
- [ ] 报告里逐条列出冒烟锚点清单（顶栏 4 按钮 / 5 landmark / 5 tab / 三模态 9 串）与「R9 未改动」结论。
- [ ] 命令：`node --check scripts/qa/smoke-gui.mjs && npx vitest run src/workspace/axNames.test.tsx`
- [ ] Commit：`test(qa): R9 冻结串核对——顶栏/landmark/tab 未动,三模态锚点加入 axNames 测试,冒烟校准记录`

#### Commit 8b — `workspace.css` 死规则清理 + 令牌门禁打开

**Files:**
- Modify `src/styles/workspace.css`（删除被套件取代的规则：`.workspace-topbar-button*`、`.workspace-drawer-*`（已迁 `kit.css` 的 `.ui-modal-*`）、`.workspace-drawer-body > .import-panel`、`.settings-page--sheet`、`.monitor-button*`、`.band-drag-preview`、`.pool-card-name-head/-tail`、`.inspector-tags-empty`、`.band-empty`、`.monitor-placeholder*`；剩余规则的字面量 px / 颜色改成令牌）
- Modify `src/styles/tokens.test.ts`（`describe.todo` → `describe`）
- Modify `src/styles/kit.css`（同样过一遍令牌门禁——测试里把 `KIT` 也读进来）

- [ ] 先红：把 `tokens.test.ts` 第二组 `describe.todo` 改回 `describe`，并加 `kit.css` 同三条 → 跑，列出全部 offender。
- [ ] 逐条清理；死规则判据：`grep -rn "<class>" src/ --include=*.tsx` 为空才删。
- [ ] 跑 `axNames.test.tsx` 的 CSS 括号配平用例（R8 F-R8-5 的事故门禁）。
- [ ] 量：`wc -l src/styles/workspace.css`（预期从 2382 降到 < 1800）与 `npm run build` 后 `dist/assets/*.css` 体积，写进报告。
- [ ] 命令：
  ```
  npx vitest run src/styles/tokens.test.ts src/workspace/axNames.test.tsx
  npm run build && node scripts/qa/check-chunks.mjs
  ```
- [ ] Commit：`style(workspace): 清掉被套件取代的死规则,剩余值全部改令牌,令牌门禁测试打开`

#### Commit 8c — 文档

**Files:**
- Modify `docs/用户手册.md`、`docs/USER_GUIDE.md`（「界面导览」补三个模态的新结构：导入抽屉三分页、交付单表单、设置左 nav；截图引用换 R9 的 PNG）
- Create `docs/design/design-system.md`（令牌表 + 套件 API 表 + 「怎么加一个组件」四步 + `npm run preview:kit`）
- Modify `docs/superpowers/plans/2026-09-06-unattended-upgrade-master.md`（R9 勾选）
- Modify `src/helpContent.ts`（若「导入」帮助主题提到「选择新位置」改为「重新定位」）+ `src/HelpOverlay.test.tsx` 相应断言

- [ ] 命令：`npx vitest run src/HelpOverlay.test.tsx`
- [ ] Commit：`docs(r9): 设计系统文档,用户手册三个模态章节更新`

#### Commit 8d — 全量截图复核 + QA 报告 + R10 入口（版本保持 0.3.0）

**Files:**
- Create `docs/qa/2026-09-12-unattended-r9.md`（六节：目标与工作项 / 快照与测量 / 门禁记录 / FINDINGS / 被 revert 或冻结项 / 下一轮入口）
- Create `.superpowers/sdd/r9-visual-audit/final/`（`npm run preview:shots -- --kit` 的全部 PNG + `aria.yml` 拷入）
- **不改** `package.json` / `tauri.conf.json` / `Cargo.toml`（版本 0.3.0 不动，用 `grep -R '"version": "0.3.0"' package.json src-tauri/tauri.conf.json` 核一遍）

- [ ] `npm run preview:shots -- --kit`，Read 全部 12 张 PNG，报告 §4 FINDINGS 按图列「已解决 / 仍存在」两栏，逐条对照控制端诊断 (a)(b)(c)。
- [ ] 报告 §2 必须写：`workspace.css` 行数前后、CSS 产物体积前后、每个 chunk 大小、`SettingsPage.tsx` 行数前后、套件组件数 / 测试数、图标数。
- [ ] 报告 §4 必须记：mpv 井 16:9 的真机 `playerSetViewport` 对齐结论（有 Tauri 环境则实测，否则标「待实机」）；「暂停/继续」无 api 的记档；空池「导入素材」双按钮的取舍。
- [ ] R10 入口：① 删 `ui.workspace_v2` 旗；② 删 `LegacyShell` / `SidebarSearch` / `SelectPage` 容器 / `ImportPage` / `DeliverPage` / `SettingsPage` 本体（hooks 与 model 文件留下）；③ 删 `styles.css` 旧页面规则；④ 冒烟 `workspace.single_screen` 改为断言产物无 `LegacyShell-*.js`；⑤ 深色主题走查。
- [ ] 命令：
  ```
  node scripts/qa/fast-gates.mjs && node -e "process.exit(require('./gate.json').status==='PASS'?0:1)"
  npm run build && node scripts/qa/check-chunks.mjs
  npm run preview:shots -- --kit
  find src/workspace src/styles -name '*.ts*' -o -name '*.css' | xargs wc -l | awk '$1>=400 && $2!="total"{print "OVER 400:",$0; bad=1} END{exit bad}'
  ```
- [ ] Commit：`chore(r9): 界面成品化收口——全量截图复核,QA 报告,R10 删旧壳入口(版本保持 0.3.0)`

---

## R10 入口（R9 收尾时写下）

**启动前提：业主看过 0.3.0 预览（`docs/releases/v0.3.0.md` 的「界面成品化」一节）并
签字之后再开 R10。** 旧壳（`LegacyShell` + 旧四页）在 0.3.0 里是故意留着的「提意见的
窗口期」（发布说明原话）——业主可能会要求调整新界面的某处细节，甚至要求某个旧行为
搬回来；旧壳还在，回退成本就是切一个设置开关。R10 一旦删旧壳，这条退路就没有了，
所以不能在业主表态之前抢跑。R9 收口时的两处未定项（附属带默认高度、文件名裁切规则，
见 `docs/qa/2026-09-12-unattended-r9.md` §4/§5）本身也需要业主先拍板，作为 R10 的
输入之一。

1. 删旗 → 删旧壳与旧四页本体（`useImport*` / `useDeliverForm` / `useExportProgress` / `useSettingsForm` / `*Model.ts` 是新壳在用的，别连它们一起删）→ 清 `styles.css` → 冒烟 `single_screen` 改产物断言。
2. 深色主题只在 R9 令牌层保证可用；R10 用 `preview-shots` 加 `--dark`（`html[data-theme="dark"]`）再截一轮走查。
3. 「暂停 / 继续」导入队列若业主坚持要，需要一条 Rust 命令 `pause_import_queue`（R9 明确不做，记档）。
4. 顺带处理 R9 QA 报告 §5 里的开放项：mpv `playerSetViewport` 真机对齐、剪映 11.4.13189
   人眼核对、附属带默认高度、构建产物体积干净重测（`rm -rf dist && npm run build`）。
