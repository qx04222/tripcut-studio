# R8 导演台工作区 —— 单屏三栏界面重做 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 每个任务先写会红的测试，再写实现；每个 commit 都要能被单独否决而不拖垮同任务的其它 commit。

**Goal:** 把"四页 hash 路由 + 筛片页内两视图模式 + 故事板内侧标签"这套三层导航压成一屏三栏（媒体池 / 监视器+镜头带 / 检查器 + 顶栏 + 状态条），每条 Vlog 少几次点击。旧四页在 `ui.workspace_v2=false` 时仍可完整运行一个发行版，R9 删旗。

**Architecture:** 新增 `src/workspace/` 目录承载新壳：一个 `useSyncExternalStore` 的 `WorkspaceStore`（选择 / 栏尺寸 / 折叠 / 附属带模式 / 抽屉 / 检查器折叠段 / 筛选 / 焦点栏）+ 一个全应用唯一的 `useClipsFeed`（合并 `SelectPage.tsx:1165`、`ImportPage.tsx:520`、`useSearchAugment.ts:57` 三处 `getClipsRevision` 轮询）。三栏用已在用的 `react-resizable-panels` 的 `Group`/`Panel`/`Separator` 切分。监视器复用 `PlayerOverlay` 的同一个 mpv 通道（新增 `variant="embedded"`，不新开实例）。镜头带复用 `Storyboard.tsx` 的 `@dnd-kit` 拖排与 `setStoryOrder`/`undoStoryChange`。抽屉 / sheet 是既有页面主体（`ImportPage` / `DeliverPage` / `SettingsPage`）的模态包装，`React.lazy` 懒加载。`src/api.ts` 一行不改。

**Tech Stack:** React 19.2.8 + TypeScript 6.0.3 + Vite 8.2.2（rolldown）。`react-resizable-panels@^4.12.3`（**已是依赖**，`src/SelectPage.tsx:23` 已在用，`src/test-setup.ts:1` 已为它补了 jsdom 的 `ResizeObserver` polyfill，`src/licenses.generated.ts:370` 已收录 —— **本轮不新增任何 npm 依赖，也不自己写分隔条组件**）。`@dnd-kit/core@^6.3.1` + `@dnd-kit/sortable@^10.0.0` + `@dnd-kit/utilities@^3.2.2`（`src/Storyboard.tsx:1-2` 已在用）。`cmdk@^1.1.1`（⌘K，不换）。测试 vitest 4.1.11 + jsdom 30。焦点约束用既有 `src/useFocusTrap.ts` 的 `useFocusTrap(containerRef: RefObject<HTMLElement | null>, active: boolean): void`。

## Global Constraints

以下逐条抄自规格 §0/§5/§6/§7/§9，执行期间不得自行放宽：

- **不重写 Rust 核心。** `src-tauri` 本轮唯一改动是 `src-tauri/src/core/settings.rs` 的 `validate_setting` 增加一条 `ui.` 前缀白名单臂（Task 1a）。除此之外 `src-tauri/` 下的 `.rs` 一行不动，不加命令、不加迁移、不加表、不加列。`src-tauri/tauri.conf.json` 的 `minWidth`/`minHeight`/`version` 是配置改动，不算 Rust 代码改动。
- **`src/api.ts` 一行不改。** 新界面所需数据全部有现成命令（`list_clips`、`get_clips_revision`、`list_shot_stacks`、`get_storyboard`、`list_story_gaps`、`list_generation_requests`、`set_story_order`、`undo_story_change`、`set_shot_stack_user_state`、`rate_clip`、`player_*`、`get_settings`/`set_setting`、`get_import_progress`、`list_missing_clips`）。状态条的后台计数本轮在前端聚合，**不加 `get_job_summary`**（R9 再议）。
- **不改调色板。** 沿用 `src/styles.css:4-60` 的浅暖色 token，light/dark/system 机制与"浅色为默认"不变。强调色只有现有的一个绿（`--accent: #6d8f00`），不新增强调色。
- **中文标签，主屏不出现英文 kicker / eyebrow。** 删掉 `01 INGEST` / `SELECT` / `ROUGH CUT` / `CHINESE-CLIP · LOCAL` / `LIBRARY` / `TRIPCUT / LOCAL-FIRST` / `INSPECTOR` / `SELECTED / 当前素材` / `LOCAL SQLITE` 这类装饰性英文。缩写只保留技术必需者（LUT、AI、EP01、⌘K）。品牌字标 `TRIPCUT STUDIO` 只留在设置 sheet 的「关于」分区。
- **chunk 预算：每个 chunk < 500 kB**，用 §9 的新分组（Task 8b）。
- **`eslint-plugin-jsx-a11y` 零告警**（与现状一致，`npm run lint` 即覆盖）。
- **AX 名称一字不差**：顶栏按钮 `导入素材`、`生成交付包`、`设置`、`切换集`；栏 landmark `role="region" aria-label` 为 `媒体池`、`预览监视器`、`镜头带`、`检查器`、`后台状态`；附属带 `role="tablist" aria-label="镜头带附属视图"`，五个 tab 名 `故事` `音乐` `旅程` `地点卡` `模板`。这些串是冒烟脚本的锚点，改一个字就要同步改 `scripts/qa/smoke-gui.mjs`。
- **`ui.workspace_v2` 默认值分两段**：Task 1–5 期间前端默认常量为 `false`（`main` 始终可发布，新壳只能手动开），**Task 6d 才把默认翻成 `true`**。规格 §5 表里的"默认 `true`"指的是本轮终态。
- **每个新文件 < 400 行。** 超了就按规格 §11 的拆分表再拆，不许把两个职责塞进一个文件。
- **既有断言只迁移不删除。** `SelectPage.test.tsx` / `SelectPagePersistence.test.tsx` 里的断言按 §9 逐条搬进新组件测试，净断言数不允许下降；`Storyboard.test.tsx`、`MusicPanel.test.tsx`、`JourneyTimeline.test.tsx`、`TechCheckPanel.test.tsx`、`SimilarGroupsPanel.test.tsx`、`GenerationDialog.test.tsx`、`SettingsPage.test.tsx`、`DeliverPage.test.tsx` 的组件本体不改则测试不改。
- 提交带 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`；合并前 `node scripts/qa/fast-gates.mjs` 看 **`gate.json.status` 必须 PASS**（不许看管道尾巴的输出判绿）。
- 每条车道一个 `git worktree`，共用 `CARGO_TARGET_DIR`；并行度：Task 1 先行且独占；2 依赖 1；3 依赖 2；4 依赖 1+2+3；5 依赖 2+4；6 依赖 1（可与 4/5 并行）；7 依赖 1–6；8 收口。

### 已核实的事实（与规格/任务书的出入，执行前先读）

1. **`react-resizable-panels` 已经是依赖**（`package.json` dependencies `^4.12.3`，`package-lock.json:4507` 锁到 4.12.3，`node_modules/` 已装）。任务书里"package.json 没有这一条，要么自己写 80 行分隔条要么加依赖"的前提**不成立**。**决定：直接用既有依赖的 `Group`/`Panel`/`Separator`，不新增依赖，不自写分隔条。**`Panel` 的 `minSize`/`defaultSize` 在本仓库按 px 传（见 `SelectPage.tsx:2408` `defaultSize={280} minSize={210}`），中栏上下比按 §5 存 0–1 小数，落到 `Panel` 时换算成 px。
2. **`getSettings()` 返回 `SettingsMap = Record<string, string>`**（`src/api.ts:35,697`），其内容是 Rust 侧 `defaults()`（`src-tauri/src/core/settings.rs:126`）与 `settings` 表的并集。`ui.*` 键**不在** `defaults()` 里 —— 从未写过的 `ui.*` 键在返回值里**根本不存在**，不是空串。所以前端必须自己带默认值表（`UI_SETTING_DEFAULTS`），读法一律走 `readUiSetting(settings, key)`，不许 `settings["ui.x"] ?? ""`。
3. **`set_setting` 的键是白名单**（`settings.rs:255` `validate_setting` 的 `match key`，`:291` 兜底 `_ => false`），未知键返回 `CoreError::InvalidSchema("设置项 {key} 的值无效")` 并且**不写库**。所以 Task 1a 的白名单臂是整个 R8 能落地的前提，也是本轮**唯一**的 Rust 改动。
4. **现有 hash 路由只有四条**：`#/import` `#/review` `#/deliver` `#/settings`（`src/App.tsx:16` `RoutePath`、`:25` `NAVIGATION`、`:74` `routeFromHash`，非法/空 hash 一律落到 `/import`）。规格 §1.1 提到的 `#/recovery` **当前并不存在** —— `RecoveryPage` 由 `App()` 里的 doctor 报告状态决定（`src/App.tsx:343-356` `workbenchReady`），跟 hash 无关。本轮**不新增** `#/recovery`，保持 doctor 门控原样；规格那一格按"`RecoveryPage` 仍占满整窗"执行即可。
5. **现有热键处理器名**：`src/SelectPage.tsx:1820` 的 `handleKeyDown`（挂在 `film-grid-viewport` 上，入口守卫是 `:80` 的 `isFilmGridShortcutTarget(target, grid)`，语义是"只有事件目标就是网格本身才算"）、`:319` `ratingActionForKey(key, composing)`、`:331` `applyRatingAction`、`:305` `nextShotStackClipId`、`:1876/:1880` 的 `beginComposition`/`endComposition`（`compositionRef` + `composing` 双份，前者给同步读、后者驱动渲染）；`src/PlayerOverlay.tsx:42` `playerCommandsForKey`；`src/App.tsx:159` 的 `⌘\` 侧栏折叠；`src/CommandPalette.tsx:32` 的 `⌘K`。
6. **`@dnd-kit` 版本**：core `^6.3.1`、sortable `^10.0.0`、utilities `^3.2.2`。`Storyboard.tsx:1436` 用 `DndContext` + `PointerSensor`，`:1295` 用 `SortableContext` + `verticalListSortingStrategy`，`:350` 的 `useSortable`。镜头带改横向时 strategy 要换 `horizontalListSortingStrategy`（同包已导出，不加依赖）。
7. **`useFocusTrap` 在 `src/useFocusTrap.ts`**，签名 `useFocusTrap(containerRef: RefObject<HTMLElement | null>, active: boolean): void`；它**不拦 Esc**，Esc 各模态自理。
8. **规格 §9 说"组件本体不改则测试不改"与 Task 4 有轻微张力**：`Storyboard.tsx` 的 `DestinationCardEditor`（`:427`）、`MusicPanel`（`:1583`）、`JourneyTimeline`（`:1588`）搬进附属带时是**原样复用导出组件**、不改组件本体，所以这三份测试确实不改；改的只有 `Storyboard.tsx` 里的容器代码与 `Storyboard.test.tsx` 中断言"侧标签"结构的那几条（`:1460` `story-side-tabs`），那几条按 §9 的迁移纪律搬进 `BandAccessory.test.tsx`。

---

### Task 1: 工作区骨架（store + 顶栏 + 三栏 + 分隔条 + 状态条 + 旗）

**依赖：** 无。**独占车道**（改 `App.tsx` 与 `settings.rs`，其余任务全部挂在本任务产出的壳与 store 上）。
**worktree：** `git worktree add ../tripcut-r8-t1 -b feat/r8-shell`

#### Commit 1a — `ui.*` 设置键白名单（本轮唯一的 Rust 改动）

**Files:**
- Modify `src-tauri/src/core/settings.rs`：`validate_setting` 的 `match key`（函数在 `:255`，兜底臂 `_ => false` 在 `:291`）在 `WINDOW_*` 那条守卫臂之后、`_ => false` 之前插入 `ui.` 前缀臂；测试模块（`:742` 起，`connection_with_settings()` 在 `:742`）追加两个 `#[test]`。

**Interfaces:**
- Consumes：`fn validate_setting(key: &str, value: &str) -> Result<()>`（私有，签名不变）。
- Produces：`set_setting(connection, key, value)` 对任何 `key.starts_with("ui.")` 且 `value.len() <= 4096` 的键接受并落 `settings` 表；`get_settings` 因此把写过的 `ui.*` 键一并返回。**不进 `defaults()`** —— 没写过的 `ui.*` 键不出现在返回的 map 里（前端自带默认值，见事实 2）。

- [ ] 先红（`src-tauri/src/core/settings.rs` 测试模块末尾追加）：
  ```rust
      #[test]
      fn ui_prefixed_keys_are_accepted_and_round_trip() {
          let (_dir, connection) = connection_with_settings();
          set_setting(&connection, "ui.workspace_v2", "true").expect("ui.workspace_v2 应被接受");
          set_setting(&connection, "ui.pane.pool_width", "320").expect("ui.pane.pool_width 应被接受");
          set_setting(&connection, "ui.inspector.sections_open", "[\"techcheck\",\"similar\"]")
              .expect("JSON 值应被接受");
          let values = get_settings(&connection).expect("读设置");
          assert_eq!(values.get("ui.workspace_v2").map(String::as_str), Some("true"));
          assert_eq!(values.get("ui.pane.pool_width").map(String::as_str), Some("320"));
          assert_eq!(
              values.get("ui.inspector.sections_open").map(String::as_str),
              Some("[\"techcheck\",\"similar\"]")
          );
      }

      #[test]
      fn ui_keys_are_length_capped_and_unknown_prefixes_still_rejected() {
          let (_dir, connection) = connection_with_settings();
          let oversized = "x".repeat(4_097);
          assert!(set_setting(&connection, "ui.pool.filter", &oversized).is_err());
          assert!(set_setting(&connection, "uix.pool.filter", "all").is_err());
          assert!(set_setting(&connection, "workspace_v2", "true").is_err());
          // 被拒的写入一律不落库
          let values = get_settings(&connection).expect("读设置");
          assert!(values.keys().all(|key| !key.starts_with("uix.")));
          assert!(!values.contains_key("ui.pool.filter"));
      }
  ```
  跑 `cargo test --manifest-path src-tauri/Cargo.toml settings::tests::ui_` → 两条都红（`InvalidSchema`）。
- [ ] 实现（`validate_setting` 的 `match` 里，`WINDOW_*` 臂之后）：
  ```rust
          // R8:工作区的 UI 偏好(栏宽、折叠态、附属带模式、检查器折叠段等)走 settings 表
          // 存,好让偏好跟着素材库走而不是跟着这台机器走。键名一律 `ui.` 前缀,值当作
          // 不透明字符串(有的是 JSON 数组),只限长度,不限内容——限内容就等于把前端的
          // UI 结构复制一份进 Rust,那是 R8 明确不做的事(规格 §0「不重写 Rust 核心」)。
          key if key.starts_with("ui.") => value.len() <= 4_096,
  ```
- [ ] 复跑 `cargo test --manifest-path src-tauri/Cargo.toml settings::` → 全绿；确认 `defaults()`（`:126`）**未被改动**（`git diff` 里只有 `validate_setting` 与测试两处）。
- [ ] 命令：
  ```
  cargo test --manifest-path src-tauri/Cargo.toml settings::
  cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
  ```
- [ ] Commit：`feat(settings): 放行 ui.* 前缀的界面偏好键(4096 上限),R8 唯一的 Rust 改动`

#### Commit 1b — `WorkspaceStore` + `ui.*` 偏好读写

**Files:**
- Create `src/workspace/WorkspaceStore.ts`（~220 行）
- Create `src/workspace/uiSettings.ts`（~120 行）
- Create `src/workspace/WorkspaceStore.test.tsx`
- Create `src/workspace/uiSettings.test.ts`

**Interfaces:**
- Consumes：`getSettings(): Promise<SettingsMap>`、`setSetting(key: string, value: string): Promise<void>`（`src/api.ts:697,701`）；`SelectionFilter`、`ClipDimensionKey` 类型从 `src/api.ts` 导入（**不改** api.ts）。
- Produces（`WorkspaceStore.ts`）：
  ```ts
  export type Selection =
    | { kind: "clip"; clipId: number }
    | { kind: "slot"; chapterId: number; slot: string }
    | null;
  export type BandMode = "story" | "music" | "journey" | "destination" | "template";
  export type DrawerKind = "import" | "deliver" | "settings" | null;
  export type PaneId = "pool" | "monitor" | "band" | "inspector";

  export interface WorkspaceState {
    selection: Selection;
    anchorClipId: number | null;
    multiSelection: readonly number[];
    poolWidth: number;
    inspectorWidth: number;
    monitorRatio: number;
    poolCollapsed: boolean;
    inspectorCollapsed: boolean;
    bandMode: BandMode;
    openDrawer: DrawerKind;
    importTab: "source" | "jobs" | "missing";
    inspectorSections: readonly string[];
    filter: SelectionFilter;
    dimension: ClipDimensionKey | "";
    query: string;
    focusedPane: PaneId;
    immersive: boolean;
  }

  export type WorkspaceAction =
    | { type: "select-clip"; clipId: number; shift?: boolean; meta?: boolean }
    | { type: "select-slot"; chapterId: number; slot: string }
    | { type: "clear-selection" }
    | { type: "set-pane-size"; pane: "pool" | "inspector" | "monitor"; value: number }
    | { type: "toggle-pane"; pane: "pool" | "inspector" }
    | { type: "set-band-mode"; mode: BandMode }
    | { type: "open-drawer"; drawer: Exclude<DrawerKind, null>; tab?: WorkspaceState["importTab"] }
    | { type: "close-drawer" }
    | { type: "toggle-inspector-section"; id: string }
    | { type: "set-filter"; filter: SelectionFilter }
    | { type: "set-dimension"; dimension: ClipDimensionKey | "" }
    | { type: "set-query"; query: string }
    | { type: "focus-pane"; pane: PaneId }
    | { type: "cycle-pane-focus" }
    | { type: "set-immersive"; immersive: boolean }
    | { type: "hydrate"; settings: SettingsMap };

  export const INITIAL_WORKSPACE_STATE: WorkspaceState;
  export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState;
  /** reducer 之外的纯函数:这一次 action 产生了哪些需要落盘的 `ui.*` 键值对。 */
  export function persistedPairs(
    previous: WorkspaceState,
    next: WorkspaceState,
  ): ReadonlyArray<readonly [string, string]>;
  export function dispatchWorkspace(action: WorkspaceAction): void;
  export function subscribeWorkspace(listener: () => void): () => void;
  export function getWorkspaceSnapshot(): WorkspaceState;
  export function useWorkspace<T>(selector: (state: WorkspaceState) => T): T;
  export function __resetWorkspaceForTests(state?: Partial<WorkspaceState>): void;
  ```
- Produces（`uiSettings.ts`）：
  ```ts
  export const UI_SETTING_DEFAULTS: Readonly<Record<string, string>>; // 规格 §5 的九个键
  export const WORKSPACE_FLAG_KEY = "ui.workspace_v2";
  /** 读一个 `ui.*` 键:settings 里没有这个键时回落到 UI_SETTING_DEFAULTS,绝不返回 undefined。 */
  export function readUiSetting(settings: SettingsMap, key: string): string;
  export function readUiNumber(settings: SettingsMap, key: string): number;
  export function readUiBool(settings: SettingsMap, key: string): boolean;
  export function readUiList(settings: SettingsMap, key: string): string[];
  export interface UiSettingWriter {
    queue(key: string, value: string): void;
    flush(): Promise<void>;
    pendingCount(): number;
  }
  /** debounce 400ms + 串行队列(同 SettingsPage.tsx:670 的 saveQueueRef 模式)。 */
  export function createUiSettingWriter(
    write?: (key: string, value: string) => Promise<void>,
    delayMs?: number,
  ): UiSettingWriter;
  ```
  `UI_SETTING_DEFAULTS` 的初值（Task 1–5 期间）：
  ```ts
  export const UI_SETTING_DEFAULTS = {
    "ui.workspace_v2": "false", // Task 6d 翻成 "true"
    "ui.pane.pool_width": "320",
    "ui.pane.inspector_width": "340",
    "ui.pane.monitor_height": "0.55",
    "ui.pane.pool_collapsed": "false",
    "ui.pane.inspector_collapsed": "false",
    "ui.band.mode": "story",
    "ui.inspector.sections_open": "[]",
    "ui.pool.filter": "all",
    "ui.pool.dimension": "",
  } as const;
  ```

- [ ] 先红 `src/workspace/uiSettings.test.ts`：
  ```ts
  import { describe, expect, it, vi } from "vitest";
  import {
    UI_SETTING_DEFAULTS,
    createUiSettingWriter,
    readUiBool,
    readUiList,
    readUiNumber,
    readUiSetting,
  } from "./uiSettings";

  describe("readUiSetting", () => {
    it("键缺席时回落到默认值,而不是空串", () => {
      // get_settings 只返回 Rust defaults() 与 settings 表的并集;ui.* 不在 defaults() 里,
      // 从没写过的键根本不出现在 map 中(见计划「已核实的事实 2」)。
      expect(readUiSetting({}, "ui.pane.pool_width")).toBe("320");
      expect(readUiNumber({}, "ui.pane.monitor_height")).toBeCloseTo(0.55);
      expect(readUiBool({}, "ui.pane.pool_collapsed")).toBe(false);
      expect(readUiList({}, "ui.inspector.sections_open")).toEqual([]);
    });
    it("库里的值覆盖默认值", () => {
      expect(readUiNumber({ "ui.pane.pool_width": "460" }, "ui.pane.pool_width")).toBe(460);
      expect(readUiList({ "ui.inspector.sections_open": '["similar"]' }, "ui.inspector.sections_open"))
        .toEqual(["similar"]);
    });
    it("坏值回落默认而不是抛异常", () => {
      expect(readUiNumber({ "ui.pane.pool_width": "abc" }, "ui.pane.pool_width")).toBe(320);
      expect(readUiList({ "ui.inspector.sections_open": "{" }, "ui.inspector.sections_open")).toEqual([]);
    });
    it("九个偏好键都有默认值", () => {
      for (const key of Object.keys(UI_SETTING_DEFAULTS)) expect(readUiSetting({}, key)).not.toBe("");
    });
  });

  describe("createUiSettingWriter", () => {
    it("400ms 内同一个键连写只落一次,取最后一次的值", async () => {
      vi.useFakeTimers();
      const write = vi.fn().mockResolvedValue(undefined);
      const writer = createUiSettingWriter(write, 400);
      for (const width of [300, 320, 340, 360, 380]) writer.queue("ui.pane.pool_width", String(width));
      expect(write).not.toHaveBeenCalled(); // 拖分隔条期间一次都不写
      await vi.advanceTimersByTimeAsync(400);
      expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith("ui.pane.pool_width", "380");
      vi.useRealTimers();
    });
    it("不同键各自成条,但写入串行(前一条落定再发下一条)", async () => {
      vi.useFakeTimers();
      const order: string[] = [];
      let release: (() => void) | null = null;
      const write = vi.fn(async (key: string) => {
        order.push(`start:${key}`);
        if (key === "ui.pane.pool_width") await new Promise<void>((r) => { release = r; });
        order.push(`end:${key}`);
      });
      const writer = createUiSettingWriter(write, 400);
      writer.queue("ui.pane.pool_width", "320");
      writer.queue("ui.band.mode", "music");
      await vi.advanceTimersByTimeAsync(400);
      expect(order).toEqual(["start:ui.pane.pool_width"]); // 第二条还没发
      release?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual([
        "start:ui.pane.pool_width", "end:ui.pane.pool_width",
        "start:ui.band.mode", "end:ui.band.mode",
      ]);
      vi.useRealTimers();
    });
    it("一条写失败不卡死队列", async () => {
      vi.useFakeTimers();
      const write = vi.fn()
        .mockRejectedValueOnce(new Error("设置项无效"))
        .mockResolvedValue(undefined);
      const writer = createUiSettingWriter(write, 400);
      writer.queue("ui.band.mode", "music");
      await vi.advanceTimersByTimeAsync(400);
      writer.queue("ui.pool.filter", "favorite");
      await vi.advanceTimersByTimeAsync(400);
      expect(write).toHaveBeenCalledTimes(2);
      expect(writer.pendingCount()).toBe(0);
      vi.useRealTimers();
    });
  });
  ```
- [ ] 实现 `uiSettings.ts`（串行队列照搬 `SettingsPage.tsx:670-671` 的 `saveQueueRef.current = request.catch(() => undefined)` 模式）：
  ```ts
  export function createUiSettingWriter(
    write: (key: string, value: string) => Promise<void> = setSetting,
    delayMs = 400,
  ): UiSettingWriter {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const latest = new Map<string, string>();
    let queue: Promise<void> = Promise.resolve();
    let pending = 0;
    const send = (key: string) => {
      const value = latest.get(key);
      if (value === undefined) return;
      latest.delete(key);
      timers.delete(key);
      pending += 1;
      queue = queue
        .then(() => write(key, value))
        .catch(() => undefined) // 单条写失败不许卡死后面的键
        .finally(() => { pending -= 1; });
    };
    return {
      queue(key, value) {
        latest.set(key, value);
        const existing = timers.get(key);
        if (existing !== undefined) clearTimeout(existing);
        timers.set(key, setTimeout(() => send(key), delayMs));
      },
      flush() { for (const key of [...timers.keys()]) { clearTimeout(timers.get(key)!); send(key); } return queue; },
      pendingCount() { return pending + latest.size; },
    };
  }
  ```
- [ ] 先红 `src/workspace/WorkspaceStore.test.tsx`（reducer 是纯函数，直接测）：
  ```ts
  import { describe, expect, it } from "vitest";
  import {
    INITIAL_WORKSPACE_STATE as S0,
    persistedPairs,
    workspaceReducer as reduce,
  } from "./WorkspaceStore";

  describe("workspaceReducer 选择模型", () => {
    it("选素材记锚点,单选清空多选", () => {
      const s = reduce(S0, { type: "select-clip", clipId: 7 });
      expect(s.selection).toEqual({ kind: "clip", clipId: 7 });
      expect(s.anchorClipId).toBe(7);
      expect(s.multiSelection).toEqual([7]);
    });
    it("选空槽位后检查器进缺口分支,多选被清空", () => {
      const s = reduce(reduce(S0, { type: "select-clip", clipId: 7 }),
        { type: "select-slot", chapterId: 3, slot: "REAL/ESTABLISHING" });
      expect(s.selection).toEqual({ kind: "slot", chapterId: 3, slot: "REAL/ESTABLISHING" });
      expect(s.multiSelection).toEqual([]);
    });
    it("⌘ 点选累加,⇧ 连选取锚点到目标的闭区间,监视器只跟最后一次点击", () => {
      let s = reduce(S0, { type: "select-clip", clipId: 2 });
      s = reduce(s, { type: "select-clip", clipId: 5, meta: true });
      expect([...s.multiSelection].sort()).toEqual([2, 5]);
      expect(s.selection).toEqual({ kind: "clip", clipId: 5 }); // 锚点项 = 最后一次点击
    });
  });

  describe("workspaceReducer 栏尺寸与折叠", () => {
    it("栏宽被夹在规格 §2 的上下限内", () => {
      expect(reduce(S0, { type: "set-pane-size", pane: "pool", value: 100 }).poolWidth).toBe(260);
      expect(reduce(S0, { type: "set-pane-size", pane: "pool", value: 900 }).poolWidth).toBe(480);
      expect(reduce(S0, { type: "set-pane-size", pane: "inspector", value: 100 }).inspectorWidth).toBe(280);
      expect(reduce(S0, { type: "set-pane-size", pane: "inspector", value: 900 }).inspectorWidth).toBe(520);
    });
    it("中栏上下比是 0–1 小数并被夹住", () => {
      expect(reduce(S0, { type: "set-pane-size", pane: "monitor", value: 0.02 }).monitorRatio).toBeGreaterThan(0.1);
      expect(reduce(S0, { type: "set-pane-size", pane: "monitor", value: 3 }).monitorRatio).toBeLessThanOrEqual(0.9);
    });
    it("⌘1/⌘2 只折叠两侧栏,中栏没有折叠态", () => {
      expect(reduce(S0, { type: "toggle-pane", pane: "pool" }).poolCollapsed).toBe(true);
      expect(reduce(S0, { type: "toggle-pane", pane: "inspector" }).inspectorCollapsed).toBe(true);
    });
  });

  describe("workspaceReducer 焦点轮转(F6)", () => {
    it("按 媒体池→预览监视器→镜头带→检查器 循环", () => {
      const order = ["pool", "monitor", "band", "inspector", "pool"] as const;
      let s = { ...S0, focusedPane: "pool" as const };
      for (const expected of order.slice(1)) {
        s = reduce(s, { type: "cycle-pane-focus" });
        expect(s.focusedPane).toBe(expected);
      }
    });
    it("栏被折叠时跳过它", () => {
      const s = reduce({ ...S0, focusedPane: "band", inspectorCollapsed: true },
        { type: "cycle-pane-focus" });
      expect(s.focusedPane).toBe("pool");
    });
  });

  describe("workspaceReducer 检查器折叠段记忆", () => {
    it("逐段开合,顺序稳定", () => {
      let s = reduce(S0, { type: "toggle-inspector-section", id: "similar" });
      s = reduce(s, { type: "toggle-inspector-section", id: "techcheck" });
      expect(s.inspectorSections).toEqual(["similar", "techcheck"]);
      s = reduce(s, { type: "toggle-inspector-section", id: "similar" });
      expect(s.inspectorSections).toEqual(["techcheck"]);
    });
  });

  describe("hydrate 与回写", () => {
    it("从 settings 水合;缺席的键用默认值", () => {
      const s = reduce(S0, { type: "hydrate", settings: { "ui.band.mode": "music", "ui.pane.pool_width": "400" } });
      expect(s.bandMode).toBe("music");
      expect(s.poolWidth).toBe(400);
      expect(s.inspectorWidth).toBe(340);
    });
    it("只有真的变了的键才进回写清单,选择与焦点永不落盘", () => {
      const a = reduce(S0, { type: "set-band-mode", mode: "journey" });
      expect(persistedPairs(S0, a)).toEqual([["ui.band.mode", "journey"]]);
      const b = reduce(a, { type: "select-clip", clipId: 9 });
      expect(persistedPairs(a, b)).toEqual([]);
      const c = reduce(b, { type: "focus-pane", pane: "band" });
      expect(persistedPairs(b, c)).toEqual([]);
      const d = reduce(c, { type: "open-drawer", drawer: "import" });
      expect(persistedPairs(c, d)).toEqual([]); // 抽屉开合是会话态,不跟着库走
    });
    it("水合本身不产生回写(否则一启动就刷一轮设置表)", () => {
      const s = reduce(S0, { type: "hydrate", settings: { "ui.band.mode": "music" } });
      expect(persistedPairs(S0, s)).toEqual([]);
    });
  });
  ```
- [ ] 实现 `WorkspaceStore.ts`：模块级 `let state`、`Set<() => void> listeners`、`dispatchWorkspace` 里 `const next = workspaceReducer(state, action); const pairs = persistedPairs(state, next); state = next; for (const [k, v] of pairs) writer.queue(k, v); notify();`。`useWorkspace(selector)` 用 `useSyncExternalStore(subscribeWorkspace, () => selector(getWorkspaceSnapshot()), () => selector(INITIAL_WORKSPACE_STATE))`，selector 结果必须是标量或稳定引用（数组类选择器在调用点用 `useMemo` 包）。
- [ ] 命令：
  ```
  npx vitest run src/workspace/uiSettings.test.ts src/workspace/WorkspaceStore.test.tsx
  npm run typecheck
  ```
- [ ] Commit：`feat(workspace): WorkspaceStore 与 ui.* 偏好读写(400ms debounce + 串行队列)`

#### Commit 1c — 顶栏 + 三栏骨架 + 分隔条

**Files:**
- Create `src/workspace/TopBar.tsx`（~200 行）
- Create `src/workspace/WorkspaceShell.tsx`（~260 行）
- Create `src/styles/workspace.css`（本轮所有新壳样式都往这里加，`styles.css` 8069 行不重写）
- Create `src/workspace/WorkspaceShell.test.tsx`
- Modify `src/main.tsx`（引入 `./styles/workspace.css`，紧跟现有 `./styles.css` 之后）
- Modify `src-tauri/tauri.conf.json:18-19`（`"minWidth": 720` → `1280`，`"minHeight": 760` → `800`）

**Interfaces:**
- Consumes：`useWorkspace`、`dispatchWorkspace`（1b）。
- Produces：
  ```ts
  export function TopBar(): JSX.Element;
  export function WorkspaceShell(): JSX.Element;
  /** 窄窗收缩顺序的纯函数:先折检查器,再折媒体池,中栏永不折。 */
  export function autoCollapseFor(windowWidth: number): { pool: boolean; inspector: boolean };
  ```

- [ ] 先红 `src/workspace/WorkspaceShell.test.tsx`：
  ```tsx
  import { render, screen } from "@testing-library/react";
  import { describe, expect, it, beforeEach } from "vitest";
  import { WorkspaceShell, autoCollapseFor } from "./WorkspaceShell";
  import { __resetWorkspaceForTests } from "./WorkspaceStore";

  beforeEach(() => __resetWorkspaceForTests());

  describe("工作区骨架", () => {
    it("五个 landmark 的 AX 名一字不差且同屏并存(冒烟 workspace.panes.* 的依据)", () => {
      render(<WorkspaceShell />);
      for (const name of ["媒体池", "预览监视器", "镜头带", "检查器", "后台状态"]) {
        expect(screen.getByRole(name === "后台状态" ? "status" : "region", { name })).toBeTruthy();
      }
    });
    it("顶栏三个按钮的 AX 名一字不差,且没有四步导航", () => {
      render(<WorkspaceShell />);
      expect(screen.getByRole("button", { name: "导入素材" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "生成交付包" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "设置" })).toBeTruthy();
      expect(screen.queryByText("01 导入 INGEST")).toBeNull();
      expect(screen.queryByText(/INGEST|ROUGH CUT|LOCAL-FIRST/)).toBeNull();
    });
    it("两条分隔条是 ARIA separator 且带 aria-valuenow", () => {
      render(<WorkspaceShell />);
      const separators = screen.getAllByRole("separator");
      expect(separators.length).toBeGreaterThanOrEqual(3); // 左、右、中栏上下
      for (const sep of separators) expect(sep.getAttribute("aria-valuenow")).not.toBeNull();
    });
    it("收缩顺序:先检查器,再媒体池,中栏永不折", () => {
      expect(autoCollapseFor(1400)).toEqual({ pool: false, inspector: false });
      expect(autoCollapseFor(1160)).toEqual({ pool: false, inspector: true });
      expect(autoCollapseFor(900)).toEqual({ pool: true, inspector: true });
    });
    it("折叠后剩 44px 竖条,带「展开检查器」按钮", () => {
      __resetWorkspaceForTests({ inspectorCollapsed: true });
      render(<WorkspaceShell />);
      expect(screen.getByRole("button", { name: "展开检查器" })).toBeTruthy();
    });
  });
  ```
- [ ] 实现 `WorkspaceShell.tsx`（三栏用 `react-resizable-panels`，**不自写分隔条**）：
  ```tsx
  import { Group, Panel, Separator } from "react-resizable-panels";
  // 栏宽写 CSS 变量而不是 state,拖动期间不触发三栏重渲染(规格 §10);松手才 dispatch。
  <Group orientation="horizontal" className="workspace-columns">
    <Panel defaultSize={poolWidth} minSize={260} maxSize={480} collapsible
           onResize={(size) => shellRef.current?.style.setProperty("--pool-width", `${size}px`)}
           className="workspace-pool">
      <section role="region" aria-label="媒体池">{poolSlot}</section>
    </Panel>
    <Separator className="workspace-handle" aria-label="调整媒体池宽度" aria-valuenow={Math.round(poolWidth)} />
    <Panel minSize={520} className="workspace-center">
      <Group orientation="vertical">
        <Panel defaultSize={monitorRatio} minSize={240}>
          <section role="region" aria-label="预览监视器">{monitorSlot}</section>
        </Panel>
        <Separator className="workspace-handle horizontal" aria-label="调整监视器高度"
                   aria-valuenow={Math.round(monitorRatio * 100)} />
        <Panel minSize={bandMode === "story" ? 160 : 260}>
          <section role="region" aria-label="镜头带">{bandSlot}</section>
        </Panel>
      </Group>
    </Panel>
    <Separator className="workspace-handle" aria-label="调整检查器宽度" aria-valuenow={Math.round(inspectorWidth)} />
    <Panel defaultSize={inspectorWidth} minSize={280} maxSize={520} collapsible className="workspace-inspector">
      <section role="region" aria-label="检查器">{inspectorSlot}</section>
    </Panel>
  </Group>
  ```
  本 commit 四栏内容全部放占位块（「媒体池（Task 2）」等中文占位文案），可合并、可演示。
- [ ] `workspace.css`：只用 `styles.css:4-60` 已有的 token（`--bg`、`--bg-elevated`、`--border`、`--text-primary`、`--accent` …），**不新增颜色字面量**；密度按规格 §6（正文 13px / 行高 1.45、元信息 12px、栏标题 12px 加粗 letter-spacing .04em、控件 28px、顶栏按钮 30px、顶栏 44px、状态条 28px）。
- [ ] 命令：
  ```
  npx vitest run src/workspace/WorkspaceShell.test.tsx
  npm run lint
  ```
- [ ] Commit：`feat(workspace): 顶栏与三栏骨架——react-resizable-panels 分隔条、五个 landmark、最小窗口 1280×800`

#### Commit 1d — 状态条 + 旗分流 + 旧 hash 重定向

**Files:**
- Create `src/workspace/StatusStrip.tsx`（~140 行）
- Create `src/workspace/StatusStrip.test.tsx`
- Modify `src/App.tsx`：`AppShell`（`:117`）之外新增按旗分流；`routeFromHash`（`:74`）/`useHashRoute`（`:81`）保留，新壳下把四条旧 hash 翻译成抽屉动作；`App()`（`:327`）在 `workbenchReady` 之后读 `getSettings()` 判旗（现有 `:348` 已经在读 `getSettings().then(applyAppearanceSettings)`，把同一份结果复用，不多发一次请求）。
- Modify `src/App.test.tsx`（42 行，追加旗开/旗关两例）

**Interfaces:**
- Consumes：`getImportProgress(): Promise<ImportProgress>`（`src/api.ts:801`，字段 `{ total, done, failed, running, waiting_for_permit, paused_for_memory }`）、`listMissingClips(): Promise<MissingClip[]>`（`:820`）、`listGenerationRequests(): Promise<GenerationRequestSummary[]>`（`:1291`，`status` 为 `"queued" | "submitted" | …`）。
- Produces：
  ```ts
  export interface BackgroundSummary {
    analyzed: number; analyzeTotal: number; transcribing: number; generating: number; missing: number;
  }
  /** 纯函数:按存在性依次生成中文短语,全 0 时返回 ["后台空闲"]。 */
  export function summaryPhrases(summary: BackgroundSummary): string[];
  export function StatusStrip(): JSX.Element;
  /** 旧 hash → 新壳动作;无法识别的 hash 落到工作区本体。 */
  export function drawerForLegacyHash(hash: string): DrawerKind; // 在 WorkspaceShell.tsx 导出
  ```

- [ ] 先红 `src/workspace/StatusStrip.test.tsx`：
  ```tsx
  import { render, screen } from "@testing-library/react";
  import { describe, expect, it, vi } from "vitest";
  import { StatusStrip, summaryPhrases } from "./StatusStrip";
  import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./WorkspaceStore";

  describe("summaryPhrases", () => {
    it("按存在性依次显示中文短语", () => {
      expect(summaryPhrases({ analyzed: 12, analyzeTotal: 500, transcribing: 3, generating: 1, missing: 2 }))
        .toEqual(["分析 12/500", "转写 3", "云端生成 1 排队", "缺失素材 2"]);
    });
    it("为 0 的项不出现", () => {
      expect(summaryPhrases({ analyzed: 500, analyzeTotal: 500, transcribing: 0, generating: 0, missing: 2 }))
        .toEqual(["分析 500/500", "缺失素材 2"]);
    });
    it("全空显示「后台空闲」单行", () => {
      expect(summaryPhrases({ analyzed: 0, analyzeTotal: 0, transcribing: 0, generating: 0, missing: 0 }))
        .toEqual(["后台空闲"]);
    });
  });

  describe("StatusStrip", () => {
    it("整条是 role=status 且 AX 名为「后台状态」", async () => {
      render(<StatusStrip />);
      expect(screen.getByRole("status", { name: "后台状态" })).toBeTruthy();
    });
    it("点整条打开导入抽屉的「任务」分页", async () => {
      __resetWorkspaceForTests();
      render(<StatusStrip />);
      (await screen.findByRole("button", { name: "查看后台任务详情" })).click();
      expect(getWorkspaceSnapshot().openDrawer).toBe("import");
      expect(getWorkspaceSnapshot().importTab).toBe("jobs");
    });
    it("点「缺失素材 n」直接落到缺失素材分页", async () => {
      __resetWorkspaceForTests();
      render(<StatusStrip />);
      (await screen.findByRole("button", { name: /缺失素材/ })).click();
      expect(getWorkspaceSnapshot().importTab).toBe("missing");
    });
  });
  ```
- [ ] 先红 `src/App.test.tsx` 追加：
  ```tsx
  it("ui.workspace_v2=false 渲染旧四页壳", async () => {
    vi.mocked(getSettings).mockResolvedValue({ "ui.workspace_v2": "false" });
    render(<App />);
    expect(await screen.findByText("01 导入 INGEST")).toBeTruthy();
  });
  it("ui.workspace_v2=true 渲染新壳,四步导航不再出现", async () => {
    vi.mocked(getSettings).mockResolvedValue({ "ui.workspace_v2": "true" });
    render(<App />);
    expect(await screen.findByRole("region", { name: "媒体池" })).toBeTruthy();
    expect(screen.queryByText("01 导入 INGEST")).toBeNull();
  });
  it("ui.workspace_v2 缺席时用前端默认值(本阶段为旧壳)", async () => {
    vi.mocked(getSettings).mockResolvedValue({});
    render(<App />);
    expect(await screen.findByText("01 导入 INGEST")).toBeTruthy();
  });
  it("新壳下 #/deliver 打开交付抽屉而不是换页", async () => {
    window.location.hash = "#/deliver";
    vi.mocked(getSettings).mockResolvedValue({ "ui.workspace_v2": "true" });
    render(<App />);
    expect(await screen.findByRole("dialog", { name: "生成交付包" })).toBeTruthy();
  });
  ```
  （第四例在 Task 6 之前会因为抽屉还是占位而红 —— 本 commit 先只断言 `getWorkspaceSnapshot().openDrawer === "deliver"`，Task 6b 再升级成上面的 dialog 断言。）
- [ ] 实现：`drawerForLegacyHash`：`#/import` → `"import"`、`#/deliver` → `"deliver"`、`#/settings` → `"settings"`、`#/review` 与其它 → `null`。新壳挂载时读一次 hash 派发，并继续监听 `hashchange`；**不改写 hash**（规格 §1「抽屉不改 hash」）。
- [ ] 状态条轮询：3s，一次 `Promise.allSettled([getImportProgress(), listMissingClips(), listGenerationRequests()])`，`document.visibilityState === "hidden"` 时停表（照抄 `SelectPage.tsx:1216-1240` 的 visibility 停表写法）。
- [ ] 「中文输入法组合中」提示条按规格 §3.2 落在状态条右侧（本 commit 只留槽位与样式，真值由 Task 3c 的 `useRatingHotkeys` 灌入）。
- [ ] 命令：
  ```
  npx vitest run src/workspace/StatusStrip.test.tsx src/App.test.tsx
  node scripts/qa/fast-gates.mjs && cat gate.json | head -20
  ```
- [ ] Commit：`feat(workspace): 状态条与 ui.workspace_v2 旗分流,旧 hash 重定向为抽屉(默认仍走旧壳)`

---

### Task 2: 媒体池

**依赖：** Task 1。**worktree：** `git worktree add ../tripcut-r8-t2 -b feat/r8-pool`

#### Commit 2a — `useClipsFeed`：全应用唯一的 clips 轮询

**Files:**
- Create `src/workspace/useClipsFeed.ts`（~180 行）
- Create `src/workspace/useClipsFeed.test.tsx`
- Modify `src/useSearchAugment.ts:31`（`POLL_INTERVAL_MS` 注释与 `:57` `fetchAugmentData` 改为消费 feed 的 revision，不再自己调 `getClipsRevision`）
- Modify `src/useSearchAugment.test.tsx`（把"自己轮询"的断言改成"跟随 feed 刷新"，断言条数不减）

**Interfaces:**
- Consumes：`getClipsRevision(): Promise<string>`（`src/api.ts:837`）、`listClips(): Promise<ClipListItem[]>`（`:829`）、`listShotStacks(): Promise<ShotStack[]>`（`:920`）、`getStoryboard(): Promise<Storyboard>`（`:946`）、`listStoryGaps(): Promise<StoryGap[]>`（`:1234`）、`listClipDimensions()`、`listAssetSafety()`。
- Produces：
  ```ts
  export interface ClipsFeed {
    clips: readonly ClipListItem[];
    clipsById: ReadonlyMap<number, ClipListItem>;
    shotStacks: readonly ShotStack[];
    shotStackByClipId: ReadonlyMap<number, ShotStack>;
    storyboard: Storyboard | null;
    gaps: readonly StoryGap[];
    dimensions: readonly ClipDimension[];
    assetSafety: AssetSafetyInfo | null;
    revision: string | undefined;
    loading: boolean;
    error: string | null;
  }
  export function useClipsFeed(): ClipsFeed;
  export function subscribeClipsFeed(listener: () => void): () => void;
  export function getClipsFeedSnapshot(): ClipsFeed;
  /** 立刻重取一次(评级/拖排等本地写入之后调),force 时跳过 revision 比较。 */
  export function refreshClipsFeed(force?: boolean): Promise<void>;
  /** 本地乐观更新一条素材,不等下一轮轮询(沿用 SelectPage.tsx:331 applyRatingAction 的语义)。 */
  export function patchClipInFeed(clipId: number, patch: Partial<ClipListItem>): void;
  export function __resetClipsFeedForTests(): void;
  ```

- [ ] 先红 `src/workspace/useClipsFeed.test.tsx`（断言逐条迁移自 `SelectPagePersistence.test.tsx` 与 `ImportPageRuntime.test.tsx` 的同类用例）：
  ```tsx
  it("revision 没变就跳过 listClips 整表拉取,但仍刷新其余元数据", async () => {
    vi.mocked(getClipsRevision).mockResolvedValue("rev-1");
    await refreshClipsFeed();
    await refreshClipsFeed();
    expect(vi.mocked(listClips)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(listShotStacks)).toHaveBeenCalledTimes(2);
  });
  it("revision 变了就整表重拉", async () => {
    vi.mocked(getClipsRevision).mockResolvedValueOnce("rev-1").mockResolvedValueOnce("rev-2");
    await refreshClipsFeed();
    await refreshClipsFeed();
    expect(vi.mocked(listClips)).toHaveBeenCalledTimes(2);
  });
  it("拿修订号本身失败就当作变了,退回全量拉取,不卡死轮询", async () => {
    vi.mocked(getClipsRevision).mockRejectedValue(new Error("boom"));
    await refreshClipsFeed();
    await refreshClipsFeed();
    expect(vi.mocked(listClips)).toHaveBeenCalledTimes(2);
    expect(getClipsFeedSnapshot().error).toBeNull(); // 降级不是错误状态
  });
  it("三栏各订阅一次,底下只有一次真正的网络拉取", async () => {
    const A = () => { useClipsFeed(); return null; };
    render(<><A /><A /><A /></>);
    await waitFor(() => expect(vi.mocked(listClips)).toHaveBeenCalledTimes(1));
  });
  it("页面隐藏时停表,可见后立刻补跑一次", async () => { /* 迁移自 SelectPagePersistence.test.tsx 的 visibility 用例 */ });
  it("patchClipInFeed 就地改一条,不触发网络", () => {
    patchClipInFeed(7, { binary_rating: 1 });
    expect(getClipsFeedSnapshot().clipsById.get(7)?.binary_rating).toBe(1);
    expect(vi.mocked(listClips)).not.toHaveBeenCalled();
  });
  it("listShotStacks 失败不拖垮 clips(allSettled 语义)", async () => {
    vi.mocked(listShotStacks).mockRejectedValue(new Error("x"));
    await refreshClipsFeed();
    expect(getClipsFeedSnapshot().clips.length).toBeGreaterThan(0);
  });
  ```
- [ ] 实现：模块级单例（照 `useSearchAugment.ts:41-52` 的 `let state / listeners / inFlight / pendingForce` 形态，含它那条被吞掉的强制刷新要补跑的修正），间隔 2000ms，`useSyncExternalStore` 暴露。
- [ ] `useSearchAugment.ts` 改为 `subscribeClipsFeed` + 只在 revision 变化时重建拼音索引；它原有的 `tripcut:view-episode` / `tripcut:episode-changed` 强制刷新监听保留。
- [ ] 命令：
  ```
  npx vitest run src/workspace/useClipsFeed.test.tsx src/useSearchAugment.test.tsx
  ```
- [ ] Commit：`feat(workspace): useClipsFeed——全应用唯一的 clips 修订轮询,三处旧轮询合并到此`

#### Commit 2b — `useSelection`：跨栏回显与多选锚点

**Files:**
- Create `src/workspace/useSelection.ts`（~140 行）
- Create `src/workspace/useSelection.test.tsx`

**Interfaces:**
  ```ts
  export interface SelectionView {
    selection: Selection;
    selectedClip: ClipListItem | null;
    selectedStack: ShotStack | null;
    selectedStackMember: ShotStackMember | null;
    selectedGap: StoryGap | null;
    multiSelection: readonly number[];
    selectClip(clipId: number, modifiers?: { shift?: boolean; meta?: boolean }): void;
    selectSlot(chapterId: number, slot: string): void;
    clear(): void;
  }
  export function useSelection(): SelectionView;
  /** 纯函数:⇧ 连选 / ⌘ 点选的结果,锚点永远是最后一次点击。 */
  export function extendMultiSelection(
    visibleIds: readonly number[],
    current: readonly number[],
    anchor: number | null,
    next: number,
    modifiers: { shift?: boolean; meta?: boolean },
  ): { ids: number[]; anchor: number };
  /** 回显目标的 DOM id;两栏用同一套 id 规则,scrollIntoView 才能互相找到。 */
  export function echoElementId(selection: Selection, pane: "pool" | "band"): string | null;
  ```

- [ ] 先红：
  ```ts
  it("⇧ 连选取可见顺序里锚点到目标的闭区间", () => {
    const r = extendMultiSelection([1,2,3,4,5], [2], 2, 4, { shift: true });
    expect(r.ids).toEqual([2,3,4]); expect(r.anchor).toBe(4);
  });
  it("⇧ 反向连选同样闭区间", () => {
    expect(extendMultiSelection([1,2,3,4,5], [4], 4, 2, { shift: true }).ids).toEqual([2,3,4]);
  });
  it("⌘ 点选切换单项,已选则移除", () => {
    expect(extendMultiSelection([1,2,3], [1,2], 2, 2, { meta: true }).ids).toEqual([1]);
  });
  it("裸点清空多选", () => {
    expect(extendMultiSelection([1,2,3], [1,2], 2, 3, {}).ids).toEqual([3]);
  });
  it("两栏的回显 id 规则一致,互相找得到", () => {
    expect(echoElementId({ kind: "clip", clipId: 7 }, "pool")).toBe("pool-clip-7");
    expect(echoElementId({ kind: "clip", clipId: 7 }, "band")).toBe("band-clip-7");
    expect(echoElementId({ kind: "slot", chapterId: 3, slot: "ATMOSPHERE" }, "band")).toBe("band-slot-3-ATMOSPHERE");
    expect(echoElementId({ kind: "slot", chapterId: 3, slot: "ATMOSPHERE" }, "pool")).toBeNull();
  });
  it("选中镜头带里的空槽位时 selectedClip 为 null 而 selectedGap 非空", () => { /* 渲染断言 */ });
  it("多选时监视器与检查器只跟锚点项", () => { /* selection.clipId === 最后一次点击 */ });
  ```
- [ ] 实现：`useSelection` 从 `useClipsFeed` + `useWorkspace` 组合派生，`scrollIntoView({ block: "nearest" })` 在 `useEffect` 里按 `echoElementId` 查另一栏的元素（查不到就静默跳过，虚拟化下这是正常情形）。
- [ ] 命令：`npx vitest run src/workspace/useSelection.test.tsx`
- [ ] Commit：`feat(workspace): useSelection——clip/slot 两类选择、⇧⌘ 多选锚点、跨栏回显`

#### Commit 2c — `MediaPool`：搜索 + 筛选 + 虚拟网格

**Files:**
- Create `src/workspace/MediaPool.tsx`（~380 行）
- Create `src/workspace/MediaPool.test.tsx`
- Modify `src/workspace/WorkspaceShell.tsx`（把媒体池占位换成 `<MediaPool />`）
- Modify `src/SelectPage.tsx`：**不删**（旗关时仍要能跑），但把 `:105` `filmRowTop` / `:109` `filmRowAtOffset` / `:119` `filmGridColumnCount` / `:156` `filterSelectionClips` / `:182` `filterClipsByDimension` / `:202` `isPortraitClip` / `:208` `filterClipsByOrientation` / `:152` `isSuspectedWaste` / `:254` `buildShotStackWallItems` 这些**纯函数**移到新建的 `src/workspace/poolModel.ts` 并从 `SelectPage.tsx` re-export，两壳共用同一份实现（搬迁不改行为，`SelectPage.test.tsx` 对这些函数的断言原样通过）
- Create `src/workspace/poolModel.ts`（纯函数容器，~200 行）

**Interfaces:**
- Consumes：`useClipsFeed()`、`useSelection()`、`useWorkspace`；`searchClips`、`searchTranscripts`（`src/api.ts`，签名不变）。
- Produces：
  ```ts
  export function MediaPool(): JSX.Element;
  // poolModel.ts(全部搬自 SelectPage.tsx,签名逐字不变):
  export function filmRowTop(row: number, expandedRow: number | null): number;
  export function filmRowAtOffset(offset: number, expandedRow: number | null): number;
  export function filmGridColumnCount(viewportWidth: number): number;
  export function filterSelectionClips(/* 原签名 */): ClipListItem[];
  export function filterClipsByDimension(/* 原签名 */): ClipListItem[];
  export function filterClipsByOrientation(/* 原签名 */): ClipListItem[];
  export function isPortraitClip(clip: Pick<ClipListItem, "rotation" | "width" | "height">): boolean;
  export function isSuspectedWaste(clip: ClipListItem): boolean;
  export function buildShotStackWallItems(/* 原签名 */): FilmWallItem[];
  export const FILM_GRID_MIN_WIDTH = 280;
  /** 新增:栏宽 260–480 下的列数,按规格 §1.1 夹在 2–4 列。 */
  export function poolColumnCount(paneWidth: number): 2 | 3 | 4;
  ```

- [ ] 先红 `src/workspace/MediaPool.test.tsx`：
  ```tsx
  it("网格是 role=grid,AX 名为「媒体池」,卡片是 gridcell", () => {
    render(<MediaPool />);
    expect(screen.getByRole("grid", { name: "媒体池" })).toBeTruthy();
    expect(screen.getAllByRole("gridcell").length).toBeGreaterThan(0);
  });
  it("卡片 AX 名为「{文件名} · {时长} · {评级}」", async () => {
    expect(await screen.findByRole("gridcell", { name: "DJI_0001.MP4 · 00:12 · 收藏" })).toBeTruthy();
  });
  it("列数随栏宽在 2–4 之间自适应", () => {
    expect(poolColumnCount(260)).toBe(2);
    expect(poolColumnCount(340)).toBe(3);
    expect(poolColumnCount(480)).toBe(4);
  });
  it("500 条只渲染视口内的行 + 2 行 overscan", async () => {
    // 迁移自 SelectPage.test.tsx 的虚拟化断言
    expect(screen.getAllByRole("gridcell").length).toBeLessThan(60);
    expect(screen.getByRole("grid").getAttribute("data-total-clips")).toBe("500");
  });
  it("缩略图带 loading=lazy 与 decoding=async", () => { /* 规格 §10 */ });
  it("筛选条折叠成一行 chips,其余进「更多筛选」popover", async () => {
    expect(screen.getByRole("button", { name: "更多筛选" })).toBeTruthy();
  });
  it("主屏不出现英文 kicker", () => {
    expect(screen.queryByText("CHINESE-CLIP · LOCAL")).toBeNull();
    expect(screen.queryByText("LIBRARY")).toBeNull();
  });
  it("筛选与搜索词写进 ui.pool.filter / ui.pool.dimension", async () => {
    await userEvent.click(screen.getByRole("button", { name: /收藏/ }));
    expect(getWorkspaceSnapshot().filter).toBe("favorite");
  });
  it("点卡片产生 clip 选择,监视器与检查器都跟着换", async () => { /* 断言 store.selection */ });
  ```
  另：`SelectPage.test.tsx` 里凡是断言"筛选/搜索/虚拟化/评级过滤计数"的用例，逐条复制进本文件（改成对 `MediaPool` 渲染），**原文件的那些用例保留**（旗关路径仍要被测到）。
- [ ] 实现：网格渲染照搬 `SelectPage.tsx:623-700` 的 `film-grid-viewport` 结构（`role="grid"` + `aria-rowcount/colcount` + `aria-activedescendant` + `data-total-clips` + `onScroll` 记 `scrollTop`），列数改用 `poolColumnCount(paneWidth)`，overscan 保持 `GRID_OVERSCAN_ROWS = 2`。
- [ ] 命令：
  ```
  npx vitest run src/workspace/MediaPool.test.tsx src/SelectPage.test.tsx src/SelectPagePersistence.test.tsx
  npm run typecheck && npm run lint
  ```
- [ ] Commit：`feat(workspace): 媒体池——搜索、chips 筛选条、2–4 列虚拟网格,纯函数与旧壳共用`

---

### Task 3: 监视器 + 筛片操作

**依赖：** Task 2。**worktree：** `git worktree add ../tripcut-r8-t3 -b feat/r8-monitor`
**本任务是全轮最大的技术未知**（规格 §11）：`playerSetViewport` 在非全屏小矩形下的偏移未实测。3a 必须先把这件事验掉。

#### Commit 3a — `PlayerOverlay` 嵌入模式（同一个 mpv 实例）

**Files:**
- Modify `src/PlayerOverlay.tsx`：`PlayerOverlay`（`:110`）新增可选 prop；`useFocusTrap(overlayRef, true)`（`:137`）改为 `useFocusTrap(overlayRef, variant === "immersive")`；viewport effect（`:207-233`）的 `requestAnimationFrame` 前加 120ms debounce；`:27` `STATUS_INTERVAL_MS` 旁新增导出常量；状态轮询（`:179`）加"仅在可见且播放中"的条件。
- Modify `src/PlayerOverlay.test.tsx`（追加嵌入模式用例，既有用例一条不改）

**Interfaces:**
  ```ts
  // 既有 props 全部保留,只加两个可选项——旧调用点(SelectPage.tsx:2419)不改一个字。
  export function PlayerOverlay(props: {
    clip: ClipListItem;
    onSegmentsChange: () => void;
    onExit: () => void;
    variant?: "immersive" | "embedded";   // 默认 "immersive"
    onRequestImmersive?: () => void;       // 嵌入模式下 ⌘⏎ 的回调
  }): JSX.Element;
  export const VIEWPORT_DEBOUNCE_MS = 120;
  export function rectToPlayerViewport(rect: DOMRect): PlayerViewport | null; // 已存在,签名不变
  ```

- [ ] 先红：
  ```tsx
  it("嵌入模式不抢焦点(不装 focus trap)", async () => {
    const outside = document.createElement("button"); document.body.append(outside); outside.focus();
    render(<PlayerOverlay clip={clip} variant="embedded" onSegmentsChange={noop} onExit={noop} />);
    expect(document.activeElement).toBe(outside);
  });
  it("嵌入模式把区域矩形传给 playerSetViewport,而不是整窗", async () => {
    render(<PlayerOverlay clip={clip} variant="embedded" onSegmentsChange={noop} onExit={noop} />);
    await waitFor(() => expect(vi.mocked(playerSetViewport)).toHaveBeenCalled());
    const [vp] = vi.mocked(playerSetViewport).mock.lastCall!;
    expect(vp.width).toBeLessThan(window.innerWidth);
    expect(vp.x).toBeGreaterThan(0);
  });
  it("连续尺寸变化在 120ms 内只发一次 set_viewport", async () => {
    vi.useFakeTimers();
    render(<PlayerOverlay clip={clip} variant="embedded" onSegmentsChange={noop} onExit={noop} />);
    vi.mocked(playerSetViewport).mockClear();
    for (let i = 0; i < 10; i += 1) fireResize();
    await vi.advanceTimersByTimeAsync(VIEWPORT_DEBOUNCE_MS);
    expect(vi.mocked(playerSetViewport)).toHaveBeenCalledTimes(1);
  });
  it("换素材走 playerOpen,不 playerClose 重建实例", async () => {
    const { rerender } = render(<PlayerOverlay clip={clipA} variant="embedded" ... />);
    vi.mocked(playerClose).mockClear();
    rerender(<PlayerOverlay clip={clipB} variant="embedded" ... />);
    await waitFor(() => expect(vi.mocked(playerOpen)).toHaveBeenCalledWith(clipB.id));
    expect(vi.mocked(playerClose)).not.toHaveBeenCalled();
  });
  it("暂停时 80ms 状态轮询停表", async () => { /* 规格 §5 */ });
  it("沉浸模式行为一字不变(既有用例全部仍绿)", () => { /* 既有 184 行测试即是 */ });
  ```
- [ ] **真机验证（规格 §11 的退化判据，必须在 3b 之前做掉）**：`npm run tauri dev`，把播放器渲进一个约 700×400 的中上区，肉眼核对画面是否与区域矩形对齐、拖分隔条后是否跟随。对齐 → 继续 3b；**有偏移 → 立刻记入 `docs/qa/2026-09-11-unattended-r8.md` 的 FINDINGS，监视器区域改为封面占位图 + 「点击进入全屏沉浸 ⌘⏎」，并把省下的高度按规格 §2 让给镜头带（Task 4 的 `minSize` 随之调整）**。两条路都算 3a 完成，不许因为"没验"而默认走乐观路径。
- [ ] 命令：
  ```
  npx vitest run src/PlayerOverlay.test.tsx
  npm run tauri dev   # 人眼核对 viewport 对齐,结论写进 QA 报告
  ```
- [ ] Commit：`feat(player): PlayerOverlay 嵌入模式——区域矩形 viewport、120ms debounce、不抢焦点`

#### Commit 3b — `Monitor`：传输控件 + I/O 打点 + 占位

**Files:**
- Create `src/workspace/Monitor.tsx`（~320 行）
- Create `src/workspace/Monitor.test.tsx`
- Modify `src/workspace/WorkspaceShell.tsx`（监视器占位换成 `<Monitor />`）

**Interfaces:**
- Consumes：`formatTimecode(seconds: number, _fps: number): string`（`src/PlayerOverlay.tsx:29`，**不改**）、`playerCommandsForKey`（`:42`）、`createSelectSegment` / `listSelectSegments`（`src/api.ts`）。
- Produces：
  ```ts
  export function Monitor(): JSX.Element;
  /** 空槽位时监视器显示什么:章节标题 + 缺口 reason。 */
  export function slotPlaceholderCopy(gap: StoryGap): { title: string; reason: string };
  ```

- [ ] 先红：
  ```tsx
  it("空选中时显示中性占位与中文引导", () => {
    render(<Monitor />);
    expect(screen.getByText("从左侧媒体池选一条素材")).toBeTruthy();
  });
  it("选中空槽位时显示章节标题与缺口原因,不打开播放器", async () => {
    selectSlot(3, "REAL/ESTABLISHING");
    render(<Monitor />);
    expect(await screen.findByText(/第一章/)).toBeTruthy();
    expect(vi.mocked(playerOpen)).not.toHaveBeenCalled();
  });
  it("控件条齐全且全中文", () => {
    for (const name of ["播放", "后退一秒", "前进一秒", "入点", "出点", "保存片段", "全屏沉浸"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });
  it("时间码用 formatTimecode,格式不变", () => {
    expect(screen.getByLabelText("当前时间码").textContent).toBe("00:00:12.500");
  });
  it("I→O→S 保存片段调 createSelectSegment 一次", async () => { /* 迁移自 PlayerOverlay.test.tsx 的打点用例 */ });
  it("⌘⏎ 进全屏沉浸,Esc 退出后仍是同一条素材", async () => { /* store.immersive 切换 */ });
  ```
- [ ] 命令：`npx vitest run src/workspace/Monitor.test.tsx`
- [ ] Commit：`feat(workspace): 监视器——传输控件、时间码、I·O 打点、空选中与空槽位占位`

#### Commit 3c — `useRatingHotkeys`：F/X/1–5/0/Enter/L/R + IME 保护

**Files:**
- Create `src/workspace/useRatingHotkeys.ts`（~200 行）
- Create `src/workspace/useRatingHotkeys.test.tsx`
- Modify `src/workspace/MediaPool.tsx` 与（Task 4 之后）`ShotBand.tsx`：挂同一个 hook
- Modify `src/workspace/StatusStrip.tsx`（把 `composing` 真值接到右侧「中文输入法组合中」提示条）

**Interfaces:**
  ```ts
  export type HotkeyIntent =
    | { kind: "rating"; action: RatingAction }
    | { kind: "stack-state"; state: ShotStackUserState }
    | { kind: "promote-hero" }
    | { kind: "toggle-takes" }
    | { kind: "move-take"; direction: -1 | 1 }
    | { kind: "move-selection"; direction: -1 | 1 }
    | { kind: "toggle-playback" };
  /** 纯函数:一次 keydown 该做什么。composing=true 时单键一律返回 null(IME 组合保护)。 */
  export function ratingHotkeyIntent(
    event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey">,
    composing: boolean,
  ): HotkeyIntent | null;
  export interface RatingHotkeyHandlers {
    onRating(action: RatingAction): void | Promise<void>;
    onStackState(state: ShotStackUserState): void | Promise<void>;
    onPromoteHero(): void | Promise<void>;
    onToggleTakes(): void;
    onMoveTake(direction: -1 | 1): void;
    onMoveSelection(direction: -1 | 1): void;
    onTogglePlayback(): void;
  }
  export function useRatingHotkeys(
    pane: "pool" | "band",
    handlers: RatingHotkeyHandlers,
  ): {
    onKeyDown(event: React.KeyboardEvent<HTMLElement>): void;
    onCompositionStart(): void;
    onCompositionEnd(): void;
    composing: boolean;
  };
  ```

- [ ] 先红（语义逐条对齐 `SelectPage.tsx:1820-1875` 现状；`isFilmGridShortcutTarget` 的"只认事件目标就是容器本身"语义原样保留）：
  ```ts
  const k = (over: Partial<KeyboardEvent>) => ({ key: "", code: "", metaKey: false, ctrlKey: false, shiftKey: false, ...over });

  it("F/X/1–5/0 映射到评级", () => {
    expect(ratingHotkeyIntent(k({ key: "f", code: "KeyF" }), false)).toEqual({ kind: "rating", action: { kind: "binary", value: 1 } });
    expect(ratingHotkeyIntent(k({ key: "x", code: "KeyX" }), false)).toEqual({ kind: "rating", action: { kind: "binary", value: -1 } });
    expect(ratingHotkeyIntent(k({ key: "3", code: "Digit3" }), false)).toEqual({ kind: "rating", action: { kind: "star", value: 3 } });
    expect(ratingHotkeyIntent(k({ key: "0", code: "Digit0" }), false)).toEqual({ kind: "rating", action: { kind: "clear" } });
  });
  it("中文输入法把字母吃成 key=Process 时,靠 code 还原物理键", () => {
    expect(ratingHotkeyIntent(k({ key: "Process", code: "KeyF" }), false))
      .toEqual({ kind: "rating", action: { kind: "binary", value: 1 } });
  });
  it("组合期间单键一律不触发(IME 保护)", () => {
    for (const key of ["f", "x", "1", "0", "l", "r", "Enter", " "]) {
      expect(ratingHotkeyIntent(k({ key, code: `Key${key.toUpperCase()}` }), true)).toBeNull();
    }
  });
  it("带 ⌘/Ctrl 的组合键不落进评级(⌘1/⌘2 是折叠栏)", () => {
    expect(ratingHotkeyIntent(k({ key: "1", code: "Digit1", metaKey: true }), false)).toBeNull();
  });
  it("Enter 提为首选,L/R 切锁定与排除,Tab 展开 Take", () => {
    expect(ratingHotkeyIntent(k({ key: "Enter", code: "Enter" }), false)).toEqual({ kind: "promote-hero" });
    expect(ratingHotkeyIntent(k({ key: "l", code: "KeyL" }), false)).toEqual({ kind: "stack-state", state: "locked" });
    expect(ratingHotkeyIntent(k({ key: "r", code: "KeyR" }), false)).toEqual({ kind: "stack-state", state: "rejected" });
    expect(ratingHotkeyIntent(k({ key: "Tab", code: "Tab" }), false)).toEqual({ kind: "toggle-takes" });
  });
  it("↑↓ 切 Take,←→ 移选中(按栏),空格播放/暂停", () => {
    expect(ratingHotkeyIntent(k({ key: "ArrowUp", code: "ArrowUp" }), false)).toEqual({ kind: "move-take", direction: -1 });
    expect(ratingHotkeyIntent(k({ key: "ArrowRight", code: "ArrowRight" }), false)).toEqual({ kind: "move-selection", direction: 1 });
    expect(ratingHotkeyIntent(k({ key: " ", code: "Space" }), false)).toEqual({ kind: "toggle-playback" });
  });
  it("事件目标是输入框时 hook 不接管(目标判定沿用 isFilmGridShortcutTarget 语义)", async () => {
    render(<PoolWithHotkeys />);
    await userEvent.type(screen.getByRole("searchbox"), "f");
    expect(onRating).not.toHaveBeenCalled();
  });
  it("组合中时状态条显示「中文输入法组合中」,组合结束即消失", async () => { /* StatusStrip 渲染断言 */ });
  ```
- [ ] 命令：
  ```
  npx vitest run src/workspace/useRatingHotkeys.test.tsx src/workspace/StatusStrip.test.tsx
  node scripts/qa/fast-gates.mjs && node -e "process.exit(require('./gate.json').status==='PASS'?0:1)"
  ```
- [ ] Commit：`feat(workspace): useRatingHotkeys——评级/Stack/Take 键位与 IME 组合保护,两栏共用`

---

### Task 4: 镜头带 + 附属带模式

**依赖：** Task 1 + 2 + 3（高度分配由 3a 的实测结论定）。**本轮最大的一块。**
**worktree：** `git worktree add ../tripcut-r8-t4 -b feat/r8-band`

#### Commit 4a — `shotBandModel`：章节分组 + 横向虚拟化窗口（纯函数）

**Files:**
- Create `src/workspace/shotBandModel.ts`（~220 行）
- Create `src/workspace/shotBandModel.test.ts`

**Interfaces:**
- Consumes：`Storyboard`（`src/api.ts:458`：`{ chapters, items, candidates, can_undo, mode, mode_notice, narrative, narration_job_status, current_template }`）、`Chapter`（`:415`）、`StoryItem`（`:425`）、`StoryGap`（`:1222`）、`ShotStack`（`:402`）、`NarrativeChapter.missing_slots`（`:512`）。
- Produces：
  ```ts
  export interface BandSegment {
    key: string;                       // StoryItem.key,或 `slot:{chapterId}:{slot}`
    kind: "clip" | "slot";
    index: number;                     // 全带内的 1 基序号,用于 aria-label「镜头 {n}」
    clipId: number | null;
    segmentId: number | null;
    chapterId: number | null;
    slot: string | null;
    fileName: string | null;
    durationTicks: number;
    takeCount: number;
    isGenerated: boolean;
    gap: StoryGap | null;
  }
  export interface BandChapter {
    chapterId: number | null;
    title: string;
    durationTicks: number;
    gapCount: number;
    segments: BandSegment[];
  }
  export function buildBandChapters(
    board: Storyboard,
    gaps: readonly StoryGap[],
    stacks: readonly ShotStack[],
    clipsById: ReadonlyMap<number, ClipListItem>,
  ): BandChapter[];
  export function segmentAriaLabel(segment: BandSegment): string;
  /** 视口外的章节只渲染带头;拖动期间关闭虚拟化(当前章 ±1 全渲染,规格 §11)。 */
  export function renderableChapterRange(
    scrollLeftByChapter: readonly number[],
    viewportWidth: number,
    activeChapterIndex: number,
    dragging: boolean,
  ): { from: number; to: number; fullyRendered: readonly number[] };
  export function slotLabelZh(gap: StoryGap): string; // 直接取 gap.slot_label_zh,不在前端重造映射
  ```

- [ ] 先红：
  ```ts
  it("按章节分组,带头带序号、标题、章节时长与缺口数", () => {
    const chapters = buildBandChapters(board, gaps, stacks, clipsById);
    expect(chapters[0].title).toBe("出发");
    expect(chapters[0].gapCount).toBe(1);
    expect(chapters[0].durationTicks).toBe(chapters[0].segments.reduce((a, s) => a + s.durationTicks, 0));
  });
  it("空槽位以 slot 段出现在所属章节里,只来自白名单 slot(R7 规则不变)", () => {
    const slots = buildBandChapters(board, gaps, stacks, clipsById).flatMap((c) => c.segments)
      .filter((s) => s.kind === "slot").map((s) => s.slot);
    expect(slots).not.toContain("DH INTRO");
    expect(slots).not.toContain("MAP");
  });
  it("aria-label 一字不差", () => {
    expect(segmentAriaLabel({ ...clipSegment, index: 4, fileName: "DJI_0004.MP4" })).toBe("镜头 4：DJI_0004.MP4");
    expect(segmentAriaLabel({ ...slotSegment, index: 5, gap: { ...gap, slot_label_zh: "建立镜头" } }))
      .toBe("镜头 5：缺口 建立镜头");
  });
  it("序号在全带内连续,跨章节不重置", () => {
    const all = buildBandChapters(board, gaps, stacks, clipsById).flatMap((c) => c.segments);
    expect(all.map((s) => s.index)).toEqual(all.map((_, i) => i + 1));
  });
  it("生成片带 AI 标记且 takeCount 来自它所属的 Stack", () => {
    const seg = findByClipId(chapters, generatedClipId);
    expect(seg.isGenerated).toBe(true);
    expect(seg.takeCount).toBe(3);
  });
  it("拖动期间当前章 ±1 全渲染(虚拟化关掉,否则拖动目标会消失)", () => {
    const idle = renderableChapterRange(offsets, 900, 4, false);
    const dragging = renderableChapterRange(offsets, 900, 4, true);
    expect(dragging.fullyRendered).toEqual([3, 4, 5]);
    expect(idle.fullyRendered.length).toBeLessThanOrEqual(dragging.fullyRendered.length);
  });
  it("视口外的章节只出带头", () => {
    const r = renderableChapterRange(offsets, 400, 0, false);
    expect(r.to).toBeLessThan(offsets.length - 1);
  });
  ```
- [ ] 命令：`npx vitest run src/workspace/shotBandModel.test.ts`
- [ ] Commit：`feat(band): 镜头带数据模型——章节分组、缺口槽位、连续序号、拖动期关虚拟化`

#### Commit 4b — `ShotBand`：拖排 + Take 切换

**Files:**
- Create `src/workspace/ShotBand.tsx`（~390 行）
- Create `src/workspace/ShotBand.test.tsx`
- Modify `src/workspace/WorkspaceShell.tsx`（镜头带占位换成 `<ShotBand />`）

**Interfaces:**
- Consumes：`@dnd-kit/core` 的 `DndContext` / `DragOverlay` / `PointerSensor` / `useSensor` / `useSensors`（照 `Storyboard.tsx:1436`）；`@dnd-kit/sortable` 的 `SortableContext` / `useSortable` / **`horizontalListSortingStrategy`**（横向带，不是 `Storyboard.tsx:1295` 的 `verticalListSortingStrategy`）；`setStoryOrder(order: StoryOrderRef[]): Promise<void>`（`src/api.ts:1004`）、`undoStoryChange(): Promise<void>`（`:1016`）、`setShotStackUserState`（`:932`）；`storyOrderRefs(items: StoryItem[]): StoryOrderRef[]`、`reorderStoryItem`、`moveStoryItemWithinChapter`（`src/Storyboard.tsx:113,138,168`，**原样导入复用，不复制**）。
- Produces：
  ```ts
  export function ShotBand(): JSX.Element;
  ```

- [ ] 先红：
  ```tsx
  it("整带是 role=region aria-label=「镜头带」", () => {
    expect(screen.getByRole("region", { name: "镜头带" })).toBeTruthy();
  });
  it("拖排调 setStoryOrder 一次,顺序按 storyOrderRefs 生成", async () => {
    await dragSegment("镜头 2：B.MP4", "镜头 4：D.MP4");
    expect(vi.mocked(setStoryOrder)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setStoryOrder).mock.lastCall![0].map((r) => r.clip_id)).toEqual([1, 3, 4, 2, 5]);
  });
  it("松手后 toast「已调整顺序 · 撤销」,点撤销调 undoStoryChange", async () => {
    await dragSegment("镜头 2：B.MP4", "镜头 4：D.MP4");
    await userEvent.click(await screen.findByRole("button", { name: "撤销" }));
    expect(vi.mocked(undoStoryChange)).toHaveBeenCalledTimes(1);
  });
  it("跨章节拖动即改章节归属(沿用既有语义)", async () => { /* 断言目标 item 的 chapter_id */ });
  it("Tab 展开当前 Stack 的成员条,↑↓ 移动,Enter 提为首选", async () => {
    await userEvent.click(screen.getByRole("button", { name: "镜头 1：A.MP4" }));
    await userEvent.keyboard("{Tab}");
    expect(screen.getByRole("group", { name: /候选/ })).toBeTruthy();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(vi.mocked(setShotStackUserState)).toHaveBeenCalledWith(expect.anything(), expect.anything(), "locked");
  });
  it("Tab 不移动焦点(与现状一致)", async () => {
    const before = document.activeElement;
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(before);
  });
  it("生成片永远排在真实素材之后,并带「AI 生成」徽章(R7 §6 排序不变)", () => {
    const members = within(screen.getByRole("group", { name: /候选/ })).getAllByRole("button");
    expect(members.at(-1)!.textContent).toContain("AI 生成");
  });
  it("点分段产生 clip 选择,媒体池对应卡片高亮(跨栏回显)", async () => { /* 断言 store.selection + pool-clip-N 的 aria-selected */ });
  ```
- [ ] 命令：`npx vitest run src/workspace/ShotBand.test.tsx src/Storyboard.test.tsx`
- [ ] Commit：`feat(band): 镜头带拖排与 Take 切换——@dnd-kit 横向排序、撤销 toast、生成片恒排后`

#### Commit 4c — 空槽位卡片 + 「生成候选」接线

**Files:**
- Modify `src/workspace/ShotBand.tsx`（空槽位分支）
- Modify `src/workspace/ShotBand.test.tsx`
- Modify `src/Storyboard.tsx:1594`（`GenerationDialog` 的挂载点被 `ShotBand` 复用；**`GenerationDialog.tsx` 本体一行不改**）

**Interfaces:**
- Consumes：`GenerationDialog({ gap, readOnly, availability, onClose, onSubmitted })`（`src/GenerationDialog.tsx:39`，签名不变）、`dismissStoryGap(gapId: number): Promise<void>`（`src/api.ts:1242`）。

- [ ] 先红：
  ```tsx
  it("空槽位是虚线描边 + 槽位中文名 + reason 一行 + 「生成候选」按钮", async () => {
    const cell = screen.getByRole("button", { name: "镜头 5：缺口 建立镜头" });
    expect(within(cell).getByText(/本章缺一条建立镜头/)).toBeTruthy();
    expect(within(cell).getByRole("button", { name: "生成候选" })).toBeTruthy();
  });
  it("点「生成候选」打开 GenerationDialog,参数预填不变", async () => {
    await userEvent.click(screen.getByRole("button", { name: "生成候选" }));
    expect(await screen.findByRole("dialog", { name: /生成候选/ })).toBeTruthy();
  });
  it("白名单外的槽位不产生空槽位卡片", () => {
    expect(screen.queryByRole("button", { name: /缺口 地图/ })).toBeNull();
  });
  it("未启用或预算耗尽时「生成候选」禁用并给出中文原因(不是静默无反应)", async () => {
    expect(screen.getByRole("button", { name: "生成候选" })).toHaveProperty("disabled", true);
    expect(screen.getByText(/云端补镜未启用/)).toBeTruthy();
  });
  it("选中空槽位时监视器与检查器都进缺口分支", async () => { /* store.selection.kind === "slot" */ });
  ```
- [ ] 命令：`npx vitest run src/workspace/ShotBand.test.tsx src/GenerationDialog.test.tsx`
- [ ] Commit：`feat(band): 空槽位卡片与「生成候选」接线,对话框本体不改`

#### Commit 4d — `BandAccessory`：五种附属带模式

**Files:**
- Create `src/workspace/BandAccessory.tsx`（~120 行，只是容器）
- Create `src/workspace/MusicRuler.tsx`（~180 行，36px 刻度轨）
- Create `src/workspace/BandAccessory.test.tsx`
- Modify `src/Storyboard.tsx:1460-1470`（侧标签结构里"音乐与节奏 / 旅程时间线 / 地点卡"三项的容器代码；`MusicPanel`（`:1583`）、`JourneyTimeline`（`:1588`）、`DestinationCardEditor`（`:427`）**组件本体一行不改**，原样导入复用）
- Modify `src/Storyboard.test.tsx`（断言侧标签结构的那几条按 §9 迁移进 `BandAccessory.test.tsx`，不净删）

**Interfaces:**
- Consumes：`MusicPanel({ readOnly: boolean })`（`src/MusicPanel.tsx:46`）、`JourneyTimeline()`（`src/JourneyTimeline.tsx:70`）、`listStoryTemplates()`（`src/api.ts:974`）、`Storyboard.current_template`。
- Produces：
  ```ts
  export const BAND_TABS: readonly { mode: BandMode; label: string }[]; // 故事/音乐/旅程/地点卡/模板
  export function BandAccessory(): JSX.Element | null;
  /** 音乐刻度轨的纯函数:节拍点与段落分界落在共享时间轴上的哪个百分比。 */
  export function rulerMarks(
    beatsTicks: readonly number[],
    sectionsTicks: readonly number[],
    totalTicks: number,
  ): { beats: number[]; sections: number[]; suggestions: number[] };
  ```

- [ ] 先红：
  ```tsx
  it("分段控件是 tablist,AX 名与五个 tab 名一字不差", () => {
    const list = screen.getByRole("tablist", { name: "镜头带附属视图" });
    expect(within(list).getAllByRole("tab").map((t) => t.textContent))
      .toEqual(["故事", "音乐", "旅程", "地点卡", "模板"]);
  });
  it("默认「故事」不展开附属区,镜头带独占中下区", () => {
    expect(screen.getByRole("tab", { name: "故事" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("band-accessory")).toBeNull();
  });
  it("选中项持久化到 ui.band.mode", async () => {
    await userEvent.click(screen.getByRole("tab", { name: "音乐" }));
    expect(getWorkspaceSnapshot().bandMode).toBe("music");
  });
  it("「音乐」在镜头带上方插 36px 刻度轨,切点标「建议」且点击只定位不改数据", async () => {
    await userEvent.click(screen.getByRole("tab", { name: "音乐" }));
    expect(await screen.findByText("音乐与节奏")).toBeTruthy();  // 冒烟 band.music.content 的锚点
    expect(screen.getByText("建议")).toBeTruthy();
    await userEvent.click(screen.getAllByTestId("ruler-suggestion")[0]);
    expect(vi.mocked(setStoryOrder)).not.toHaveBeenCalled();
  });
  it("「旅程」在下方展开只读 JourneyTimeline", async () => {
    await userEvent.click(screen.getByRole("tab", { name: "旅程" }));
    expect(await screen.findByText("旅程时间线")).toBeTruthy(); // 冒烟 band.journey.content
  });
  it("「地点卡」展开当前章节的目的地卡编辑(R6 字段状态与校验照旧)", async () => { /* 迁移自 Storyboard.test.tsx */ });
  it("「模板」展开四选一,「电影感」在树里", async () => {
    await userEvent.click(screen.getByRole("tab", { name: "模板" }));
    expect(await screen.findByText("电影感")).toBeTruthy(); // 冒烟 band.template.content
  });
  it("刻度与镜头带共用同一时间轴", () => {
    expect(rulerMarks([0, 500, 1000], [0, 1000], 2000).beats).toEqual([0, 25, 50]);
  });
  ```
- [ ] 命令：
  ```
  npx vitest run src/workspace/BandAccessory.test.tsx src/Storyboard.test.tsx src/MusicPanel.test.tsx src/JourneyTimeline.test.tsx
  npm run typecheck && npm run lint
  ```
- [ ] Commit：`feat(band): 附属带五模式——故事/音乐刻度轨/旅程/地点卡/模板,tablist 名与 tab 名冻结`

---

### Task 5: 检查器分层

**依赖：** Task 2 + 4（clip 与 slot 两类选择都要先存在）。
**worktree：** `git worktree add ../tripcut-r8-t5 -b feat/r8-inspector`

#### Commit 5a — 默认层 + `<details>` 折叠段与逐段记忆

**Files:**
- Create `src/workspace/Inspector.tsx`（~340 行）
- Create `src/workspace/Inspector.test.tsx`
- Modify `src/workspace/WorkspaceShell.tsx`（检查器占位换成 `<Inspector />`）
- Modify `src/SelectPage.tsx:776`（`SelectionInspector` 保留给旗关路径，**不删**；它内部的评级/标签/段落渲染抽成 `src/workspace/inspectorFields.tsx` 供两处共用，行为不变）
- Create `src/workspace/inspectorFields.tsx`（~200 行）

**Interfaces:**
- Consumes：`TechCheckPanel({ clip: ClipListItem; readOnly: boolean })`（`src/TechCheckPanel.tsx:53`）、`SimilarGroupsPanel({ clipId: number | null; readOnly: boolean; clipsById: ReadonlyMap<number, ClipListItem> })`（`src/SimilarGroupsPanel.tsx:5`）、`AnalysisBadges({ clip, compact })`（`src/AnalysisPanel.tsx:78`）、`getAiDescription` / `describeClipWithAi` / `setClipTimeStage`（`src/api.ts`，签名不变）。三个面板组件本体**一行不改**。
- Produces：
  ```ts
  export type InspectorSectionId = "techcheck" | "dimensions" | "ai" | "audio" | "similar";
  export const INSPECTOR_SECTIONS: readonly { id: InspectorSectionId; title: string }[]; // 技术检查/八维评分/AI 描述/音轨与 LUT/相似镜头
  export interface InspectorStatusContext {
    techCheckIssues: number; aiDescribed: boolean; audioTrackCount: number; similarGroupCount: number; dimensionCount: number;
  }
  /** 每段标题右侧那个「极简状态字」,收起时也能判断要不要展开(规格 §4)。 */
  export function sectionStatusText(id: InspectorSectionId, ctx: InspectorStatusContext): string;
  export function Inspector(): JSX.Element;
  ```

- [ ] 先红：
  ```tsx
  it("默认层四段顺序固定且永远展开", () => {
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings.slice(0, 4)).toEqual(["评级与收藏", "标签", "所属章节 / 槽位", "同镜头 Take 切换"]);
  });
  it("折叠层用原生 details/summary,summary 文本即段名,默认全收起", () => {
    for (const { title } of INSPECTOR_SECTIONS) {
      const summary = screen.getByText(new RegExp(`^${title}`));
      expect(summary.closest("details")!.open).toBe(false);
    }
  });
  it("summary 常驻在树里,不需展开(冒烟 inspector.similar/techcheck.content 升硬断言的依据)", () => {
    expect(screen.getByText(/^相似镜头/)).toBeTruthy();
    expect(screen.getByText(/^技术检查/)).toBeTruthy();
  });
  it("每段标题右侧有状态字", () => {
    expect(sectionStatusText("techcheck", { ...ctx, techCheckIssues: 2 })).toBe("2 项提示");
    expect(sectionStatusText("ai", { ...ctx, aiDescribed: false })).toBe("未生成");
    expect(sectionStatusText("similar", { ...ctx, similarGroupCount: 0 })).toBe("无");
  });
  it("开合状态逐段记忆并写 ui.inspector.sections_open", async () => {
    await userEvent.click(screen.getByText(/^相似镜头/));
    expect(getWorkspaceSnapshot().inspectorSections).toEqual(["similar"]);
  });
  it("重新挂载后按记忆恢复展开态", () => {
    __resetWorkspaceForTests({ inspectorSections: ["techcheck"] });
    render(<Inspector />);
    expect(screen.getByText(/^技术检查/).closest("details")!.open).toBe(true);
  });
  it("Take 列表里生成片排在后面并带徽章", () => { /* 迁移自 SelectPage.test.tsx */ });
  it("主屏不出现英文 kicker", () => {
    expect(screen.queryByText("INSPECTOR")).toBeNull();
    expect(screen.queryByText("SELECTED / 当前素材")).toBeNull();
  });
  ```
- [ ] 命令：`npx vitest run src/workspace/Inspector.test.tsx src/SelectPage.test.tsx src/TechCheckPanel.test.tsx src/SimilarGroupsPanel.test.tsx`
- [ ] Commit：`feat(inspector): 默认四段 + 五个 details 折叠段与逐段记忆、段头状态字`

#### Commit 5b — 空槽位分支

**Files:**
- Modify `src/workspace/Inspector.tsx`
- Modify `src/workspace/Inspector.test.tsx`

- [ ] 先红：
  ```tsx
  it("选中空槽位时默认层换成缺口三件套,折叠层全部隐藏", async () => {
    selectSlot(3, "ATMOSPHERE");
    render(<Inspector />);
    expect(await screen.findByText(/缺口原因/)).toBeTruthy();
    expect(screen.getByText("目标槽位：氛围")).toBeTruthy();
    expect(screen.getByRole("button", { name: "生成候选" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "忽略此缺口" })).toBeTruthy();
    expect(screen.queryByText(/^技术检查/)).toBeNull();
    expect(screen.queryByText(/^相似镜头/)).toBeNull();
  });
  it("「忽略此缺口」调 dismissStoryGap 并让该槽位从镜头带消失", async () => {
    await userEvent.click(screen.getByRole("button", { name: "忽略此缺口" }));
    expect(vi.mocked(dismissStoryGap)).toHaveBeenCalledWith(gap.id);
  });
  it("空选中时显示中性引导,不是空白栏", () => {
    expect(screen.getByText(/从左侧媒体池选一条素材/)).toBeTruthy();
  });
  it("从槽位切回素材后折叠段记忆仍在", async () => { /* 记忆不被 slot 分支清掉 */ });
  ```
- [ ] 命令：`npx vitest run src/workspace/Inspector.test.tsx`
- [ ] Commit：`feat(inspector): 空槽位分支——缺口原因、目标槽位、生成候选与忽略,折叠层隐藏`

---

### Task 6: 导入/交付抽屉 + 设置 sheet + 集切换（本项完成后把旗默认打开）

**依赖：** Task 1（顶栏按钮与 `openDrawer`）。可与 Task 4/5 并行。
**worktree：** `git worktree add ../tripcut-r8-t6 -b feat/r8-drawers`

#### Commit 6a — 导入抽屉（三分页）

**Files:**
- Create `src/workspace/ImportDrawer.tsx`（~160 行）
- Create `src/workspace/Drawer.tsx`（~120 行，抽屉/sheet 共用的模态外壳）
- Create `src/workspace/ImportDrawer.test.tsx`
- Modify `src/workspace/WorkspaceShell.tsx`（挂载抽屉）

**Interfaces:**
- Consumes：`ImportPage()`（`src/ImportPage.tsx:490`）、`ImportManagement({ selectedIds, onChanged })`（`src/ImportManagement.tsx:4`）、`MissingMediaPanel()`（`src/MissingMediaPanel.tsx:23`）—— 三者本体一行不改；`useFocusTrap`。
- Produces：
  ```ts
  export type DrawerSide = "left" | "right" | "center";
  export function Drawer(props: {
    open: boolean; title: string; side: DrawerSide; width: string;
    onClose(): void; children: React.ReactNode;
  }): JSX.Element | null;
  export type ImportDrawerTab = "source" | "jobs" | "missing";
  export function ImportDrawer(): JSX.Element | null;
  ```

- [ ] 先红：
  ```tsx
  it("点「导入素材」从左侧滑入,role=dialog aria-modal,标题「导入素材」", async () => {
    await userEvent.click(screen.getByRole("button", { name: "导入素材" }));
    const dialog = await screen.findByRole("dialog", { name: "导入素材" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });
  it("三个分页名为 来源 / 任务 / 缺失素材", async () => {
    expect(within(dialog).getAllByRole("tab").map((t) => t.textContent)).toEqual(["来源", "任务", "缺失素材"]);
  });
  it("Esc 关闭且不改 hash", async () => {
    const before = window.location.hash;
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.hash).toBe(before);
  });
  it("关闭后焦点回到「导入素材」按钮", async () => {
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "导入素材" }));
  });
  it("抽屉打开态下「松开即导入」不在树里(冒烟 drawer.import.dropOverlay.hidden)", () => {
    expect(screen.queryByText("松开即导入")).toBeNull();
  });
  it("宽度为 min(720, 60vw)", () => { /* 断言 style */ });
  it("状态条的「任务」入口直接落在「任务」分页", async () => { /* store.importTab === "jobs" */ });
  ```
- [ ] 命令：`npx vitest run src/workspace/ImportDrawer.test.tsx src/ImportPage.test.tsx src/ImportPageRuntime.test.tsx src/MissingMediaPanel.test.tsx`
- [ ] Commit：`feat(workspace): 导入抽屉——来源/任务/缺失素材三分页,模态 + 焦点归还,不改 hash`

#### Commit 6b — 交付抽屉 + 设置 sheet（懒加载）

**Files:**
- Create `src/workspace/DeliverDrawer.tsx`（~120 行）
- Create `src/workspace/SettingsSheet.tsx`（~120 行）
- Create `src/workspace/SettingsSheet.test.tsx`
- Create `src/workspace/DeliverDrawer.test.tsx`
- Modify `src/workspace/WorkspaceShell.tsx`（三个模态全部 `React.lazy` + `Suspense`，首屏不加载）
- Modify `src/SettingsPage.tsx:392`（新增可选 prop `variant?: "page" | "sheet"`，sheet 下不渲染页面级外框；分区导航与 `settingsSections.ts` 的九个分区照旧）

**Interfaces:**
- Consumes：`DeliverPage()`（`src/DeliverPage.tsx:360`）、`SettingsPage()`（`src/SettingsPage.tsx:392`）。
- Produces：
  ```ts
  export function DeliverDrawer(): JSX.Element | null;   // 右侧滑入
  export function SettingsSheet(): JSX.Element | null;   // 顶部下沉,960 × 80vh
  ```

- [ ] 先红：
  ```tsx
  it("点「生成交付包」从右侧滑入,抽屉内有「本次交付平台」(冒烟 drawer.deliver.platform)", async () => {
    await userEvent.click(screen.getByRole("button", { name: "生成交付包" }));
    expect(await screen.findByText("本次交付平台")).toBeTruthy();
  });
  it("抽屉内有「联系表」(冒烟 drawer.deliver.contact,硬断言)", async () => {
    expect(await screen.findByText(/联系表/)).toBeTruthy();
  });
  it("⌘, 打开设置 sheet,九个分区导航都在,「隐私与诊断」在树里", async () => {
    await userEvent.keyboard("{Meta>},{/Meta}");
    expect(await screen.findByText("隐私与诊断")).toBeTruthy();
    expect(screen.getByText("云端补镜（MiniMax）")).toBeTruthy();
  });
  it("三个模态都是懒加载:首屏渲染不 import 它们", () => {
    render(<WorkspaceShell />);
    expect(deliverModuleLoaded()).toBe(false);
  });
  it("sheet 宽 960 高 80vh 且 Esc 关闭", () => { /* 断言 style + Esc */ });
  it("SettingsPage 在 page 与 sheet 两种 variant 下渲染同一套分区(既有测试仍绿)", () => { /* SettingsPage.test.tsx */ });
  ```
- [ ] 命令：`npx vitest run src/workspace/DeliverDrawer.test.tsx src/workspace/SettingsSheet.test.tsx src/DeliverPage.test.tsx src/SettingsPage.test.tsx`
- [ ] Commit：`feat(workspace): 交付抽屉与设置 sheet,三个模态 React.lazy 懒加载`

#### Commit 6c — 集切换 popover（并入素材库）

**Files:**
- Create `src/workspace/EpisodeSwitcher.tsx`（~220 行）
- Create `src/workspace/EpisodeSwitcher.test.tsx`
- Modify `src/workspace/TopBar.tsx`（居中挂载）
- Modify `src/EpisodePanel.tsx:44`（`EpisodePanel` 保留给旗关路径；集列表/重命名/封存三块抽成导出的子组件供两处共用，行为不变）
- Modify `src/EpisodePanel.test.tsx`（断言逐条保留，新增的搬进 `EpisodeSwitcher.test.tsx`）

**Interfaces:**
- Consumes：`getCurrentEpisode` / `listEpisodes` / `renameCurrentEpisode` / `archiveCurrentEpisode` / `setEpisodePlatform`（`src/api.ts`）、`LibraryPanel()`（`src/LibraryPanel.tsx:6`，本体不改，塞进 popover 底部一行）、`openHistoricalEpisode(episodeId, title)`（`src/historyView.ts:8`）。
- Produces：
  ```ts
  export function EpisodeSwitcher(): JSX.Element;
  ```

- [ ] 先红：
  ```tsx
  it("按钮 AX 名固定为「切换集」,可见文本含当前集标题(名不随数据漂移)", () => {
    const button = screen.getByRole("button", { name: "切换集" });
    expect(button.textContent).toContain("EP01");
    expect(button.textContent).toContain("通用");
  });
  it("点开 popover 有集列表、「重命名本集」与「封存本集」", async () => {
    await userEvent.click(screen.getByRole("button", { name: "切换集" }));
    expect(await screen.findByRole("button", { name: "重命名本集" })).toBeTruthy();
  });
  it("「重命名本集」里有「目标平台」(冒烟 topbar.episode.rename 升硬断言的依据)", async () => {
    await userEvent.click(screen.getByRole("button", { name: "重命名本集" }));
    expect(await screen.findByLabelText("目标平台")).toBeTruthy();
  });
  it("popover 底部一行是库路径 + 切换", async () => {
    expect(screen.getByRole("button", { name: /素材库/ })).toBeTruthy();
  });
  it("点历史集进只读查看,不改当前集过滤", async () => { /* 迁移自 EpisodePanel.test.tsx */ });
  it("Esc 关 popover,焦点回到「切换集」", async () => { /* 焦点归还 */ });
  ```
- [ ] 命令：`npx vitest run src/workspace/EpisodeSwitcher.test.tsx src/EpisodePanel.test.tsx src/LibraryPanel.test.tsx`
- [ ] Commit：`feat(workspace): 顶栏集切换 popover(AX 名「切换集」)并入素材库切换`

#### Commit 6d — 旗默认打开 + 「切回旧界面」+ 命令面板改写

**Files:**
- Modify `src/workspace/uiSettings.ts`（`UI_SETTING_DEFAULTS["ui.workspace_v2"]` `"false"` → `"true"`）
- Modify `src/SettingsPage.tsx`（外观分区加一行「界面」+ 按钮「切回旧界面」，写 `ui.workspace_v2=false` 后热切换、不重启）
- Modify `src/CommandPalette.tsx:11-13`（`onNavigate(path: string)` 的命令集改为面向新 IA：打开导入/交付抽屉、打开设置、切换五个附属带、跳章节；`onSelectClip` 语义不变）
- Modify `src/App.tsx`（旗为真时不再挂 `SidebarSearch`；`CommandPalette` 的 `onNavigate` 在新壳下映射为 `dispatchWorkspace`）
- Modify `src/CommandPalette.test.tsx`、`src/SettingsPage.test.tsx`、`src/App.test.tsx`

- [ ] 先红：
  ```tsx
  it("ui.workspace_v2 缺席时默认走新壳", async () => {
    vi.mocked(getSettings).mockResolvedValue({});
    render(<App />);
    expect(await screen.findByRole("region", { name: "媒体池" })).toBeTruthy();
  });
  it("设置 → 外观 → 「切回旧界面」写 false 并当场换壳,不要求重启", async () => {
    await userEvent.click(screen.getByRole("button", { name: "切回旧界面" }));
    expect(vi.mocked(setSetting)).toHaveBeenCalledWith("ui.workspace_v2", "false");
    expect(await screen.findByText("01 导入 INGEST")).toBeTruthy();
  });
  it("⌘K 命令集是新 IA:打开导入/交付/设置、切附属带、跳章节", async () => {
    await userEvent.keyboard("{Meta>}k{/Meta}");
    const items = screen.getAllByRole("option").map((o) => o.textContent);
    expect(items).toEqual(expect.arrayContaining(["打开导入素材", "打开生成交付包", "打开设置", "切到音乐附属带"]));
    expect(items).not.toEqual(expect.arrayContaining(["去交付页"]));
  });
  it("新壳下不再渲染独立侧栏搜索", () => {
    expect(screen.queryByLabelText("全库搜索")).toBeNull();
  });
  it("⌘K 搜到的素材点进去落在媒体池并被选中(与旧壳同一条路径)", async () => { /* 迁移自 CommandPalette.test.tsx */ });
  ```
- [ ] 命令：
  ```
  npx vitest run src/CommandPalette.test.tsx src/SettingsPage.test.tsx src/App.test.tsx
  node scripts/qa/fast-gates.mjs && node -e "process.exit(require('./gate.json').status==='PASS'?0:1)"
  ```
- [ ] Commit：`feat(workspace): ui.workspace_v2 默认打开,设置页留「切回旧界面」,命令面板改为新 IA`

---

### Task 7: 全局键盘 / 焦点 / a11y / 视觉收口

**依赖：** Task 1–6。**worktree：** `git worktree add ../tripcut-r8-t7 -b feat/r8-a11y`
> 本任务承接规格 §13 第 7 项里"a11y / 键盘 / 视觉"那半边；"冒烟 / 文档 / 版本"那半边在 Task 8。

#### Commit 7a — 全局键位与 Esc 优先级

**Files:**
- Create `src/workspace/useGlobalHotkeys.ts`（~160 行）
- Create `src/workspace/useGlobalHotkeys.test.tsx`
- Modify `src/workspace/WorkspaceShell.tsx`

**Interfaces:**
  ```ts
  export type GlobalHotkeyIntent =
    | { kind: "command-palette" } | { kind: "settings" }
    | { kind: "toggle-pane"; pane: "pool" | "inspector" }
    | { kind: "immersive" } | { kind: "help" }
    | { kind: "cycle-pane" }
    | { kind: "escape"; target: "drawer" | "sheet" | "immersive" | "query" | null };
  export function globalHotkeyIntent(
    event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey">,
    state: Pick<WorkspaceState, "openDrawer" | "immersive" | "query">,
    inTextField: boolean,
  ): GlobalHotkeyIntent | null;
  export function useGlobalHotkeys(): void;
  ```

- [ ] 先红：
  ```ts
  it("Esc 按 抽屉 → sheet → 沉浸 → 清搜索 的优先级逐层退", () => {
    const esc = { key: "Escape", code: "Escape", metaKey: false, ctrlKey: false, shiftKey: false };
    expect(globalHotkeyIntent(esc, { openDrawer: "import", immersive: true, query: "湖" }, false))
      .toEqual({ kind: "escape", target: "drawer" });
    expect(globalHotkeyIntent(esc, { openDrawer: "settings", immersive: true, query: "湖" }, false))
      .toEqual({ kind: "escape", target: "sheet" });
    expect(globalHotkeyIntent(esc, { openDrawer: null, immersive: true, query: "湖" }, false))
      .toEqual({ kind: "escape", target: "immersive" });
    expect(globalHotkeyIntent(esc, { openDrawer: null, immersive: false, query: "湖" }, false))
      .toEqual({ kind: "escape", target: "query" });
    expect(globalHotkeyIntent(esc, { openDrawer: null, immersive: false, query: "" }, false))
      .toEqual({ kind: "escape", target: null });
  });
  it("⌘1/⌘2 折叠媒体池/检查器,⌘⏎ 沉浸,⌘, 设置,? 帮助", () => { /* 五条 */ });
  it("空格在输入框里不劫持播放", () => {
    expect(globalHotkeyIntent({ key: " ", code: "Space", ... }, state, true)).toBeNull();
  });
  it("F6 在四栏之间轮转焦点,折叠的栏被跳过", async () => {
    render(<WorkspaceShell />);
    for (const name of ["预览监视器", "镜头带", "检查器", "媒体池"]) {
      await userEvent.keyboard("{F6}");
      expect(document.activeElement!.closest("[role=region]")!.getAttribute("aria-label")).toBe(name);
    }
  });
  it("⌘\\ 旧的侧栏折叠键在新壳下不再生效", () => { /* 侧栏已不存在 */ });
  ```
- [ ] 命令：`npx vitest run src/workspace/useGlobalHotkeys.test.tsx`
- [ ] Commit：`feat(workspace): 全局键位——F6 栏轮转、⌘1/⌘2 折叠、⌘⏎ 沉浸、Esc 四级优先级`

#### Commit 7b — 窄窗收缩顺序 + 折叠竖条

**Files:**
- Modify `src/workspace/WorkspaceShell.tsx`、`src/styles/workspace.css`
- Modify `src/workspace/WorkspaceShell.test.tsx`

- [ ] 先红：
  ```tsx
  it("1280 下三栏都在最小值附近且无横向滚动条", () => {
    resizeTo(1280, 800);
    expect(document.body.scrollWidth).toBeLessThanOrEqual(1280);
  });
  it("变窄先折检查器,再折媒体池,中栏 min 520 永不被挤", () => {
    resizeTo(1160, 800); expect(snapshot().inspectorCollapsed).toBe(true);
    resizeTo(900, 800);  expect(snapshot().poolCollapsed).toBe(true);
    expect(centerWidth()).toBeGreaterThanOrEqual(520);
  });
  it("折叠竖条宽 44px,带图标与「展开检查器」/「展开媒体池」按钮", () => { /* 两条 */ });
  it("栏内各自滚动,整窗不出现纵向滚动条", () => {
    expect(getComputedStyle(document.body).overflowY).toBe("hidden");
  });
  it("附属带展开时镜头带 min 高从 160 升到 260", () => { /* 规格 §2 */ });
  ```
- [ ] 命令：`npx vitest run src/workspace/WorkspaceShell.test.tsx`
- [ ] Commit：`feat(workspace): 窄窗收缩顺序与 44px 折叠竖条,中栏永不折`

#### Commit 7c — 英文 kicker 清除 + jsx-a11y 零告警 + AX 名冻结测试

**Files:**
- Create `src/workspace/axNames.test.tsx`（把所有冻结串集中断言一次，改一个字就红）
- Modify `src/workspace/*.tsx`、`src/styles/workspace.css`（清英文装饰串）
- Modify `src/SettingsPage.tsx`（「关于」分区保留 `TRIPCUT STUDIO` 字标——唯一允许出现的地方）

- [ ] 先红 `src/workspace/axNames.test.tsx`：
  ```tsx
  const FROZEN_BUTTONS = ["导入素材", "生成交付包", "设置", "切换集"];
  const FROZEN_REGIONS = ["媒体池", "预览监视器", "镜头带", "检查器"];
  const FROZEN_TABS = ["故事", "音乐", "旅程", "地点卡", "模板"];
  const BANNED_ON_MAIN_SCREEN = [
    "01 导入 INGEST", "02 筛片 SELECT", "03 交付 DELIVER", "04 设置 SETTINGS",
    "INGEST", "SELECT", "ROUGH CUT", "CHINESE-CLIP · LOCAL", "LIBRARY",
    "TRIPCUT / LOCAL-FIRST", "INSPECTOR", "LOCAL SQLITE", "PLACEHOLDER VIEW",
  ];

  it("冻结的 AX 名一字不差(冒烟脚本的锚点)", () => {
    render(<WorkspaceShell />);
    for (const name of FROZEN_BUTTONS) expect(screen.getByRole("button", { name })).toBeTruthy();
    for (const name of FROZEN_REGIONS) expect(screen.getByRole("region", { name })).toBeTruthy();
    expect(screen.getByRole("status", { name: "后台状态" })).toBeTruthy();
    const list = screen.getByRole("tablist", { name: "镜头带附属视图" });
    expect(within(list).getAllByRole("tab").map((t) => t.textContent)).toEqual(FROZEN_TABS);
  });
  it("主屏不出现任何英文 kicker / eyebrow", () => {
    render(<WorkspaceShell />);
    for (const banned of BANNED_ON_MAIN_SCREEN) expect(screen.queryByText(banned)).toBeNull();
  });
  it("品牌字标只在设置 sheet 的「关于」分区", async () => {
    render(<WorkspaceShell />);
    expect(screen.queryByText("TRIPCUT STUDIO")).toBeNull();
  });
  ```
- [ ] `npm run lint` 必须零 jsx-a11y 告警；有告警就修组件，不许加 eslint-disable。
- [ ] 命令：
  ```
  npx vitest run src/workspace/axNames.test.tsx
  npm run lint
  node scripts/qa/fast-gates.mjs && node -e "process.exit(require('./gate.json').status==='PASS'?0:1)"
  ```
- [ ] Commit：`feat(workspace): 清除主屏英文 kicker,冻结 AX 名并加测试,jsx-a11y 零告警`

---

### Task 8: 收尾——冒烟改写 / chunk / 文档 / 0.3.0

**依赖：** Task 1–7 全部合并到 `main`。**不开新 worktree，直接在 `main` 的收口分支 `chore/r8-wrapup` 上做。**

#### Commit 8a — `smoke-gui.mjs` 改写（规格 §8 迁移表）

**Files:**
- Modify `scripts/qa/smoke-gui.mjs`：`navGroup` 常量（`:123`）与 `clickNav`（`:124`）作废，改为点顶栏按钮；`pageContent`（`:171`）与 `pages`（`:177-184`）整块替换；`:205` / `:255` / `:262` / `:272` / `:313` 五处 `clickNav(...)` 调用全部改写；`:215-244` 的四条故事板 WARN、`:280-297` 的 `episode.renamePlatform.field` WARN 按迁移表升级。

**断言迁移表（逐条执行，一条不落）：**

| 旧断言 id | 新断言 id | 新锚点 |
|---|---|---|
| `page.import.*` | `drawer.import.*` | 点 `导入素材` → 断言抽屉标题「导入素材」+ 三个分页名 |
| `page.select.*` | `workspace.panes.*` | 断言 `媒体池`/`预览监视器`/`镜头带`/`检查器` 四个 landmark 同时在树里，无需导航 |
| `page.deliver.*` | `drawer.deliver.*` | 点 `生成交付包` → 断言「本次交付平台」 |
| `page.settings.*` | `sheet.settings.*` | 点 `设置` → 断言「隐私与诊断」 |
| `select.similar.content` | `inspector.similar.content` | 选中首条后 `summary`「相似镜头」常驻，**WARN → 硬断言** |
| `select.techcheck.content` | `inspector.techcheck.content` | 同上，**硬断言** |
| `select.storyboard.template`（WARN） | `band.template.content` | 点 tab `模板` → 断言「电影感」，**升硬断言** |
| `select.storyboard.journey_timeline`（WARN） | `band.journey.content` | 点 tab `旅程` → 「旅程时间线」，**升硬断言** |
| `select.storyboard.music`（WARN） | `band.music.content` | 点 tab `音乐` → 「音乐与节奏」，**升硬断言** |
| `select.storyboard.gap_card`（WARN） | `band.gap.slot` | 依赖种子库有缺口，**维持 WARN** |
| `deliver.platform.content` | `drawer.deliver.platform` | 抽屉内，硬断言 |
| `deliver.contact.content` | `drawer.deliver.contact` | 抽屉内，硬断言（接线未上时如实 FAIL，不掩盖） |
| `settings.privacy.content` | `sheet.settings.privacy` | sheet 内 |
| `settings.generation.content` | `sheet.settings.generation` | sheet 内 |
| `import.dropOverlay.hidden` | `drawer.import.dropOverlay.hidden` | 抽屉打开态下「松开即导入」不在树里 + 抽屉标题在 |
| `episode.renamePlatform.field`（WARN） | `topbar.episode.rename` | 点固定 AX 名 `切换集` → 「重命名本集」→「目标平台」，**升硬断言** |
| `select.rate.f`（WARN） | `pool.rate.f` | 媒体池获焦 ↓ + F，仍以 `ratings` 行数判定，**WARN 不变** |
| `db.integrity` / `db.clips` / `process.alive*` | 不变 | — |

- [ ] 新增两条：`statusbar.present`（`后台状态` landmark 存在）、`workspace.single_screen`（旧导航名 `01 导入 INGEST` **不再**出现在 AX 树里 —— 旧壳确实下线的负向证据）。
- [ ] 截图从"六页各一张"改为六张：`01 工作区默认` / `02 导入抽屉` / `03 交付抽屉` / `04 设置 sheet` / `05 音乐附属带` / `06 检查器展开态`。
- [ ] `clickNav` 的替代物：顶栏三个按钮有固定 AX 名，用现成的 `clickByLabel`（`:134`，注意它已经解决了"必须先把 entire contents 绑到变量"的坑，别退回内联写法）。删掉 `navGroup` 硬编码路径常量与 `clickNav`（连同 `:101-122` 那段解释四步导航 AX 路径的注释，改写为解释顶栏按钮 AX 名从何而来）。
- [ ] **校准（先让它红过）**：临时把 `WorkspaceShell.tsx` 里 `aria-label="镜头带"` 改成 `aria-label="镜头带2"`，跑冒烟确认 `workspace.panes.*` 变红；改回来再确认变绿。不做这一步就不许相信这轮绿。
- [ ] 命令：
  ```
  node --check scripts/qa/smoke-gui.mjs
  npm run tauri build && node scripts/qa/smoke-gui.mjs
  ```
- [ ] Commit：`test(qa): 冒烟改写为单屏工作区——顶栏三按钮 + 四 landmark,六条 WARN 升硬断言`

#### Commit 8b — chunk 分组 + `workspace.css` 收口

**Files:**
- Modify `vite.config.ts:29-40`（`rolldownOptions.output.codeSplitting.groups` 整块替换）
- Modify `src/styles/workspace.css`（合并零散规则，去重）

- [ ] 新分组（规格 §9）：
  ```ts
  groups: [
    { name: "vendor-dnd", test: /node_modules[\\/]@dnd-kit/ },
    { name: "vendor-cmdk", test: /node_modules[\\/]cmdk/ },
    { name: "vendor-panels", test: /node_modules[\\/]react-resizable-panels/ },
    { name: "workspace", test: /[\\/]src[\\/]workspace[\\/](WorkspaceShell|WorkspaceStore|TopBar|StatusStrip|uiSettings|useClipsFeed|useSelection|useGlobalHotkeys)\./ },
    { name: "pool", test: /[\\/]src[\\/]workspace[\\/](MediaPool|poolModel)\./ },
    { name: "monitor", test: /[\\/]src[\\/](workspace[\\/]Monitor|PlayerOverlay)\./ },
    { name: "band", test: /[\\/]src[\\/](workspace[\\/](ShotBand|BandAccessory|MusicRuler|shotBandModel)|Storyboard)\./ },
    { name: "inspector", test: /[\\/]src[\\/]workspace[\\/](Inspector|inspectorFields)\./ },
    { name: "drawers", test: /[\\/]src[\\/](workspace[\\/](Drawer|ImportDrawer|DeliverDrawer|EpisodeSwitcher)|ImportPage|DeliverPage)\./ },
    { name: "settings", test: /[\\/]src[\\/](workspace[\\/]SettingsSheet|SettingsPage)\./ },
    { name: "select-legacy", test: /[\\/]src[\\/]SelectPage\.tsx/ },
  ],
  ```
- [ ] 断言：`npm run build` 输出里**每个 chunk < 500 kB**，且没有 rolldown 的 `chunkSizeWarningLimit` 告警。0.3.0 期间两套样式同时打包、包体偏大是规格 §14 已认的代价，但单 chunk 上限不放宽。
- [ ] 首屏只加载 `workspace`/`pool`/`monitor`/`band`/`inspector`（+ 三个 vendor）；`drawers`/`settings` 只在打开时拉取 —— 用 `npm run build` 后的 `dist/assets` 清单加一条断言脚本核对，别只靠肉眼看构建日志。
- [ ] 命令：
  ```
  npm run build
  node -e "const fs=require('fs');const big=fs.readdirSync('dist/assets').filter(f=>f.endsWith('.js')&&fs.statSync('dist/assets/'+f).size>500*1024);if(big.length){console.error('chunk 超 500kB:',big);process.exit(1)}console.log('chunk 预算 OK')"
  ```
- [ ] Commit：`build(vite): 按新 IA 重划 chunk 分组,抽屉与设置懒加载,单 chunk < 500 kB`

#### Commit 8c — 文档与帮助

**Files:**
- Modify `docs/用户手册.md`、`docs/USER_GUIDE.md`（「界面导览」整章重写为单屏三栏；原"四步导航"章节改为"从旧界面迁移"一节）
- Modify `src/helpContent.ts:17-55`（`SELECTION_SHORTCUTS` / `PLAYER_SHORTCUTS` 按规格 §3.2 的键表补齐：`⌘1`/`⌘2`/`F6`/`⌘⏎`/`Esc` 优先级；`WORKFLOW_STEPS`（`:56`）由"导入→筛片→打点→故事"四步改为"一屏三栏"的说明）
- Modify `src/HelpOverlay.test.tsx`（断言新键表）
- Modify `docs/superpowers/plans/2026-09-06-unattended-upgrade-master.md`（R8 勾选）

- [ ] 手册写清三件事：① 一屏三栏各管什么；② 抽屉/sheet 从哪打开、Esc 怎么退；③ **旧界面在 0.3.0 期间可从「设置 → 外观 → 切回旧界面」临时恢复，下一版移除**。
- [ ] 命令：`npx vitest run src/HelpOverlay.test.tsx`
- [ ] Commit：`docs(r8): 用户手册与帮助覆盖层改写为单屏导演台,补全新键表`

#### Commit 8d — 0.3.0 + 发布说明 + QA 报告 + R9 入口

**Files:**
- Modify `package.json`（`"version": "0.2.1"` → `"0.3.0"`）
- Modify `src-tauri/tauri.conf.json`（`"version": "0.2.1"` → `"0.3.0"`）
- Modify `src-tauri/Cargo.toml`（`version = "0.2.1"` → `"0.3.0"`）
- Modify `docs/RELEASE.md`
- Create `docs/qa/2026-09-11-unattended-r8.md`

- [ ] 三处版本号必须一致（`npm run build` 与 `cargo test` 都不检查这件事，手动核一遍：`grep -R '0\.3\.0' package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml`）。
- [ ] 发布说明第一句**逐字**写：「界面改为单屏导演台；旧界面可在设置 → 外观 →「切回旧界面」临时恢复，下一版移除。」
- [ ] `docs/qa/2026-09-11-unattended-r8.md` 六节（目标与工作项 / 快照 / 门禁记录 / FINDINGS / 被 revert 或冻结项 / 下一轮入口），其中 FINDINGS **必须**记录：
  - Task 3a 的 mpv 嵌入 viewport 实测结论（对齐 / 有偏移 + 走了哪条路）；
  - 1280×800 下三栏密度的实机手感（规格 §11 说这条要业主试用后微调，本轮只量不改）；
  - 镜头带上千分段时的横向虚拟化实测帧率；
  - 设置表写入频率（拖分隔条 10 秒内实际落了几次 `set_setting`）。
- [ ] **R9 入口**明确写下三件事：① 删 `ui.workspace_v2` 旗；② 删 `App.tsx` 旧壳、`SidebarSearch.tsx`、`SelectPage.tsx` 的页面容器部分（纯函数已在 `poolModel.ts`，别连它一起删）、`styles.css` 里旧页面样式；③ 视 Task 8b 的实测决定要不要补只读命令 `get_job_summary`。
- [ ] 0.2.1 的 DMG **只留本机给业主试用，不发布、不打 tag、不进更新源**；0.3.0 才是下一个公开版本。
- [ ] 命令：
  ```
  node scripts/qa/fast-gates.mjs && node -e "process.exit(require('./gate.json').status==='PASS'?0:1)"
  npm run tauri build && node scripts/qa/audit-dmg.mjs
  node scripts/qa/smoke-gui.mjs
  ```
- [ ] Commit：`release(0.3.0): 单屏导演台工作区;R8 QA 报告与 R9 删旗入口`

---

## R9 入口（R8 收尾时写下，下一轮直接从这里开工）

R8 的成果是「新旧两套界面共存一个发行版」。0.3.0 一发出去，这份共存就该拆掉。
下一轮开工按这个顺序，**先删旗，再删壳，最后清样式**——反过来做会在中途出现
「旗还在但壳没了」的半截状态。

### ① 删 `ui.workspace_v2` 旗

- `src/App.tsx` 里读旗分流的那段；`src/workspace/uiSettings.ts` 里这个键的读写与默认值；
  设置 → 外观分区的「界面 / 切回旧界面」那一行（`SettingsPage.tsx`）。
- `App.test.tsx` 的「旗开 / 旗关渲染不同壳」两例随之删掉——**删的是用例本身，不是把
  断言改宽**。旗没了，这两例断言的东西就不存在了。
- 设置表里已经写过 `ui.workspace_v2=false` 的用户机器上会留一行孤儿设置。读取点删干净
  即可，不必写迁移去删这一行（`settings` 表本来就容忍未知键）。

### ② 删旧壳与旧页面容器

- `src/LegacyShell.tsx`、`src/SidebarSearch.tsx`（含 `SidebarSearch.test.tsx`）整份删。
- `src/SelectPage.tsx`（2295 行）**只删页面容器部分**：搜索 / 筛选 / 评级 / Stack 展开 /
  选中 / 轮询 / 持久化那一整套 React 状态与 JSX。**纯函数已经搬进
  `src/workspace/poolModel.ts` 与 `src/workspace/shotBandModel.ts`，新壳在用，别连它们一起删。**
  删之前先 `grep -rn "from \"./SelectPage\"" src/`：`RatingAction` 这个类型目前还从
  `SelectPage` 导出、被 `ShotBand.tsx` 引着——先把它挪到 `poolModel.ts` 再删文件，
  否则 `tsc` 会在一个跟本次改动看起来毫不相干的地方红。
- `src/ImportPage.tsx` / `src/DeliverPage.tsx` / `src/SettingsPage.tsx` **不删**：三个抽屉
  和 sheet 包的就是它们的主体（规格 §1.1）。
- `src/SelectPage.test.tsx`、`src/SelectPagePersistence.test.tsx`:R8 已把同类断言逐条搬到
  新组件测试里，删文件前按 Task 2/3/5 的报告核对一遍搬迁表，**不允许净删断言**。

### ③ 清样式与 chunk

- `src/styles.css` 里只服务旧四页的规则（侧栏 `.sidebar-*`、四步导航、旧页面容器）。
  删之前先跑一次 `axNames.test.tsx` 的花括号配平用例——R8 就是在这上面栽过一次：
  六条规则的 `}` 被合并冲掉，整张表后半段在真机上全不生效。
- `vite.config.ts` 的 `select-legacy` 分组随 `SelectPage.tsx` 一起删；`app-core` 分组里
  给旧壳留的那几个模块重新核一遍。删完重跑 `scripts/qa/check-chunks.mjs`。
- 两套样式同时打包是 §14 认下的代价，删完这一版包体应当明显回落——**量一下再写进
  R9 的报告里**，别只说「应该小了」。

### ④ 冒烟脚本

- `scripts/qa/smoke-gui.mjs` 的 `workspace.single_screen` 断言（旧导航名不在 AX 树里）
  在旗删掉之后从「负向证据」变成「恒真」。那时它不再是探测器，**改成断言
  `LegacyShell` 这个模块在产物里不存在**（`dist/assets` 里没有 `LegacyShell-*.js`），
  否则就是一条永远绿的空断言。

### ⑤ 视 R8 实测决定要不要补 `get_job_summary`

规格 §11 留的那个口子:状态条现在靠 `getImportProgress` / `listMissingClips` /
`listGenerationRequests` 三条既有命令在前端聚合。R8 没有测出聚合开销不可接受，
所以**默认不补**;只有在真机上量到状态条刷新拖慢工作区时才加这条只读命令。
补之前先量,别先写。

### 还欠的两件事（R8 没做完，不是 R9 才发现的）

- **截图证据**:R8 三轮真机检查的截图全部 SKIP —— 驱动进程没有 macOS「屏幕录制」
  权限,`CGWindowListCopyWindowInfo` 返回空,而全屏兜底已被证实不安全(会拍到别的
  app 的窗口)。**这一条要业主在系统设置里授权之后才能补**,不是代码问题。
- **抽屉的 Esc 在真机上关不掉**:R8 收尾轮实测复现两次,jsdom 用例却是绿的
  (`DeliverDrawer.test.tsx` 里那条 Esc 用例)。R8 的处置是补了可见的「关闭」按钮
  与可点遮罩(出口不止一个),**根因没查到**。R9 要查的话,第一条线索是实测时
  `AXFocusedUIElement` 是 `missing value` —— 窗口里没有任何元素持有键盘焦点,
  `useFocusTrap` 在真机上可能根本没把焦点放进抽屉。
