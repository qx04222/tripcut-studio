import { Suspense, lazy, useCallback, useEffect, useRef, useState, type JSX } from "react";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import { bridgeMusicAnalyzedEvents } from "../api";
import { Inspector } from "./Inspector";
import { Monitor } from "./Monitor";
import { MediaPool } from "./MediaPool";
import { ShotBand } from "./ShotBand";
import { bandMinHeight, bandPanelHeight, bandPanelMinHeight } from "./shotBandModel";
import { StatusStrip } from "./StatusStrip";
import { TopBar } from "./TopBar";
import { popModal, pushModal } from "./modalStack";
import { getClipsFeedSnapshot } from "./useClipsFeed";
import { useGlobalHotkeys } from "./useGlobalHotkeys";
import { selectionBelongsToEpisode } from "./useSelection";
import { autoCollapseTransition, useRestoreSelection } from "./shellLayout";
import { returnToActiveEpisode } from "../historyView";
import { Button } from "./ui";
import {
  INSPECTOR_WIDTH_MAX,
  INSPECTOR_WIDTH_MIN,
  POOL_WIDTH_MAX,
  POOL_WIDTH_MIN,
  dispatchWorkspace,
  getWorkspaceSnapshot,
  isPaneCollapsed,
  useWorkspace,
  type DrawerKind,
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

export { INSPECTOR_AUTO_COLLAPSE_WIDTH, autoCollapseFor, autoCollapseTransition } from "./shellLayout";

/**
 * 镜头带栏的最小高只有 `shotBandModel.bandMinHeight` 一份(故事 184 = 视口内容高,
 * 附属 284)。这里 re-export 只是让旧调用点不断 —— 壳不再自己算一份 160/260。
 */
export { bandMinHeight };

/** 转接完就该被 `#/` 覆盖掉的那几条旧 hash(规格 §7 的"不留旧路由")。 */
const LEGACY_HASHES: readonly string[] = ["#/import", "#/deliver", "#/settings", "#/review"];
export function isLegacyHash(hash: string): boolean {
  return LEGACY_HASHES.includes(hash.startsWith("#/") ? hash : `#/${hash.replace(/^#/, "")}`);
}

/** 旧 hash → 新壳动作;无法识别的 hash 落到工作区本体。 */
export function drawerForLegacyHash(hash: string): DrawerKind {
  const route = hash.replace(/^#\/?/, "");
  if (route === "import") return "import";
  if (route === "deliver") return "deliver";
  if (route === "settings") return "settings";
  return null; // #/review 与其它一律落到工作区本体
}

function CollapsedRail({
  label,
  icon,
  onExpand,
}: {
  label: string;
  icon: string;
  onExpand: () => void;
}): JSX.Element {
  return (
    <div className="workspace-rail">
      <button
        type="button"
        className="workspace-rail-button"
        title={`展开${label}`}
        onClick={onExpand}
      >
        <span className="workspace-rail-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="workspace-rail-label">{`展开${label}`}</span>
      </button>
    </div>
  );
}

export function WorkspaceShell(): JSX.Element {
  const poolWidth = useWorkspace((state) => state.poolWidth);
  const inspectorWidth = useWorkspace((state) => state.inspectorWidth);
  const monitorRatio = useWorkspace((state) => state.monitorRatio);
  const poolCollapsed = useWorkspace((state) => isPaneCollapsed(state, "pool"));
  const inspectorCollapsed = useWorkspace((state) => isPaneCollapsed(state, "inspector"));
  const bandMode = useWorkspace((state) => state.bandMode);
  const openDrawer = useWorkspace((state) => state.openDrawer);
  const viewingEpisode = useWorkspace((state) => state.viewingEpisode);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const bandPanelRef = usePanelRef();
  const [helpOpen, setHelpOpen] = useState(false);
  const helpToken = useRef({});

  // 拖动期间只改 CSS 变量,不 setState —— 三栏不重渲染(规格 §10);
  // 松手(onLayoutChanged)才把最终值 dispatch 出去,由 store 的 400ms debounce 落盘。
  const latest = useRef({ pool: poolWidth, inspector: inspectorWidth, monitor: monitorRatio });
  const paint = useCallback((name: string, value: string) => {
    shellRef.current?.style.setProperty(name, value);
  }, []);

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
    const stack = shellRef.current?.querySelector<HTMLElement>(".workspace-center-stack");
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
  }, [bandMode, fitBand]);

  useEffect(() => {
    // 窄窗自动折叠只碰 store 的 auto 位(set-auto-collapse),不碰用户手动位,也就
    // 不会被 persistedPairs 落盘——这正是 U-04 的根因:此前它派发 toggle-pane,把
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

  useEffect(() => {
    const apply = () => {
      const hash = window.location.hash;
      const drawer = drawerForLegacyHash(hash);
      if (drawer !== null) dispatchWorkspace({ type: "open-drawer", drawer });
      // 旧 hash 只用来"转接"一次,转接完就把地址栏收回 `#/`(R8 终审 L5)。
      // 不收的话刷新一次又会把同一个抽屉重新弹开——用户关掉的东西自己回来了。
      if (isLegacyHash(hash)) window.history.replaceState(null, "", "#/");
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  useEffect(() => {
    // 历史集只读查看(顶栏集切换里点一条已封存的集 → `openHistoricalEpisode`)。
    // 旧壳靠 SelectPage 接这个事件;新壳里没有 SelectPage,不接就等于点了没反应
    // (R8 终审 L6)。
    const onViewEpisode = (event: Event) => {
      const detail = (event as CustomEvent<{ id: number; title: string } | null>).detail;
      if (!detail || typeof detail.id !== "number") {
        // N-2:detail 为空 = 回到当前集(`returnToActiveEpisode`)。只读查看时选中的历史集素材
        // 不能带回当前集,按当前集校验一次。
        dispatchWorkspace({ type: "view-episode", episode: null });
        const { selection } = getWorkspaceSnapshot();
        const { clipsById, episode } = getClipsFeedSnapshot();
        if (!selectionBelongsToEpisode(selection, episode.activeId, clipsById)) {
          dispatchWorkspace({ type: "clear-selection" });
        }
        return;
      }
      dispatchWorkspace({ type: "view-episode", episode: { id: detail.id, title: detail.title } });
    };
    const onEpisodeChanged = (event: Event) => {
      dispatchWorkspace({ type: "view-episode", episode: null });
      // 新建 / 切换集后监视器与检查器不能还停在旧集的素材上(R-06):选中不在新集里就清掉。
      // 用未按集裁的 clipsById 判归属 —— feed 自己也在听这个事件,裁过的列表这一刻可能已经空了。
      const detail = (event as CustomEvent<{ id?: unknown } | null>).detail;
      const episodeId = typeof detail?.id === "number" ? detail.id : null;
      const { selection } = getWorkspaceSnapshot();
      if (!selectionBelongsToEpisode(selection, episodeId, getClipsFeedSnapshot().clipsById)) {
        dispatchWorkspace({ type: "clear-selection" });
      }
    };
    window.addEventListener("tripcut:view-episode", onViewEpisode);
    window.addEventListener("tripcut:episode-changed", onEpisodeChanged);
    return () => {
      window.removeEventListener("tripcut:view-episode", onViewEpisode);
      window.removeEventListener("tripcut:episode-changed", onEpisodeChanged);
    };
  }, []);

  // 规格 §3.2 的整张全局键位表(F6 轮栏、⌘1/⌘2 折叠、⌘⏎ 沉浸、⌘, 设置、⌘I 导入、
  // ? 帮助、Esc 四级优先级)都在这个 hook 里,壳本身不再各挂各的 keydown。
  useGlobalHotkeys();

  useEffect(() => {
    // R10 U-19:后端的 `tripcut:music-analyzed` Tauri 事件在壳层桥接一次成同名 window 事件,
    // 音乐面板 / 状态条各自 addEventListener。非 Tauri 环境里桥是 no-op。
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void bridgeMusicAnalyzedEvents().then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

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
      <Group orientation="horizontal" className="workspace-columns" onLayoutChanged={commitSizes}>
        {/*
          竖条与整栏是两个不同 id / key 的 Panel,而不是同一个 Panel 换 props:
          react-resizable-panels 按实例记尺寸,同一实例从 44px 竖条切成 minSize 280 的
          整栏时,44 < 280 且 `collapsible` 会让它直接塌成 0(U-04 真机「检查器整个消失」)。
          换 key 让它重新挂载,库按 panel id 组合取回上次的宽或 defaultSize。
          `collapsible` 也一并去掉——折叠是壳自己的竖条,不需要库再折一层。
        */}
        {poolCollapsed ? (
          <Panel key="pool-rail" id="pool-rail" defaultSize={44} minSize={44} maxSize={44} className="workspace-pool collapsed">
            <CollapsedRail
              icon="▤"
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

        <Panel id="center" minSize={520} className="workspace-center">
          <Group orientation="vertical" className="workspace-center-stack">
            <Panel
              defaultSize={`${Math.round(monitorRatio * 100)}%`}
              minSize={240}
              onResize={(size) => {
                // 故事模式下带被钉在 184,这个占比是算出来的,不是用户拖的 —— 不记,
                // 否则切回附属模式时用户上次拖好的分法就被冲掉了。
                if (bandMode === "story") return;
                latest.current.monitor = size.asPercentage / 100;
                paint("--monitor-ratio", `${size.asPercentage / 100}`);
              }}
            >
              <div
                aria-label="预览监视器"
                role="region"
                data-pane="monitor"
                tabIndex={-1}
                className="workspace-pane"
              >
                <Monitor />
              </div>
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
        </Panel>

        <Separator
          className="workspace-handle"
          aria-label="调整检查器宽度"
          aria-valuenow={Math.round(inspectorWidth)}
        >
          <span className="workspace-handle-grip" aria-hidden="true" />
        </Separator>

        {inspectorCollapsed ? (
          <Panel key="inspector-rail" id="inspector-rail" defaultSize={44} minSize={44} maxSize={44} className="workspace-inspector collapsed">
            <CollapsedRail
              icon="▥"
              label="检查器"
              onExpand={() => dispatchWorkspace({ type: "toggle-pane", pane: "inspector" })}
            />
          </Panel>
        ) : (
          <Panel
            key="inspector-pane"
            id="inspector-pane"
            defaultSize={inspectorWidth}
            minSize={INSPECTOR_WIDTH_MIN}
            maxSize={INSPECTOR_WIDTH_MAX}
            onResize={(size) => {
              latest.current.inspector = size.inPixels;
              paint("--inspector-width", `${Math.round(size.inPixels)}px`);
            }}
            className="workspace-inspector"
          >
            <div
              aria-label="检查器"
              role="region"
              data-pane="inspector"
              tabIndex={-1}
              className="workspace-pane"
            >
              <Inspector />
            </div>
          </Panel>
        )}
      </Group>
      <StatusStrip />
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
