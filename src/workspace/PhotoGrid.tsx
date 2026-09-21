import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from "react";
import { listSimilarGroups, type SimilarGroup } from "../api";
import { requestDuel, SIMILAR_GROUPS_CHANGED } from "./duel/duelBus";
import { PaneHead } from "./PaneHead";
import { PoolCard } from "./PoolCard";
import { useMediaPoolHotkeys } from "./MediaPoolHotkeys";
import { buildPhotoSections } from "./photoWorkspaceModel";
import { setPoolOrder } from "./poolOrder";
import { Button } from "./ui";
import { useClipsFeed } from "./useClipsFeed";
import { useSelection } from "./useSelection";
import { dispatchWorkspace, useWorkspace } from "./WorkspaceStore";
import { usePoolGridNavigation } from "./usePoolGridNavigation";

export function PhotoGrid(): JSX.Element {
  const feed = useClipsFeed();
  const photos = useMemo(() => feed.clips.filter((clip) => clip.kind === "photo"), [feed.clips]);
  const [groups, setGroups] = useState<SimilarGroup[]>([]);
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(() => new Set());
  const readOnly = useWorkspace((state) => state.viewingEpisode !== null);
  const anchorId = useWorkspace((state) => state.anchorClipId);
  const sections = useMemo(() => buildPhotoSections(photos, groups, expandedGroups), [photos, groups, expandedGroups]);
  const visibleIds = useMemo(() => sections.flatMap((section) => section.items.map((item) => item.clip.id).filter((id): id is number => id !== null)), [sections]);
  const selection = useSelection(visibleIds);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const gridHadFocus = useRef(false);
  const [columns, setColumns] = useState(1);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = (width: number) => setColumns(Math.max(1, Math.min(4, Math.floor((width + 10) / 160))));
    update(viewport.clientWidth);
    const observer = new ResizeObserver((entries) => update(entries[0]?.contentRect.width ?? viewport.clientWidth));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);
  const layoutSections = useMemo(() => {
    let rowIndex = 0;
    return sections.map((section) => {
      const rows = [];
      for (let index = 0; index < section.items.length; index += columns) {
        rows.push({ items: section.items.slice(index, index + columns), rowIndex: ++rowIndex });
      }
      return { ...section, rows };
    });
  }, [columns, sections]);
  const navigationRows = useMemo(() => layoutSections.flatMap((section) => section.rows.map((row) => row.items.map((item) => item.clip.id!))), [layoutSections]);
  const rowCount = layoutSections.reduce((count, section) => count + section.rows.length, 0);
  useEffect(() => setPoolOrder(visibleIds), [visibleIds]);
  const loadGroups = () => void listSimilarGroups().then(setGroups).catch(() => setGroups([]));
  const toggleGroup = (groupId: number) => {
    if (expandedGroups.has(groupId)) {
      const group = groups.find((candidate) => candidate.id === groupId);
      const primary = group?.members.find((member) => member.is_primary) ?? group?.members[0];
      const selectedId = selection.selectedClip?.id;
      if (primary && selectedId !== null && selectedId !== primary.clip_id && group?.members.some((member) => member.clip_id === selectedId)) {
        selection.selectClip(primary.clip_id);
      }
    }
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
      return next;
    });
  };
  useEffect(() => {
    loadGroups();
    window.addEventListener(SIMILAR_GROUPS_CHANGED, loadGroups);
    return () => window.removeEventListener(SIMILAR_GROUPS_CHANGED, loadGroups);
  }, []);
  const hotkeys = useMediaPoolHotkeys({
    anchorId,
    anchorStack: null,
    clipsById: feed.clipsById,
    multiSelection: selection.multiSelection,
    expandedStackId: null,
    setExpandedStackId: () => undefined,
    selectClip: selection.selectClip,
  });
  const browsingHotkeys = readOnly ? { onKeyDown: () => undefined } : hotkeys;
  const onGridKeyDown = usePoolGridNavigation({
    viewportRef,
    gridHadFocus,
    anchorId,
    startRow: 0,
    endRow: visibleIds.length,
    visibleCount: visibleIds.length,
    inTakes: false,
    visibleIds,
    navigationRows,
    columns,
    viewportHeight: viewportRef.current?.clientHeight ?? 0,
    setScrollTop: () => undefined,
    selectClip: selection.selectClip,
    hotkeys: browsingHotkeys,
    selectFirstOnEntry: true,
  });
  return (
    <section className="photo-ws-grid-pane" aria-label="照片网格">
      <PaneHead title="照片网格" meta={`${photos.length} 张`} />
      <div
        className="photo-ws-grid-scroll"
        ref={viewportRef}
        role="grid"
        aria-label="照片网格"
        aria-colcount={columns}
        aria-rowcount={rowCount}
        data-pane="pool"
        style={{ "--photo-grid-columns": columns } as CSSProperties}
        tabIndex={0}
        onFocus={() => { gridHadFocus.current = true; dispatchWorkspace({ type: "focus-pane", pane: "pool" }); }}
        onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) gridHadFocus.current = false; }}
        onKeyDown={onGridKeyDown}
        onCompositionStart={readOnly ? undefined : hotkeys.onCompositionStart}
        onCompositionEnd={readOnly ? undefined : hotkeys.onCompositionEnd}
      >
        {layoutSections.map((section) => (
          <div className="photo-ws-date-group" key={section.key} role="rowgroup" aria-label={section.label}>
            <header role="presentation">{section.label}</header>
            {section.rows.map((row) => (
              <div className="photo-ws-grid-item-row" role="row" aria-rowindex={row.rowIndex} key={`${section.key}-${row.rowIndex}`}>
                {row.items.map((item, columnIndex) => {
                  const duelClipIds = item.similarClipIds.filter((id) => {
                    const candidate = feed.clipsById.get(id);
                    return candidate?.kind === "photo" && !candidate.missing_since && candidate.binary_rating !== -1;
                  });
                  return (
                    <div className="photo-ws-card-wrap" role="gridcell" key={item.clip.id} aria-colindex={columnIndex + 1} aria-selected={selection.selectedClip?.id === item.clip.id}>
                      <PoolCard
                        clip={item.clip}
                        columnIndex={columnIndex + 1}
                        standaloneGridCell={false}
                        selected={selection.selectedClip?.id === item.clip.id}
                        isAnchor={anchorId === item.clip.id}
                        inMultiSelection={item.clip.id !== null && selection.multiSelection.includes(item.clip.id)}
                        onSelect={item.clip.id === null ? () => undefined : (modifiers) => selection.selectClip(item.clip.id!, modifiers)}
                      />
                      <div className="photo-ws-card-flags">
                        {item.suspectedJunk ? <span className="photo-ws-junk-chip">疑似废片</span> : null}
                        {item.similarPrimary && item.similarGroupExpanded ? <span className="photo-ws-primary-chip">主图</span> : null}
                        {item.similarCount > 1 && item.similarPrimary ? (
                          <>
                            <span className="photo-ws-similar-count">×{item.similarCount}</span>
                            <Button size="sm" variant="ghost" aria-label={`${item.similarGroupExpanded ? "收起" : "展开"}相似组 ${item.similarCount} 张`} onClick={() => toggleGroup(item.similarGroupId!)}>{item.similarGroupExpanded ? "收起" : "展开"}</Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={readOnly || duelClipIds.length < 2}
                              title={duelClipIds.length < 2 ? "至少需要两张未被 X 拒绝的照片；先按 F 保留、清除评级，或换一张。" : undefined}
                              onClick={() => requestDuel({ clipIds: duelClipIds, source: "similar_group" })}
                            >擂台</Button>
                          </>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ))}
        {!feed.loading && photos.length === 0 ? <p className="photo-ws-empty" role="status">这一集还没有照片。导入照片后会按日期与时段出现在这里。</p> : null}
      </div>
    </section>
  );
}
