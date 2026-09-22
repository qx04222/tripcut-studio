import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from "react";
import { getWorkspaceSnapshot, useWorkspace } from "../WorkspaceStore";
import type { BandSegment } from "../shotBandModel";
import { keysInBox, selectBandKey, type BandSelection, type KeyRect, type Point } from "./selection";
import { releasePlaythrough } from "../playthrough/store";

export function useBandSelection(segments: readonly BandSegment[], episodeId: number | null, viewport: RefObject<HTMLDivElement | null>) {
  const order = useMemo(() => segments.filter(segment => segment.kind === "clip").map(segment => segment.key), [segments]);
  const [state, setState] = useState<BandSelection>({ keys: [], anchor: null });
  const [activeKey, setActive] = useState<string | null>(null);
  const [box, setBox] = useState<{ a: Point; b: Point } | null>(null);
  const gesture = useRef<{ a: Point; base: readonly string[]; rectangles: KeyRect[] } | null>(null);
  const suppressClick = useRef(false);
  const external = useWorkspace(value => value.selection);
  useEffect(() => {
    if (getWorkspaceSnapshot().focusedPane === "band") return;
    const match = external?.kind === "clip" ? segments.find(segment => segment.clipId === external.clipId) : null;
    setState({ keys: match ? [match.key] : [], anchor: match?.key ?? null }); setActive(match?.key ?? null);
  }, [external, segments]);
  useEffect(() => { setState({ keys: [], anchor: null }); setActive(null); }, [episodeId]);
  useEffect(() => { setState(current => ({ ...current, keys: current.keys.filter(key => order.includes(key)) })); }, [order]);
  const point = (event: PointerEvent<HTMLDivElement>): Point => {
    const node = event.currentTarget, rect = node.getBoundingClientRect();
    return { x: event.clientX - rect.left + node.scrollLeft, y: event.clientY - rect.top + node.scrollTop };
  };
  const select = (segment: BandSegment, event?: MouseEvent<HTMLElement>) => {
    if (suppressClick.current) { suppressClick.current = false; return false; }
    // 0.11.3 接线:⇧ / ⌘ 多选 = 开始编辑镜头带 → 连播停、素材继续播(单选照旧由选中变化 / seek 处理)。
    if (event && (event.shiftKey || event.metaKey || event.ctrlKey)) releasePlaythrough();
    setActive(segment.key);
    setState(current => selectBandKey(current, order, segment.key, event));
    return true;
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !(event.target instanceof HTMLElement) || event.target.closest("[data-band-key],button,input,[role=rowheader]")) return;
    const node = event.currentTarget, rect = node.getBoundingClientRect(), a = point(event);
    const rectangles = Array.from(node.querySelectorAll<HTMLElement>('[data-guide="shot"][data-band-key]')).map(element => {
      const r = element.getBoundingClientRect();
      return { key: element.dataset.bandKey!, left: r.left - rect.left + node.scrollLeft, right: r.right - rect.left + node.scrollLeft, top: r.top - rect.top + node.scrollTop, bottom: r.bottom - rect.top + node.scrollTop };
    });
    gesture.current = { a, rectangles, base: event.metaKey || event.ctrlKey ? state.keys : [] };
    setState({ keys: gesture.current.base, anchor: null });
    setBox({ a, b: a }); node.setPointerCapture?.(event.pointerId); node.focus(); event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = gesture.current; if (!drag) return;
    const b = point(event), keys = [...new Set([...drag.base, ...keysInBox(drag.a, b, drag.rectangles)])];
    setBox({ a: drag.a, b }); setState({ keys, anchor: keys[0] ?? null });
    const opened = Math.abs(b.x - drag.a.x) + Math.abs(b.y - drag.a.y) > 3;
    // 0.11.3 接线:框选真的拉开(> 3 px)才算开始编辑 → 连播停;只点一下空白不算。
    if (opened && !suppressClick.current) releasePlaythrough();
    suppressClick.current = opened;
  };
  const finish = () => { gesture.current = null; setBox(null); window.setTimeout(() => { suppressClick.current = false; }, 0); };
  return {
    keys: state.keys, selected: new Set(state.keys), activeKey, box, select,
    all: () => setState({ keys: order, anchor: order[0] ?? null }),
    dragKeys: (key: string) => state.keys.includes(key) ? state.keys : [key],
    handlers: { onPointerDown, onPointerMove, onPointerUp: finish, onPointerCancel: finish },
    focus: () => viewport.current?.focus(),
  };
}
