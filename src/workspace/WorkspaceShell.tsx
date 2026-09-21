import { Suspense, lazy, useCallback, useEffect, useRef, useState, type JSX } from "react";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import { Inspector } from "./Inspector";
import { Monitor } from "./Monitor";
import { DuelHost } from "./duel/DuelHost";
import { MediaPool } from "./MediaPool";
import { ShotBand } from "./ShotBand";
import { bandMinHeight, bandPanelHeight, bandPanelMinHeight } from "./shotBandModel";
import { StatusStrip } from "./StatusStrip";
import { GuideHost } from "./GuideHost";
import { HomeScreen } from "./HomeScreen";
import { useHomeVisible } from "./homeModel";
import { ToolchainStatusProbe } from "./ToolchainBanner";
import { PaneRail } from "./PaneRail";
import { ToastHost } from "./ui/Toast";
import { UpdateHost } from "./update/UpdateHost";
import { ClipRemovalHost } from "./ClipRemovalHost";
import { LAYOUT_RESET_EVENT } from "./layoutReset";
import { TopBar } from "./TopBar";
import { popModal, pushModal } from "./modalStack";
import { loadKeymap } from "./keymapStore";
import { useGlobalHotkeys } from "./useGlobalHotkeys";
import { autoCollapseTransition, useRestoreSelection } from "./shellLayout";
import { useShellWindowEvents } from "./useShellWindowEvents";
import { returnToActiveEpisode } from "../historyView";
import { Button } from "./ui";
import { PhotoWorkspace } from "./PhotoWorkspace";
import {
  POOL_WIDTH_MAX,
  POOL_WIDTH_MIN,
  dispatchWorkspace,
  getWorkspaceSnapshot,
  isInspectorOpen,
  isPaneCollapsed,
  useWorkspace,
} from "./WorkspaceStore";

// 三个模态各自懒加载(规格 §1.1 的 chunk 预算):`lazy()` 的 dynamic import()
// 只在真正渲染这个组件时才触发——下面按 `openDrawer` 条件挂载,而不是常驻
// `<Suspense>` 包一层,首屏(什么都没打开)因此一次都不会拉取它们的 chunk。
const LazyImportDrawer = lazy(() =>
  import("./ImportDrawer").then((module) => ({ default: module.ImportDrawer })),
);
const LazyDeliverDrawer = lazy(() =>
  import("./DeliverDrawer").then((module) => ({ default: module.DeliverDrawer })),
);
const LazySettingsSheet = lazy(() =>
  import("./SettingsSheet").then((module) => ({ default: module.SettingsSheet })),
);
// 帮助浮层跟三个模态同理:`?` 按下去之前一次都不拉它的 chunk(helpContent 不小)。
const LazyHelpOverlay = lazy(() =>
  import("../HelpOverlay").then((module) => ({ default: module.HelpOverlay })),
);

export { autoCollapseFor, autoCollapseTransition } from "./shellLayout";

/**
 * 镜头带栏的最小高只有 `shotBandModel.bandMinHeight` 一份(故事 184 = 视口内容高,
 * 附属 284)。这里 re-export 只是让旧调用点不断 —— 壳不再自己算一份 160/260。
 */
export { bandMinHeight };

export { drawerForLegacyHash, isLegacyHash } from "./useShellWindowEvents";

export function WorkspaceShell(): JSX.Element {
  const poolWidth = useWorkspace((state) => state.poolWidth);
  const inspectorWidth = useWorkspace((state) => state.inspectorWidth);
  const monitorRatio = useWorkspace((state) => state.monitorRatio);
  const poolCollapsed = useWorkspace((state) => isPaneCollapsed(state, "pool"));
  // R19 V-04:检查器是监视器栏内的滑出层 —— 选中即出、Esc / 点空白收、📌 钉住常驻。
  const inspectorOpen = useWorkspace(isInspectorOpen);
  const inspectorPinned = useWorkspace((state) => state.inspectorPinned);
  const bandMode = useWorkspace((state) => state.bandMode);
  const openDrawer = useWorkspace((state) => state.openDrawer);
  const viewingEpisode = useWorkspace((state) => state.viewingEpisode);
  const workspaceMode = useWorkspace((state) => state.workspaceMode);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const bandPanelRef = usePanelRef();
  const [helpOpen, setHelpOpen] = useState(false);
  const helpToken = useRef({});
  // R13 §3:首页盖在三栏与状态条上(空库自动 / 点 logo);三栏保持挂载(store、feed、面板尺寸都不丢),
  // 只是 inert —— 键盘与 AX 都到不了被盖住的控件。顶栏、抽屉、toast、气泡宿主照常。
  const homeOpen = useHomeVisible();
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    for (const node of shell.querySelectorAll<HTMLElement>(".workspace-columns, .photo-workspace, .workspace-status-row")) node.toggleAttribute("inert", homeOpen);
  }, [homeOpen]);

  // 拖动期间只改 CSS 变量,不 setState —— 三栏不重渲染(规格 §10);
  // 松手(onLayoutChanged)才把最终值 dispatch 出去,由 store 的 400ms debounce 落盘。
  const latest = useRef({ pool: poolWidth, inspector: inspectorWidth, monitor: monitorRatio });
  // R16 P2-12「恢复默认布局」:Panel 只认 defaultSize,store 改了它不动 —— 换 key 让整组 Panel 按默认值重挂。
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  useEffect(() => {
    const onReset = () => {
      latest.current = { pool: getWorkspaceSnapshot().poolWidth, inspector: getWorkspaceSnapshot().inspectorWidth, monitor: getWorkspaceSnapshot().monitorRatio };
      setLayoutEpoch((epoch) => epoch + 1);
    };
    window.addEventListener(LAYOUT_RESET_EVENT, onReset);
    return () => window.removeEventListener(LAYOUT_RESET_EVENT, onReset);
  }, []);
  const paint = useCallback((name: string, value: string) => {
    shellRef.current?.style.setProperty(name, value);
  }, []);
  // R19 V-04:滑出层宽从 store 来(没有 Panel 再 onResize 了),画成壳根上的变量给层与监视器的让位读。
  useEffect(() => paint("--inspector-width", `${Math.round(inspectorWidth)}px`), [inspectorWidth, paint]);

  // 松手(onLayoutChanged 在布局落定后才响)才把最终尺寸交给 store,由它的 400ms
  // debounce + 串行队列落 settings 表 —— 拖动中途一次都不写。
  const commitSizes = useCallback(() => {
    const { pool, inspector, monitor } = latest.current;
    dispatchWorkspace({ type: "set-pane-size", pane: "pool", value: pool });
    dispatchWorkspace({ type: "set-pane-size", pane: "inspector", value: inspector });
    dispatchWorkspace({ type: "set-pane-size", pane: "monitor", value: monitor });
  }, []);

  // 镜头带栏的高由模式决定(规格 §3.7):故事模式贴着内容(标题条 + 视口 + 展开的 Take 条),
  // 瓦片下方不留壳底色,多出的全归监视器;附属带展开时按持久化的监视器占比分剩余、
  // 不低于 316。内容高由 ResizeObserver 量 `.workspace-band-fit`(故事模式下它是 auto 高),
  // Take 条 / toast 出现时它变高,Panel 跟着长;附属模式下它撑满 Panel,量到的就是 Panel 本身。
  const bandContentHeight = useRef(0);
  const fitBand = useCallback(() => {
    // R19 V-03:带通栏后,「栈」= 外层竖向 Group(上层 + 带),不再是中栏。
    const stack = shellRef.current?.querySelector<HTMLElement>(".workspace-columns");
    const mode = getWorkspaceSnapshot().bandMode;
    const target = bandPanelHeight(mode, {
      stackHeight: stack?.clientHeight ?? 0,
      monitorRatio: latest.current.monitor,
      contentHeight: mode === "story" ? bandContentHeight.current : 0,
    });
    const current = bandPanelRef.current?.getSize().inPixels ?? 0;
    if (Math.abs(current - target) >= 1) bandPanelRef.current?.resize(target);
  }, [bandPanelRef]);

  useEffect(() => {
    fitBand();
    const fit = shellRef.current?.querySelector<HTMLElement>(".workspace-band-fit");
    if (!fit || typeof ResizeObserver === "undefined" || bandMode !== "story") return;
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height ?? 0;
      if (height <= 0) return;
      bandContentHeight.current = height;
      fitBand();
    });
    observer.observe(fit);
    return () => observer.disconnect();
  }, [bandMode, fitBand, workspaceMode]);

  useEffect(() => {
    // 窄窗自动折叠(只剩媒体池)只碰 store 的 auto 位(set-auto-collapse),不碰用户手动位,
    // 也就不会被 persistedPairs 落盘——这正是 U-04 的根因:此前它派发 toggle-pane,把
    // 自动折叠写成了用户偏好。跨阈值才派发,见 autoCollapseTransition。
    let lastWidth: number | null = null;
    const apply = () => {
      const width = window.innerWidth;
      const patch = autoCollapseTransition(lastWidth, width);
      lastWidth = width;
      if (patch !== null) dispatchWorkspace({ type: "set-auto-collapse", ...patch });
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, []);

  useRestoreSelection();

  useShellWindowEvents();

  // 规格 §3.2 的整张全局键位表(F6 轮栏、⌘1/⌘2 折叠、⌘⏎ 沉浸、⌘, 设置、⌘I 导入、
  // ? 帮助、Esc 四级优先级)都在这个 hook 里,壳本身不再各挂各的 keydown。
  useGlobalHotkeys();
  // R13 §1:键位表从 settings 水合一次(失败保持剪映默认)。
  useEffect(() => void loadKeymap(), []);

  useEffect(() => {
    // `?` 由 useGlobalHotkeys 广播;命令面板的「打开帮助」走同一个事件。
    const onOpenHelp = () => setHelpOpen(true);
    window.addEventListener("tripcut:open-help", onOpenHelp);
    return () => window.removeEventListener("tripcut:open-help", onOpenHelp);
  }, []);

  useEffect(() => {
    // 帮助浮层自己听 Esc。它得进模态栈,否则壳的全局 Esc 会连它下面的沉浸一起退。
    if (!helpOpen) return;
    const token = helpToken.current;
    pushModal(token);
    return () => popModal(token);
  }, [helpOpen]);

  return (
    <div className="workspace-shell" ref={shellRef}>
      <TopBar />
      {/* R19 V-02:顶部只有一行。步骤提示进「下一步」tooltip(与首页四步卡);工具链缺失不再是横幅,
          这里只跑探针把状态发布出去,状态条左端的红点 + 一句由 StatusStrip 订阅 useToolchainStatus 渲染。 */}
      <ToolchainStatusProbe />
      {/* R12 §3:全应用唯一的 toast 宿主(顶部居中、一条、3–5 秒);各栏只 showToast,不各自挂。 */}
      <ToastHost />
      {/* R17 车道 B:应用内自动升级(启动 30 秒后查;提示走上面那条 toast)。 */}
      <UpdateHost />
      {/* R16 P1-1:「移除素材…」的确认卡(全应用一份)。 */}
      <ClipRemovalHost />
      {/* R13 §3:功能气泡宿主,全应用一份;首页(空库 / 点 logo)盖在三栏上。 */}
      <GuideHost />
      {homeOpen ? <HomeScreen /> : null}
      {/*
        R19 V-03(方案 B「Cut 页式两层」):外层竖向 Group = 上层(媒体池 | 监视器 | 检查器)/ 镜头带通栏;
        带不再被两侧栏夹着,1440 下带宽从 ~740 涨到 ~1400。上层的高就是原来的「监视器占比」。
      */}
      {workspaceMode === "photo" ? <PhotoWorkspace /> : (
      <Group key={layoutEpoch} orientation="vertical" className="workspace-columns" onLayoutChanged={commitSizes}>
        <Panel
          id="upper"
          className="workspace-upper"
          defaultSize={`${Math.round(monitorRatio * 100)}%`}
          minSize={240}
          onResize={(size) => {
            // 故事模式下带被钉在内容高,这个占比是算出来的,不是用户拖的 —— 不记,
            // 否则切回附属模式时用户上次拖好的分法就被冲掉了。
            if (bandMode === "story") return;
            latest.current.monitor = size.asPercentage / 100;
            paint("--monitor-ratio", `${size.asPercentage / 100}`);
          }}
        >
      <Group orientation="horizontal" className="workspace-upper-row" onLayoutChanged={commitSizes}>
        {/*
          竖条与整栏是两个不同 id / key 的 Panel,而不是同一个 Panel 换 props:
          react-resizable-panels 按实例记尺寸,同一实例从 44px 竖条切成 minSize 280 的
          整栏时,44 < 280 且 `collapsible` 会让它直接塌成 0(U-04 真机「检查器整个消失」)。
          换 key 让它重新挂载,库按 panel id 组合取回上次的宽或 defaultSize。
          `collapsible` 也一并去掉——折叠是壳自己的竖条,不需要库再折一层。
        */}
        {poolCollapsed ? (
          <Panel key="pool-rail" id="pool-rail" defaultSize={44} minSize={44} maxSize={44} className="workspace-pool collapsed">
            <PaneRail
              icon="chevron-right"
              label="媒体池"
              onExpand={() => dispatchWorkspace({ type: "toggle-pane", pane: "pool" })}
            />
          </Panel>
        ) : (
          <Panel
            key="pool-pane"
            id="pool-pane"
            defaultSize={poolWidth}
            minSize={POOL_WIDTH_MIN}
            maxSize={POOL_WIDTH_MAX}
            onResize={(size) => {
              latest.current.pool = size.inPixels;
              paint("--pool-width", `${Math.round(size.inPixels)}px`);
            }}
            className="workspace-pool"
          >
            <div
              aria-label="媒体池"
              role="region"
              data-pane="pool"
              tabIndex={-1}
              className="workspace-pane"
            >
              {viewingEpisode ? (
                <p className="workspace-pool-scope" role="status">
                  {`只读查看「${viewingEpisode.title}」`}
                  <Button variant="ghost" size="sm" onClick={returnToActiveEpisode}>
                    回到当前集
                  </Button>
                </p>
              ) : null}
              <MediaPool />
            </div>
          </Panel>
        )}

        <Separator
          className="workspace-handle"
          aria-label="调整媒体池宽度"
          aria-valuenow={Math.round(poolWidth)}
        >
          <span className="workspace-handle-grip" aria-hidden="true" />
        </Separator>

        <Panel
          id="center"
          minSize={520}
          className="workspace-center"
          onPointerDownCapture={(event) => {
            // 点空白收(V-04):没钉住时,点到监视器栏里滑出层之外的任何地方都把它收起来 ——
            // 看检查器的时刻不是看画面的时刻;点画面 / 走带就是要看画面。
            if (!inspectorOpen || inspectorPinned) return;
            const target = event.target as HTMLElement | null;
            if (target?.closest(".workspace-inspector-layer")) return;
            dispatchWorkspace({ type: "toggle-pane", pane: "inspector" });
          }}
        >
          <div
            aria-label="预览监视器"
            role="region"
            data-pane="monitor"
            tabIndex={-1}
            // 滑出层盖住井右侧时画面缩小而不是被遮住:给监视器让出层宽(CSS 里封顶 60%,布局变化按动效总则 0ms)。
            className={inspectorOpen && !inspectorPinned ? "workspace-pane is-shifted" : "workspace-pane"}
          >
            {/* R21 PH-05:擂台激活时替换监视器子树(单 mpv 拥有者),不碰 Monitor 内部。 */}
            <DuelHost><Monitor /></DuelHost>
          </div>
          {/*
            R19 V-04:检查器不再是 Panel,是监视器栏内 `position:absolute; right:0` 的滑出层
            (钉住时改成常驻的 flex 子项)。region「检查器」的 AX 名冻结不动;收起时 region 还在
            (冒烟脚本按名找 landmark),里面不挂内容。开合都在中栏内部,中栏宽度不变。
          */}
          <div
            aria-label="检查器"
            role="region"
            data-pane="inspector"
            tabIndex={-1}
            className={`workspace-pane workspace-inspector-layer${inspectorOpen ? " is-open" : ""}${inspectorPinned ? " is-pinned" : ""}`}
          >
            {inspectorOpen ? <Inspector /> : null}
          </div>
        </Panel>
      </Group>
        </Panel>
        <Separator
          className="workspace-handle horizontal"
          aria-label="调整监视器高度"
          aria-valuenow={Math.round(monitorRatio * 100)}
        >
          <span className="workspace-handle-grip" aria-hidden="true" />
        </Separator>
        <Panel
          panelRef={bandPanelRef}
          defaultSize={bandPanelMinHeight(bandMode)}
          minSize={bandPanelMinHeight(bandMode)}
          groupResizeBehavior="preserve-pixel-size"
          className="workspace-band"
        >
          <div className={bandMode === "story" ? "workspace-band-fit workspace-band-fit--content" : "workspace-band-fit"}>
            <ShotBand />
          </div>
        </Panel>
      </Group>
      )}
      {/* 状态条一行。工具链红点由 StatusStrip 自己在左端渲染(数据源是上面 ToolchainStatusProbe 发布的 useToolchainStatus)。 */}
      <div className="workspace-status-row">
        <StatusStrip />
      </div>
      {openDrawer === "import" ? (
        <Suspense fallback={null}>
          <LazyImportDrawer />
        </Suspense>
      ) : null}
      {openDrawer === "deliver" ? (
        <Suspense fallback={null}>
          <LazyDeliverDrawer />
        </Suspense>
      ) : null}
      {openDrawer === "settings" ? (
        <Suspense fallback={null}>
          <LazySettingsSheet />
        </Suspense>
      ) : null}
      {helpOpen ? (
        <Suspense fallback={null}>
          <LazyHelpOverlay open onClose={() => setHelpOpen(false)} />
        </Suspense>
      ) : null}
    </div>
  );
}
