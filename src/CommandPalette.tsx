import { useCallback, useEffect, useRef, useState } from "react";
import { Command } from "cmdk";

import { listClips, searchEverything, type ClipListItem, type GlobalSearchHit } from "./api";
import { openHistoricalEpisode } from "./historyView";
import { useFocusTrap } from "./useFocusTrap";
import { KIND_LABEL } from "./kindLabels";
import { useSearchAugment } from "./useSearchAugment";
import { isTopModal, popModal, pushModal } from "./workspace/modalStack";

interface CommandPaletteProps {
  onNavigate: (path: string) => void;
  onSelectClip: (clipId: number) => void;
  /**
   * 命令集按壳分叉(R8 终审 L7)。`"workspace"`(默认)发新 IA 的
   * `open-*`/`band-*`;`"legacy"` 发旧壳的四条 hash 路由,并且**不渲染**附属带
   * 那一组——旧壳没有附属带,把命令摆出来再默默吞掉比不摆更糟。
   */
  variant?: "workspace" | "legacy";
}

/** P6-U1 全局命令面板(cmdk):Cmd+K——跳页、全量搜索(文件/转写/描述/标签/画面文字)、素材直达。 */
export function CommandPalette({ onNavigate, onSelectClip, variant = "workspace" }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [clips, setClips] = useState<ClipListItem[]>([]);
  const [query, setQuery] = useState("");
  const [deepHits, setDeepHits] = useState<GlobalSearchHit[]>([]);
  // 高亮项受控(R10 U-31):列表换代(全量命中到达 / 清空)时 cmdk 可能落成「没有任何一项
  // 被选中」,这时 Enter 什么都不做,要鼠标点。下面的 effect 保证总有首项被高亮。
  const [value, setValue] = useState("");
  const debounceRef = useRef<number | undefined>(undefined);
  const queryRef = useRef("");
  queryRef.current = query;
  // cmdk 的裸 <Command> (非 Command.Dialog)不带 focus trap——Command.Item
  // 不进 Tab 序列(靠内部方向键选中),只有 Command.Input 天然可聚焦,Tab 会
  // 直接漏到面板背后的页面。所以这里自己收一道。
  const paletteRef = useRef<HTMLDivElement>(null);
  useFocusTrap(paletteRef, open);
  const { augmentHits, describeHitEpisode } = useSearchAugment();

  // 命令面板可以压在抽屉之上打开。两层都在 document 上听 Esc,所以谁响应要由
  // 模态栈决定,不能各关各的(R8 终审 L9)。
  const modalToken = useRef({});
  useEffect(() => {
    if (!open) return;
    const token = modalToken.current;
    pushModal(token);
    return () => popModal(token);
  }, [open]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((value) => !value);
      }
      if (event.key === "Escape" && isTopModal(modalToken.current)) setOpen(false);
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

  // 每次列表内容变化后,若没有任何一项处于选中态,就把第一项设为选中(Enter 默认执行首项)。
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const root = paletteRef.current;
      if (!root) return;
      if (root.querySelector('[cmdk-item][aria-selected="true"]')) return;
      const first = root.querySelector<HTMLElement>('[cmdk-item]:not([aria-disabled="true"])');
      const next = first?.getAttribute("data-value");
      if (next) setValue(next);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, query, deepHits, clips]);

  // Enter 的兜底:cmdk 自己找不到选中项时,执行 DOM 里的第一项。
  const onEnterFallback = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    const root = paletteRef.current;
    if (!root || root.querySelector('[cmdk-item][aria-selected="true"]')) return;
    const first = root.querySelector<HTMLElement>('[cmdk-item]:not([aria-disabled="true"])');
    if (!first) return;
    event.preventDefault();
    first.click();
  }, []);

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
        value={value}
        onValueChange={setValue}
        onKeyDownCapture={onEnterFallback}
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
          {variant === "legacy" ? (
            <Command.Group heading="页面">
              <Command.Item onSelect={() => go("/import")}>01 · 导入素材</Command.Item>
              <Command.Item onSelect={() => go("/review")}>02 · 筛片工作台</Command.Item>
              <Command.Item onSelect={() => go("/deliver")}>03 · 交付</Command.Item>
              <Command.Item onSelect={() => go("/settings")}>04 · 设置</Command.Item>
            </Command.Group>
          ) : (
            <>
              <Command.Group heading="工作区">
                <Command.Item onSelect={() => go("open-import")}>打开导入素材</Command.Item>
                <Command.Item onSelect={() => go("open-deliver")}>打开生成交付包</Command.Item>
                <Command.Item onSelect={() => go("open-settings")}>打开设置</Command.Item>
                <Command.Item onSelect={() => go("open-help")}>打开帮助</Command.Item>
              </Command.Group>
              <Command.Group heading="附属带">
                <Command.Item onSelect={() => go("band-story")}>切到故事附属带</Command.Item>
                <Command.Item onSelect={() => go("band-music")}>切到音乐附属带</Command.Item>
                <Command.Item onSelect={() => go("band-journey")}>切到旅程附属带</Command.Item>
                {/* 与附属 tab 的标签「地点卡」同名(R10 U-31)。 */}
                <Command.Item onSelect={() => go("band-destination")}>切到地点卡附属带</Command.Item>
                <Command.Item onSelect={() => go("band-template")}>切到模板附属带</Command.Item>
              </Command.Group>
            </>
          )}
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
