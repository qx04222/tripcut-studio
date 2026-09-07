import { useEffect, useRef, useState } from "react";

import { searchEverything, type GlobalSearchHit } from "./api";
import { openHistoricalEpisode } from "./historyView";
import { KIND_LABEL } from "./kindLabels";
import { useSearchAugment } from "./useSearchAugment";

/** P6-U1 侧栏常驻全量搜索:文件名/转写/AI 描述/八维标签/画面文字,点击直达筛片选中。 */
export function SidebarSearch({ onSelectClip }: { onSelectClip: (clipId: number) => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<GlobalSearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  // O12:结果列表是 role="listbox",每条结果是 role="option"——焦点留在输入框上,
  // 用 aria-activedescendant 指到当前高亮项(标准的 combobox-listbox 模式)。
  const [activeIndex, setActiveIndex] = useState(-1);
  const debounceRef = useRef<number | undefined>(undefined);
  const queryRef = useRef("");
  queryRef.current = query;
  const visibleHits = hits.slice(0, 30);
  const { augmentHits, describeHitEpisode } = useSearchAugment();

  useEffect(() => {
    const onSearch = (event: Event) => {
      setQuery((event as CustomEvent<string>).detail ?? "");
    };
    window.addEventListener("tripcut:search", onSearch);
    return () => window.removeEventListener("tripcut:search", onSearch);
  }, []);

  useEffect(() => {
    window.clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setHits([]);
      setBusy(false);
      setActiveIndex(-1);
      return;
    }
    setBusy(true);
    debounceRef.current = window.setTimeout(() => {
      // 记住发起时的查询词:慢的旧请求返回时不能覆盖新查询的结果与忙碌态
      const issuedFor = query;
      void searchEverything(query)
        .then(async (results) => {
          if (issuedFor !== queryRef.current) return;
          const merged = await augmentHits(results, issuedFor);
          if (issuedFor === queryRef.current) {
            setHits(merged);
            setActiveIndex(merged.length > 0 ? 0 : -1);
          }
        })
        .catch(() => {
          if (issuedFor === queryRef.current) {
            setHits([]);
            setActiveIndex(-1);
          }
        })
        .finally(() => {
          if (issuedFor === queryRef.current) setBusy(false);
        });
    }, 250);
    return () => window.clearTimeout(debounceRef.current);
  }, [query]);

  const selectHit = (hit: GlobalSearchHit) => {
    const { isHistorical, episodeTitle } = describeHitEpisode(hit);
    if (isHistorical && hit.episode_id !== null) {
      openHistoricalEpisode(hit.episode_id, episodeTitle ?? "历史集");
      setQuery("");
      return;
    }
    onSelectClip(hit.clip_id);
    setQuery("");
  };

  const optionId = (index: number) => `sidebar-search-option-${index}`;

  return (
    <div className="sidebar-search" aria-label="全量搜索">
      <input
        type="search"
        placeholder="搜全部:文件/转写/AI/标签"
        value={query}
        role="combobox"
        aria-expanded={query.trim().length >= 2}
        aria-controls="sidebar-search-results"
        aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
        onChange={(event) => {
          const value = event.currentTarget.value;
          setQuery(value);
        }}
        onKeyDown={(event) => {
          if (visibleHits.length === 0) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((index) => (index + 1) % visibleHits.length);
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) => (index - 1 + visibleHits.length) % visibleHits.length);
            return;
          }
          if (event.key === "Home") {
            event.preventDefault();
            setActiveIndex(0);
            return;
          }
          if (event.key === "End") {
            event.preventDefault();
            setActiveIndex(visibleHits.length - 1);
            return;
          }
          if (event.key === "Enter" && activeIndex >= 0) {
            event.preventDefault();
            selectHit(visibleHits[activeIndex]);
          }
        }}
      />
      {query.trim().length >= 2 ? (
        <div className="sidebar-search-results" id="sidebar-search-results" role="listbox">
          {busy && hits.length === 0 ? <p className="sidebar-search-note">搜索中…</p> : null}
          {!busy && hits.length === 0 ? <p className="sidebar-search-note">没有匹配</p> : null}
          {visibleHits.map((hit, index) => {
            const { isHistorical } = describeHitEpisode(hit);
            return (
              <div
                role="option"
                id={optionId(index)}
                aria-selected={index === activeIndex}
                className={index === activeIndex ? "active" : undefined}
                key={`${hit.kind}-${hit.clip_id}-${index}`}
                tabIndex={-1}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectHit(hit)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selectHit(hit);
                  }
                }}
              >
                <span className="hit-kind">{KIND_LABEL[hit.kind] ?? hit.kind}</span>
                <strong>{hit.file_name.split("/").pop()}</strong>
                {hit.kind !== "file" ? <small>{hit.excerpt}</small> : null}
                {isHistorical ? <span className="hit-history-badge">历史集（只读）</span> : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
