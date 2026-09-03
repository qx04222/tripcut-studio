import { useEffect, useRef, useState } from "react";

import { searchEverything, type GlobalSearchHit } from "./api";

const KIND_LABEL: Record<GlobalSearchHit["kind"], string> = {
  file: "文件",
  transcript: "转写",
  description: "AI",
  dimension: "标签",
};

/** P6-U1 侧栏常驻全量搜索:文件名/转写/AI 描述/八维标签,点击直达筛片选中。 */
export function SidebarSearch({ onSelectClip }: { onSelectClip: (clipId: number) => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<GlobalSearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const debounceRef = useRef<number | undefined>(undefined);
  const queryRef = useRef("");
  queryRef.current = query;

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
      return;
    }
    setBusy(true);
    debounceRef.current = window.setTimeout(() => {
      // 记住发起时的查询词:慢的旧请求返回时不能覆盖新查询的结果与忙碌态
      const issuedFor = query;
      void searchEverything(query)
        .then((results) => {
          if (issuedFor === queryRef.current) setHits(results);
        })
        .catch(() => {
          if (issuedFor === queryRef.current) setHits([]);
        })
        .finally(() => {
          if (issuedFor === queryRef.current) setBusy(false);
        });
    }, 250);
    return () => window.clearTimeout(debounceRef.current);
  }, [query]);

  return (
    <div className="sidebar-search" aria-label="全量搜索">
      <input
        type="search"
        placeholder="搜全部:文件/转写/AI/标签"
        value={query}
        onChange={(event) => {
          const value = event.currentTarget.value;
          setQuery(value);
        }}
      />
      {query.trim().length >= 2 ? (
        <div className="sidebar-search-results" role="listbox">
          {busy && hits.length === 0 ? <p className="sidebar-search-note">搜索中…</p> : null}
          {!busy && hits.length === 0 ? <p className="sidebar-search-note">没有匹配</p> : null}
          {hits.slice(0, 30).map((hit, index) => (
            <button
              type="button"
              key={`${hit.kind}-${hit.clip_id}-${index}`}
              onClick={() => {
                onSelectClip(hit.clip_id);
                setQuery("");
              }}
            >
              <span className="hit-kind">{KIND_LABEL[hit.kind]}</span>
              <strong>{hit.file_name.split("/").pop()}</strong>
              {hit.kind !== "file" ? <small>{hit.excerpt}</small> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
