import { useCallback, useEffect, useRef, useState } from "react";
import { Command } from "cmdk";

import { listClips, searchEverything, type ClipListItem, type GlobalSearchHit } from "./api";

interface CommandPaletteProps {
  onNavigate: (path: string) => void;
  onSelectClip: (clipId: number) => void;
}

const KIND_LABEL: Record<GlobalSearchHit["kind"], string> = {
  file: "文件名",
  transcript: "对白转写",
  description: "AI 描述",
  dimension: "八维标签",
};

/** P6-U1 全局命令面板(cmdk):Cmd+K——跳页、全量搜索(文件/转写/描述/标签)、素材直达。 */
export function CommandPalette({ onNavigate, onSelectClip }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [clips, setClips] = useState<ClipListItem[]>([]);
  const [query, setQuery] = useState("");
  const [deepHits, setDeepHits] = useState<GlobalSearchHit[]>([]);
  const debounceRef = useRef<number | undefined>(undefined);
  const queryRef = useRef("");
  queryRef.current = query;

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
        .then((hits) => {
          if (issuedFor === queryRef.current) setDeepHits(hits);
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

  if (!open) return null;

  return (
    <div className="command-palette-backdrop" onClick={() => setOpen(false)}>
      <Command
        label="全局命令"
        className="command-palette"
        shouldFilter={deepHits.length === 0}
        onClick={(event) => event.stopPropagation()}
      >
        <Command.Input
          autoFocus
          placeholder="跳转页面、全量搜索(文件/转写/AI描述/标签)…"
          value={query}
          onValueChange={setQuery}
        />
        <Command.List>
          <Command.Empty>没有匹配项</Command.Empty>
          {deepHits.length > 0 ? (
            <Command.Group heading="全量搜索">
              {deepHits.map((hit, index) => (
                <Command.Item
                  key={`${hit.kind}-${hit.clip_id}-${index}`}
                  value={`deep-${hit.kind}-${hit.clip_id}-${index}`}
                  onSelect={() => jumpToClip(hit.clip_id)}
                >
                  <span className="hit-kind">{KIND_LABEL[hit.kind]}</span>
                  <span className="hit-file">{hit.file_name.split("/").pop()}</span>
                  <span className="hit-excerpt">{hit.excerpt}</span>
                </Command.Item>
              ))}
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
