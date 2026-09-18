import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type UIEvent,
} from "react";

import { playerCommand, searchClips, searchTranscripts } from "../api";
import { PoolEmpty, PoolFilteredEmpty } from "./emptyStates";
import { useMediaPoolHotkeys } from "./MediaPoolHotkeys";
import { PoolStackStrip } from "./MediaPoolStackStrip";
import { PoolClipContextMenu } from "./ClipMenu";
import { PaneHead } from "./PaneHead";
import { PoolCard } from "./PoolCard";
import { setPoolOrder } from "./poolOrder";
import { INITIAL_POOL_EXTRA_FILTERS, PoolFilters, type PoolExtraFilters } from "./PoolFilters";
import {
  GRID_OVERSCAN_ROWS,
  POOL_ROW_HEIGHT,
  buildShotStackWallItems,
  filterClipsByDimension,
  filterClipsByOrientation,
  filterSelectionClips,
  matchClipsByFileName,
  poolColumnCount,
  poolRowAtOffset,
  poolRowTop,
  type SelectionFilter,
} from "./poolModel";
import { useClipsFeed } from "./useClipsFeed";
import { useSelection } from "./useSelection";
import { dispatchWorkspace, useWorkspace } from "./WorkspaceStore";
import { isCompactWidth } from "./shellLayout";
import { failureText } from "./errorText";

const FILTER_ORDER: readonly SelectionFilter[] = ["all", "favorite", "unrated", "rejected"];

export function MediaPool(): JSX.Element {
  const feed = useClipsFeed();
  const filter = useWorkspace((state) => state.filter);
  const dimension = useWorkspace((state) => state.dimension);
  const query = useWorkspace((state) => state.query);
  const paneWidth = useWorkspace((state) => state.poolWidth);
  // 池内展开的 Stack(U-02):点角标「n 条候选」或在卡片上按 Tab。
  const [expandedStackId, setExpandedStackId] = useState<number | null>(null);

  const [extras, setExtras] = useState<PoolExtraFilters>(INITIAL_POOL_EXTRA_FILTERS);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [semanticScores, setSemanticScores] = useState<ReadonlyMap<number, number>>(
    () => new Map(),
  );
  const [searchRestriction, setSearchRestriction] = useState<ReadonlySet<number> | null>(null);
  // R18 C-2:命中的是第几秒(帧级向量精排出来的)。只到素材级的老库这张表是空的。
  const [semanticSeconds, setSemanticSeconds] = useState<ReadonlyMap<number, number>>(
    () => new Map(),
  );
  const searchRequest = useRef(0);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  // 焦点是否还属于网格。卡片被虚拟化卸载时浏览器不给我们一个"去了哪里"的 blur,
  // 只有焦点真的落到网格外的元素上才清掉这个标记。
  const gridHadFocus = useRef(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(560);
  const [columns, setColumns] = useState(() => poolColumnCount(paneWidth));

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => {
      setViewportHeight(Math.max(1, viewport.clientHeight));
      // 栏宽以实测为准,store 里的值是拖动落定后的值,拖动中途它还没更新。
      // R18 V-18:列数两档 —— 紧凑档(R19 V-11:<--bp-compact,壳的唯一断点)最多两列。此前池宽锁 320,
      // 1280 下仍排三列,卡只是更挤;窗口窄的时候要的是更大的卡,不是更多的卡。
      const byWidth = poolColumnCount(viewport.clientWidth || paneWidth);
      const wide = typeof window === "undefined" || !isCompactWidth(window.innerWidth);
      setColumns(wide ? byWidth : (Math.min(byWidth, 2) as 2 | 3 | 4));
    };
    measure();
    // 池自己的宽度不随窗口变(默认锁 320),所以窗口变窄时 ResizeObserver 不会响 —— 另挂一个。
    if (typeof window !== "undefined") window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(viewport);
    return () => {
      if (typeof window !== "undefined") window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [paneWidth]);

  const clips = useMemo(() => [...feed.clips], [feed.clips]);
  // 搜索回调要读「此刻」的素材表做文件名匹配,不能把 clips 放进它的依赖里
  // (那会让每次轮询都换一个 runSearch 身份)。
  const clipsRef = useRef(clips);
  clipsRef.current = clips;
  const dimensions = useMemo(() => [...feed.dimensions], [feed.dimensions]);
  const shotStacks = useMemo(() => [...feed.shotStacks], [feed.shotStacks]);

  const qualityExemptClipIds = useMemo(() => {
    const exempt = new Set<number>();
    for (const stack of shotStacks) {
      if (!stack.quality_exempt) continue;
      for (const member of stack.members) exempt.add(member.clip_id);
    }
    return exempt;
  }, [shotStacks]);

  const counts = useMemo(() => {
    const next = {} as Record<SelectionFilter, number>;
    for (const candidate of FILTER_ORDER) {
      next[candidate] = filterSelectionClips(clips, candidate, false).length;
    }
    return next;
  }, [clips]);

  const dimensionLabelOptions = useMemo(() => {
    if (!dimension) return [] as string[];
    return [
      ...new Set(
        dimensions.filter((item) => item.dimension === dimension).map((item) => item.label),
      ),
    ].sort();
  }, [dimensions, dimension]);

  const items = useMemo(() => {
    let filtered = filterSelectionClips(clips, filter, extras.excludeSuspect, qualityExemptClipIds);
    filtered = filterClipsByDimension(filtered, dimensions, dimension, extras.dimensionLabel);
    filtered = filterClipsByOrientation(filtered, extras.portraitOnly ? "portrait" : "all");
    if (searchRestriction) {
      filtered = filtered.filter((clip) => clip.id !== null && searchRestriction.has(clip.id));
    }
    return buildShotStackWallItems(
      filtered,
      clips,
      shotStacks,
      extras.hideDuplicates,
      semanticScores,
    );
  }, [
    clips,
    filter,
    extras,
    qualityExemptClipIds,
    dimensions,
    dimension,
    searchRestriction,
    shotStacks,
    semanticScores,
  ]);

  const visibleIds = useMemo(
    () => items.map((item) => item.clip.id).filter((id): id is number => id !== null),
    [items],
  );
  const { selection, multiSelection, selectClip } = useSelection(visibleIds);
  // R11 §3:监视器「播完自动下一条」按这份可见顺序走。
  useEffect(() => setPoolOrder(visibleIds), [visibleIds]);
  const selectedId = selection?.kind === "clip" ? selection.clipId : null;
  const storeAnchorId = useWorkspace((state) => state.anchorClipId);
  // 锚点 = 最后一次点击的素材。选中的是镜头带的空槽位时,网格的漫游落点仍留在
  // 上一张卡片上,不然键盘会整个失去入口。
  const anchorId = selectedId ?? (storeAnchorId !== null && visibleIds.includes(storeAnchorId) ? storeAnchorId : null);

  const runSearch = useCallback(async (query: string) => {
    const request = ++searchRequest.current;
    if (!query) {
      setSemanticScores(new Map());
      setSemanticSeconds(new Map());
      setSearchRestriction(null);
      setSearchError(null);
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      const [hits, transcripts] = await Promise.all([
        searchClips(query).catch(() => []),
        searchTranscripts(query).catch(() => []),
      ]);
      if (request !== searchRequest.current) return;
      const scores = new Map<number, number>();
      const seconds = new Map<number, number>();
      for (const hit of hits) {
        scores.set(hit.clip_id, hit.score);
        const tbNum = hit.tb_num ?? 0;
        const tbDen = hit.tb_den ?? 0;
        if (hit.best_t_ticks !== null && hit.best_t_ticks !== undefined && tbDen > 0 && tbNum > 0) {
          seconds.set(hit.clip_id, (hit.best_t_ticks * tbNum) / tbDen);
        }
      }
      // U-15:文件名子串也算命中(⌘K 早就这么搜,池内搜索却只走语义/对白索引,
      // 「登机」搜不到 IMG_0813_登机口.mov 就是这条缺口)。前端并集,不改 Rust。
      const allowed = new Set<number>([
        ...hits.map((hit) => hit.clip_id),
        ...transcripts.map((match) => match.clip_id),
        ...matchClipsByFileName(clipsRef.current, query),
      ]);
      setSemanticScores(scores);
      setSemanticSeconds(seconds);
      setSearchRestriction(allowed);
    } catch (error) {
      if (request === searchRequest.current) setSearchError(failureText("搜索", error, "换个词再试"));
    } finally {
      if (request === searchRequest.current) setSearching(false);
    }
  }, []);

  // U-15:搜索词被清空(输入框删光、Esc、⌘K)即自动复原,不必再按一次「搜索」。
  useEffect(() => {
    if (query === "") void runSearch("");
  }, [query, runSearch]);

  const anchorStack = anchorId === null ? null : feed.shotStackByClipId.get(anchorId) ?? null;
  // 展开的 Stack 被筛选/搜索从网格里裁掉之后,候选条也跟着收起 —— 不留一条无主的展开。
  const expandedStack = useMemo(
    () => (expandedStackId === null ? null : items.find((item) => item.stack?.id === expandedStackId)?.stack ?? null),
    [expandedStackId, items],
  );
  // R18 W-5:`React.memo(PoolCard)` 此前被两个内联闭包打穿——`onToggleStack` 与
  // `onSelect` 每次 MediaPool 渲染都是新函数,可见的 ~32 张卡全部重协调。
  //
  // 不能用自定义比较器忽略这两个回调(`onToggleStack` 捕获 `expandedStackId`,
  // 忽略它会用旧状态切换),也不想改 PoolCard 的 props 形状。做法是:
  // ① `toggleStack` 用函数式 setState,不再捕获 `expandedStackId`,本身恒定;
  // ② `selectClip` 的身份每次选中都会变(它捕获 multiSelection / anchor),
  //    所以放进 ref,外面包一层恒定的转发函数;
  // ③ 每条素材 / 每个 Stack 的回调各缓存一份,按 id 记在 ref 里,永不换引用。
  const toggleStack = useCallback(
    (stackId: number) => setExpandedStackId((previous) => (previous === stackId ? null : stackId)),
    [],
  );
  const selectClipRef = useRef(selectClip);
  selectClipRef.current = selectClip;
  const secondsRef = useRef(semanticSeconds);
  secondsRef.current = semanticSeconds;
  const toggleHandlers = useRef(new Map<number, () => void>());
  const selectHandlers = useRef(new Map<number, (modifiers: { shift?: boolean; meta?: boolean }) => void>());
  const toggleHandler = useCallback(
    (stackId: number) => {
      const cached = toggleHandlers.current.get(stackId);
      if (cached) return cached;
      const handler = () => toggleStack(stackId);
      toggleHandlers.current.set(stackId, handler);
      return handler;
    },
    [toggleStack],
  );
  const selectHandler = useCallback((clipId: number) => {
    const cached = selectHandlers.current.get(clipId);
    if (cached) return cached;
    const handler = (modifiers: { shift?: boolean; meta?: boolean }) => selectClipRef.current(clipId, modifiers);
    selectHandlers.current.set(clipId, handler);
    return handler;
  }, []);
  // R18 C-2:点「第 n 秒」= 先选中这条(监视器才会载它),再把播放头拉到那一秒。
  // 和 selectHandler 一样按 clipId 缓存成恒定引用,不然 PoolCard 的 memo 每次都失效。
  const seekHandlers = useRef(new Map<number, () => void>());
  const seekHandler = useCallback((clipId: number) => {
    const cached = seekHandlers.current.get(clipId);
    if (cached) return cached;
    const handler = () => {
      selectClipRef.current(clipId, {});
      const seconds = secondsRef.current.get(clipId);
      if (seconds === undefined) return;
      void playerCommand({ type: "seek_abs", seconds }, clipId).catch(() => undefined);
    };
    seekHandlers.current.set(clipId, handler);
    return handler;
  }, []);
  // 没有 clip_id 的卡片(占位)点了不该做事,但也不能每次渲染换一个新函数。
  const noopSelect = useCallback(() => undefined, []);
  const hotkeys = useMediaPoolHotkeys({
    anchorId,
    anchorStack,
    clipsById: feed.clipsById,
    multiSelection,
    expandedStackId,
    setExpandedStackId,
    selectClip,
  });

  const rowCount = Math.ceil(items.length / columns);
  const startRow = Math.min(
    Math.max(0, rowCount - 1),
    Math.max(0, poolRowAtOffset(scrollTop) - GRID_OVERSCAN_ROWS),
  );
  const visibleRows = Math.ceil(viewportHeight / POOL_ROW_HEIGHT) + GRID_OVERSCAN_ROWS * 2;
  const endRow = Math.min(rowCount, startRow + visibleRows);
  const visible = items.slice(startRow * columns, endRow * columns);
  // 按列数切成行。**不是**排版需要 —— CSS grid 自己会换行;这是 ARIA 的硬要求:
  // WebKit(WKWebView)的 ARIA grid 映射只把 role=row 当作 table 的合法子节点,
  // gridcell 上面没有 row 祖先时,整棵 AXTable 的后代会被剪光,媒体池对
  // VoiceOver 与 AX 探针就是一张空表(R8 真机复现)。行必须是**真实盒子**:
  // 先前写成 display:contents,WebKit 连这层 row 一起剪掉,真机上 500 条素材
  // 只剩 1 个 AXRow / 1 个 AXCell(R8 真机 #3)。现在每行自己是一排 grid。
  const visibleRowsChunks = Array.from({ length: Math.max(0, endRow - startRow) }, (_, offset) =>
    visible.slice(offset * columns, (offset + 1) * columns),
  ).filter((row) => row.length > 0);

  // 虚拟化会把锚点卡片整个卸载掉 —— 焦点跟着卡片一起消失,键盘就此失灵。
  // 卡片还在就把焦点放回卡片,卡片没了就交还给容器(aria-activedescendant 仍指着锚点)。
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (!gridHadFocus.current) return;
    const active = document.activeElement;
    // 卡片被卸载时焦点会掉到 <body> —— 那正是要救的情形,所以 body 也算"还是我们的"。
    if (active !== null && active !== document.body && !viewport.contains(active)) return;
    const card = anchorId === null ? null : document.getElementById(`pool-clip-${anchorId}`);
    if (card) {
      if (active !== card) card.focus();
    } else if (active !== viewport) {
      viewport.focus();
    }
  }, [anchorId, startRow, endRow, visible.length]);

  const onGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Stack 展开时 ↑↓ 在候选里移动(useMediaPoolHotkeys),不做网格漫游。
    const inTakes = expandedStack !== null && anchorStack?.id === expandedStack.id;
    const takesKey = event.key === "ArrowUp" || event.key === "ArrowDown";
    if (anchorId === null || visibleIds.length === 0 || (inTakes && takesKey)) {
      hotkeys.onKeyDown(event);
      return;
    }
    const index = visibleIds.indexOf(anchorId);
    if (index < 0) {
      hotkeys.onKeyDown(event);
      return;
    }
    const step =
      event.key === "ArrowRight" ? 1
      : event.key === "ArrowLeft" ? -1
      : event.key === "ArrowDown" ? columns
      : event.key === "ArrowUp" ? -columns
      : 0;
    if (step === 0) {
      hotkeys.onKeyDown(event);
      return;
    }
    event.preventDefault();
    const nextIndex = Math.min(visibleIds.length - 1, Math.max(0, index + step));
    const next = visibleIds[nextIndex];
    if (next === undefined) return;
    selectClip(next);
    // 目标行可能在渲染窗口之外(那时 DOM 里根本没有这张卡,scrollIntoView 无从谈起),
    // 所以先把视口滚过去,再让已经渲染出来的那张自己对齐。
    const viewport = viewportRef.current;
    if (viewport) {
      const top = poolRowTop(Math.floor(nextIndex / columns));
      const bottom = top + POOL_ROW_HEIGHT;
      const height = viewport.clientHeight || viewportHeight;
      let nextScrollTop = viewport.scrollTop;
      if (top < nextScrollTop) nextScrollTop = top;
      else if (bottom > nextScrollTop + height) nextScrollTop = bottom - height;
      if (nextScrollTop !== viewport.scrollTop) {
        viewport.scrollTop = nextScrollTop;
        setScrollTop(nextScrollTop);
      }
    }
    document.getElementById(`pool-clip-${next}`)?.scrollIntoView?.({ block: "nearest" });
  };

  return (
    <div
      className="media-pool"
      onFocus={() => dispatchWorkspace({ type: "focus-pane", pane: "pool" })}
    >
      <PaneHead title="媒体池" meta={feed.loading ? "整理中" : items.length === clips.length ? `${clips.length} 条` : `${items.length} / ${clips.length} 条`} />
      <PoolFilters
        counts={counts}
        dimensionLabelOptions={dimensionLabelOptions}
        extras={extras}
        onExtrasChange={setExtras}
        onSearch={(query) => void runSearch(query)}
        searching={searching}
      />
      {searchError ? (
        <p className="pool-error" role="status">
          搜索失败:{searchError}
        </p>
      ) : null}
      <div
        className={items.length === 0 ? "pool-grid-viewport is-empty" : "pool-grid-viewport"}
        ref={viewportRef}
        role="grid"
        aria-label="媒体池"
        aria-rowcount={rowCount}
        aria-colcount={columns}
        aria-activedescendant={anchorId === null ? undefined : `pool-clip-${anchorId}`}
        // 有锚点时入口在锚点卡片上,容器退出 Tab 序 —— 网格内始终只有一个 tabIndex=0。
        tabIndex={anchorId === null ? 0 : -1}
        data-total-clips={items.length}
        onFocus={() => {
          gridHadFocus.current = true;
        }}
        onBlur={(event) => {
          const next = event.relatedTarget as Node | null;
          if (next !== null && !event.currentTarget.contains(next)) gridHadFocus.current = false;
        }}
        onScroll={(event: UIEvent<HTMLDivElement>) => setScrollTop(event.currentTarget.scrollTop)}
        onKeyDown={onGridKeyDown}
        onCompositionStart={hotkeys.onCompositionStart}
        onCompositionEnd={hotkeys.onCompositionEnd}
      >
        <div className="pool-grid-canvas" style={{ height: poolRowTop(rowCount) }}>
          <div
            className="pool-grid-window"
            style={{ transform: `translateY(${poolRowTop(startRow)}px)` }}
          >
            {visibleRowsChunks.map((row, rowOffset) => (
              <div
                className="pool-grid-row"
                role="row"
                key={`row-${startRow + rowOffset}`}
                aria-rowindex={startRow + rowOffset + 1}
                style={{
                  gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                  height: `${POOL_ROW_HEIGHT - 10}px`,
                }}
              >
                {row.map((item, columnOffset) => (
                  <PoolCard
                    key={item.stack ? `stack-${item.stack.id}` : `clip-${item.clip.id}`}
                    clip={item.clip}
                    columnIndex={columnOffset + 1}
                    semanticScore={item.semanticScore}
                    semanticAtSeconds={
                      item.clip.id === null ? undefined : semanticSeconds.get(item.clip.id)
                    }
                    onSeekToMatch={item.clip.id === null ? undefined : seekHandler(item.clip.id)}
                    stackCount={item.stack ? item.stack.members.length : undefined}
                    stackExpanded={item.stack ? item.stack.id === expandedStackId : undefined}
                    onToggleStack={item.stack ? toggleHandler(item.stack.id) : undefined}
                    // 选中的是 Stack 里某条候选时,代表卡也算选中 —— 网格里没有那条的卡。
                    selected={
                      item.clip.id === selectedId ||
                      (item.stack !== undefined &&
                        selectedId !== null &&
                        item.stack.members.some((member) => member.clip_id === selectedId))
                    }
                    isAnchor={item.clip.id === anchorId}
                    inMultiSelection={item.clip.id !== null && multiSelection.includes(item.clip.id)}
                    onSelect={item.clip.id === null ? noopSelect : selectHandler(item.clip.id)}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      {/* U-06:空库给大号「导入素材」入口,筛选无命中才给「清空筛选」。R-07:放在 grid **外面**——
          WebKit 把 role=grid 的非 row 子节点从 AX 树剔掉,按钮在里面按名字找不到;空态时 grid 靠 is-empty 缩成 0 高。 */}
      {!feed.loading && items.length === 0 ? (
        clips.length === 0 ? (
          <PoolEmpty />
        ) : (
          <PoolFilteredEmpty
            onReset={() => {
              setExtras(INITIAL_POOL_EXTRA_FILTERS);
              dispatchWorkspace({ type: "set-dimension", dimension: "" });
              dispatchWorkspace({ type: "set-query", query: "" });
            }}
          />
        )
      ) : null}
      {feed.loading ? <p className="pool-empty">正在整理素材</p> : null}
      {expandedStack ? (
        <PoolStackStrip
          stack={expandedStack}
          clipsById={feed.clipsById}
          activeClipId={selectedId}
          onPick={(member) => selectClip(member.clip_id)}
          onClose={() => setExpandedStackId(null)}
        />
      ) : null}
      {/* R16 §1:素材卡右键菜单(收藏 / 拒绝 / 清除评级 / 加入镜头带 / 导出所选 / 移除素材;自己去同级 grid 上挂 contextmenu)。 */}
      <PoolClipContextMenu multiSelection={multiSelection} />
    </div>
  );
}
