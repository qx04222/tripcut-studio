import { useEffect, useRef, useState, type JSX } from "react";

import type { ClipDimensionKey } from "../api";
import { isTopModal, popModal, pushModal } from "./modalStack";
import {
  POOL_DIMENSION_KEYS,
  POOL_DIMENSION_LABELS,
  POOL_FILTER_LABELS,
  type SelectionFilter,
} from "./poolModel";
import { Button, Chip, Icon } from "./ui";
import { dispatchWorkspace, useWorkspace } from "./WorkspaceStore";

/**
 * 媒体池顶部的搜索 + 筛选条(规格 §1.1)。评级筛选折叠成**一行 chips**,
 * 其余(八维、画质、Stack 首选、竖屏)进「更多筛选」popover —— 320px 的左栏
 * 放不下旧 `selection-filterbar` 那一大片控件。
 *
 * 主屏不出现英文 kicker(规格 §6):旧壳的 `CHINESE-CLIP · LOCAL` 与 `LIBRARY`
 * 两块装饰文字在这里没有对应物,别顺手搬回来。
 */
export interface PoolExtraFilters {
  dimensionLabel: string;
  excludeSuspect: boolean;
  hideDuplicates: boolean;
  portraitOnly: boolean;
}

export const INITIAL_POOL_EXTRA_FILTERS: PoolExtraFilters = {
  dimensionLabel: "",
  excludeSuspect: false,
  hideDuplicates: false,
  portraitOnly: false,
};

/** 「更多筛选」里有几项与默认值不同 —— 折叠起来的筛选必须在按钮上留下痕迹。 */
export function activeExtraFilterCount(
  extras: PoolExtraFilters,
  dimension: ClipDimensionKey | "",
): number {
  let count = 0;
  if (dimension) count += 1;
  if (extras.excludeSuspect) count += 1;
  if (extras.hideDuplicates) count += 1;
  if (extras.portraitOnly) count += 1;
  return count;
}

export function PoolFilters({
  counts,
  dimensionLabelOptions,
  extras,
  onExtrasChange,
  onSearch,
  searching,
}: {
  counts: Record<SelectionFilter, number>;
  dimensionLabelOptions: readonly string[];
  extras: PoolExtraFilters;
  onExtrasChange: (next: PoolExtraFilters) => void;
  onSearch: (query: string) => void;
  searching: boolean;
}): JSX.Element {
  const filter = useWorkspace((state) => state.filter);
  const dimension = useWorkspace((state) => state.dimension);
  const query = useWorkspace((state) => state.query);
  const [draft, setDraft] = useState(query);
  const [composing, setComposing] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const modalToken = useRef({});

  // 更多筛选 popover 打开期间进模态栈,监视器据此藏起原生视频视图(R9 D1)。
  useEffect(() => {
    if (!moreOpen) return;
    const token = modalToken.current;
    pushModal(token);
    return () => popModal(token);
  }, [moreOpen]);

  // 搜索词由 store 持有(⌘K 也会写它),输入框只是它的一个编辑副本。
  useEffect(() => setDraft(query), [query]);

  useEffect(() => {
    if (!moreOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isTopModal(modalToken.current)) setMoreOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  const submit = () => {
    // 中文输入法组合中不提交 —— 组合期的 value 是半成品拼音,搜出来全是噪声。
    if (composing) return;
    dispatchWorkspace({ type: "set-query", query: draft });
    onSearch(draft.trim());
  };

  const extraCount = activeExtraFilterCount(extras, dimension);

  return (
    <div className="pool-filters">
      <div className="pool-search">
        <label className="pool-search-field">
          <span className="visually-hidden">搜索画面或对白关键词</span>
          <Icon name="search" size={12} className="pool-search-icon" />
          <input
            type="search"
            value={draft}
            placeholder="搜索画面或对白关键词"
            aria-label="搜索画面或对白关键词"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            onChange={(event) => setDraft(event.currentTarget.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
          />
        </label>
        <Button
          variant="secondary"
          size="sm"
          className="pool-search-submit"
          disabled={searching || composing}
          onClick={submit}
        >
          {searching ? "搜索中" : "搜索"}
        </Button>
      </div>

      <div className="pool-chips" role="group" aria-label="评级筛选">
        {(Object.keys(POOL_FILTER_LABELS) as SelectionFilter[]).map((candidate) => (
          <Chip
            key={candidate}
            className="pool-chip"
            selected={candidate === filter}
            count={counts[candidate]}
            onClick={() => dispatchWorkspace({ type: "set-filter", filter: candidate })}
          >
            {POOL_FILTER_LABELS[candidate]}
          </Chip>
        ))}
        <div className="pool-more" ref={moreRef}>
          <Button
            variant="ghost"
            size="sm"
            className={`pool-more-button${extraCount > 0 ? " active" : ""}`}
            aria-expanded={moreOpen}
            aria-haspopup="dialog"
            onClick={() => setMoreOpen((open) => !open)}
          >
            更多筛选
            {extraCount > 0 ? <span className="pool-more-count">{extraCount}</span> : null}
            <Icon name="chevron-down" size={12} />
          </Button>
          {moreOpen ? (
            <div className="pool-more-popover" role="dialog" aria-label="更多筛选">
              <label className="pool-more-row">
                <span>八维筛选</span>
                <select
                  value={dimension}
                  onChange={(event) => {
                    dispatchWorkspace({
                      type: "set-dimension",
                      dimension: event.currentTarget.value as ClipDimensionKey | "",
                    });
                    onExtrasChange({ ...extras, dimensionLabel: "" });
                  }}
                >
                  <option value="">选择维度</option>
                  {POOL_DIMENSION_KEYS.map((key) => (
                    <option value={key} key={key}>
                      {POOL_DIMENSION_LABELS[key]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="pool-more-row">
                <span>标签</span>
                <select
                  value={extras.dimensionLabel}
                  disabled={!dimension}
                  onChange={(event) =>
                    onExtrasChange({ ...extras, dimensionLabel: event.currentTarget.value })
                  }
                >
                  <option value="">全部标签</option>
                  {dimensionLabelOptions.map((label) => (
                    <option value={label} key={label}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="pool-more-check" title="信息镜头与人物镜头不受此画质过滤影响">
                <input
                  type="checkbox"
                  checked={extras.excludeSuspect}
                  onChange={(event) =>
                    onExtrasChange({ ...extras, excludeSuspect: event.currentTarget.checked })
                  }
                />
                排除普通疑似废片
              </label>
              <label className="pool-more-check">
                <input
                  type="checkbox"
                  checked={extras.hideDuplicates}
                  onChange={(event) =>
                    onExtrasChange({ ...extras, hideDuplicates: event.currentTarget.checked })
                  }
                />
                只看 Stack 首选
              </label>
              <label className="pool-more-check" title="只看竖屏素材(按 rotation 与画面比例判定)">
                <input
                  type="checkbox"
                  checked={extras.portraitOnly}
                  onChange={(event) =>
                    onExtrasChange({ ...extras, portraitOnly: event.currentTarget.checked })
                  }
                />
                竖屏
              </label>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
