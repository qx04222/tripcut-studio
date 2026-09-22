import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSettings, setSetting } from "../../api";
import { showToast } from "../ui/Toast";
import { failureText } from "../errorText";

/**
 * 镜头带的**视图**设置(缩放 / 折叠 / 角标),按集存在 `ui.band.view.<episode>`。
 * R22-C 验收决策:视图设置**静默**保存 —— 不弹 toast、不进 ⌘Z 栈。Codex 初版每按一次 ⌘−/⌥滚轮都弹
 * 「已缩放镜头带 · 撤销」并压一条撤销(截图里 toast 盖住镜块;连按三次三条),业主日常用会很吵;
 * 剪映 / Premiere 也不把缩放当编辑。⌘Z 只撤数据编辑(移动 / 移出 / 修剪 / 改名 / 忽略缺口 …)。
 * 保存失败仍要说出来(回滚到上一次成功值 + danger toast)。
 */

export const BAND_ZOOMS = [0.35, 0.5, 0.75, 1, 1.5, 2, 3] as const;
export interface BandPreferences { zoom: number; folded: string[]; badges: boolean }
export const DEFAULT_BAND_PREFERENCES: BandPreferences = { zoom: 1, folded: [], badges: false };
export function parseBandPreferences(raw: string | undefined): BandPreferences {
  try {
    const value = JSON.parse(raw ?? "{}");
    return { zoom: BAND_ZOOMS.includes(value.zoom) ? value.zoom : 1, folded: Array.isArray(value.folded) ? value.folded.filter((key: unknown) => typeof key === "string" && /^chapter:(\d+|none)$/.test(key)) : [], badges: value.badges === true };
  } catch { return DEFAULT_BAND_PREFERENCES; }
}

export function useBandPreferences(episodeId: number | null, readOnly: boolean) {
  const [value, setValue] = useState<BandPreferences>(DEFAULT_BAND_PREFERENCES);
  const persisted = useRef(value), live = useRef(value), scope = useRef(episodeId), generation = useRef(0);
  const queue = useRef(Promise.resolve());
  const confirmed = useRef(new Map<number, BandPreferences>());
  scope.current = episodeId; live.current = value;
  useEffect(() => {
    const token = ++generation.current;
    setValue(DEFAULT_BAND_PREFERENCES); persisted.current = DEFAULT_BAND_PREFERENCES;
    void getSettings().then(settings => {
      if (generation.current !== token) return;
      const next = parseBandPreferences(settings?.[`ui.band.view.${episodeId}`]);
      if (episodeId !== null) confirmed.current.set(episodeId, next);
      persisted.current = next; live.current = next; setValue(next);
    }).catch(() => undefined);
    return () => { generation.current += 1; };
  }, [episodeId]);
  const save = useCallback((next: BandPreferences, label: string) => {
    if (readOnly || episodeId === null) return;
    const before = persisted.current;
    if (JSON.stringify(next) === JSON.stringify(before)) return;
    generation.current += 1; persisted.current = next; live.current = next; setValue(next);
    const key = `ui.band.view.${episodeId}`;
    queue.current = queue.current.then(async () => {
      const previous = confirmed.current.get(episodeId) ?? DEFAULT_BAND_PREFERENCES;
      try {
        await setSetting(key, JSON.stringify(next));
        confirmed.current.set(episodeId, next);
      } catch (error) {
        if (scope.current === episodeId && persisted.current === next) { persisted.current = previous; live.current = previous; setValue(previous); }
        showToast(failureText(label, error), { tone: "danger" });
      }
    });
  }, [episodeId, readOnly]);
  const folded = useMemo(() => new Set(value.folded), [value.folded]);
  return {
    value, folded,
    previewZoom: (zoom: number) => { if (!readOnly) { const next = { ...live.current, zoom }; live.current = next; setValue(next); } },
    commitZoom: () => save(live.current, "缩放镜头带"),
    zoom: (zoom: number) => save({ ...live.current, zoom }, "缩放镜头带"),
    toggleFold: (key: string) => save({ ...live.current, folded: live.current.folded.includes(key) ? live.current.folded.filter(item => item !== key) : [...live.current.folded, key] }, "折叠/展开章节"),
    toggleBadges: () => save({ ...live.current, badges: !live.current.badges }, "切换镜头角标"),
  };
}
