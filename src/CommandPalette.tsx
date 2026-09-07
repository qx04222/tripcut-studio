import { useCallback, useEffect, useRef, useState } from "react";
import { Command } from "cmdk";

import { listClips, searchEverything, type ClipListItem, type GlobalSearchHit } from "./api";
import { openHistoricalEpisode } from "./historyView";
import { useFocusTrap } from "./useFocusTrap";
import { KIND_LABEL } from "./kindLabels";
import { useSearchAugment } from "./useSearchAugment";

interface CommandPaletteProps {
  onNavigate: (path: string) => void;
  onSelectClip: (clipId: number) => void;
}

/** P6-U1 全局命令面板(cmdk):Cmd+K——跳页、全量搜索(文件/转写/描述/标签/画面文字)、素材直达。 */
export function CommandPalette({ onNavigate, onSelectClip }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [clips, setClips] = useState<ClipListItem[]>([]);
  const [query, setQuery] = useState("");
  const [deepHits, setDeepHits] = useState<GlobalSearchHit[]>([]);
  const debounceRef = useRef<number | undefined>(undefined);
  const queryRef = useRef("");
  queryRef.current = query;
  // cmdk 的裸 <Command> (非 Command.Dialog)不带 focus trap——Command.Item
  // 不进 Tab 序列(靠内部方向键选中),只有 Command.Input 天然可聚焦,Tab 会
  // 直接漏到面板背后的页面。所以这里自己收一道。
  const paletteRef = useRef<HTMLDivElement>(null);
  useFocusTrap(paletteRef, open);
  const { augmentHits, describeHitEpisode } = useSearchAugment();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((value) => !value);
      }
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    const onOpenRequest = () => setOpen(true);
    window.addEventListener("tripcut:open-command-palette", onOpenRequest);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("tripcut:open-command-palette", onOpenRequest);
    };
  }, []);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setDeepHits([]);
      return;
    }
    void listClips()
      .then(setClips)
      .catch(() => setClips([]));
  }, [open]);

  // 全量搜索:250ms debounce,>=2 字触发
  useEffect(() => {
    window.clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setDeepHits([]);
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      // 记住发起时的查询词:慢的旧请求返回时不能覆盖新查询的结果
      const issuedFor = query;
      void searchEverything(query)
        .then(async (hits) => {
          if (issuedFor !== queryRef.current) return;
          const merged = await augmentHits(hits, issuedFor);
          if (issuedFor === queryRef.current) setDeepHits(merged);
        })
        .catch(() => {
          if (issuedFor === queryRef.current) setDeepHits([]);
        });
    }, 250);
    return () => window.clearTimeout(debounceRef.current);
  }, [query]);

  const go = useCallback(
    (path: string) => {
      onNavigate(path);
      setOpen(false);
    },
    [onNavigate],
  );

  const jumpToClip = useCallback(
    (clipId: number) => {
      onSelectClip(clipId);
      setOpen(false);
    },
    [onSelectClip],
  );

  const jumpToHit = useCallback(
    (hit: GlobalSearchHit) => {
      const { isHistorical, episodeTitle } = describeHitEpisode(hit);
      if (isHistorical && hit.episode_id !== null) {
        openHistoricalEpisode(hit.episode_id, episodeTitle ?? "历史集");
        setOpen(false);
        return;
      }
      jumpToClip(hit.clip_id);
    },
    [describeHitEpisode, jumpToClip],
  );

  if (!open) return null;

  return (
    <div className="command-palette-backdrop" role="presentation" onClick={() => setOpen(false)}>
      <Command
        label="全局命令"
        className="command-palette"
        shouldFilter={deepHits.length === 0}
        onClick={(event) => event.stopPropagation()}
        ref={paletteRef}
        role="dialog"
        aria-modal="true"
      >
        <Command.Input
          // eslint-disable-next-line jsx-a11y/no-autofocus -- 命令面板打开即为唯一交互目标,不抢焦点则键盘用户无法输入,这是该组件模式的预期行为。
          autoFocus
          placeholder="跳转页面、全量搜索(文件/转写/AI描述/标签)…"
          value={query}
          onValueChange={setQuery}
        />
        <Command.List>
          <Command.Empty>没有匹配项</Command.Empty>
          {deepHits.length > 0 ? (
            <Command.Group heading="全量搜索">
              {deepHits.map((hit, index) => {
                const { isHistorical } = describeHitEpisode(hit);
                return (
                  <Command.Item
                    key={`${hit.kind}-${hit.clip_id}-${index}`}
                    value={`deep-${hit.kind}-${hit.clip_id}-${index}`}
                    onSelect={() => jumpToHit(hit)}
                  >
                    <span className="hit-kind">{KIND_LABEL[hit.kind] ?? hit.kind}</span>
                    <span className="hit-file">{hit.file_name.split("/").pop()}</span>
                    <span className="hit-excerpt">{hit.excerpt}</span>
                    {isHistorical ? <span className="hit-history-badge">历史集（只读）</span> : null}
                  </Command.Item>
                );
              })}
            </Command.Group>
          ) : null}
          <Command.Group heading="页面">
            <Command.Item onSelect={() => go("/import")}>01 · 导入素材</Command.Item>
            <Command.Item onSelect={() => go("/review")}>02 · 筛片工作台</Command.Item>
            <Command.Item onSelect={() => go("/deliver")}>03 · 交付</Command.Item>
            <Command.Item onSelect={() => go("/settings")}>04 · 设置</Command.Item>
          </Command.Group>
          {deepHits.length === 0 ? (
            <Command.Group heading="素材直达">
              {clips.slice(0, 200).map((clip) => (
                <Command.Item
                  key={clip.id}
                  value={`clip ${clip.file_name}`}
                  onSelect={() => jumpToClip(clip.id as number)}
                >
                  {clip.file_name}
                </Command.Item>
              ))}
            </Command.Group>
          ) : null}
        </Command.List>
      </Command>
    </div>
  );
}
