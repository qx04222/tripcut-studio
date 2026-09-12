import { useCallback, useState, type JSX, type SyntheticEvent } from "react";

import { dismissStoryGap, type ClipDimension, type ClipDimensionKey } from "../api";
import { GenerationDialog } from "../GenerationDialog";
import { EmptyInspectorNote } from "./inspectorFields";
import type { InspectorSectionId } from "./Inspector";
import { Button, Card, Icon, SectionHeader, type IconName } from "./ui";
import { refreshClipsFeed, useClipsFeed } from "./useClipsFeed";
import { dispatchWorkspace, useWorkspace } from "./WorkspaceStore";

/**
 * 检查器里三块与"当前选中的是哪一条素材"无关的展示层,从 `Inspector.tsx` 搬出来
 * (规格 §13 的 400 行上限)。行为一行未改。
 */

const DIMENSION_LABELS: Record<ClipDimensionKey, string> = {
  movement: "①运动",
  shot_size: "②景别",
  subject: "③主体",
  viewpoint: "④视角",
  function: "⑤功能",
  person_state: "⑥人物状态",
  time_stage: "⑦时间阶段",
  sound: "⑧声音",
};
const DIMENSION_KEYS = Object.keys(DIMENSION_LABELS) as ClipDimensionKey[];
const TIME_STAGE_LABELS = ["出发", "路上", "到达", "探索", "吃饭", "活动", "日落夜景", "返回"];

export function DimensionsGrid({
  dimensions,
  onTimeStageChange,
}: {
  dimensions: readonly ClipDimension[];
  onTimeStageChange: (label: string) => void;
}): JSX.Element {
  if (dimensions.length === 0) return <p>等待代表帧与八维分类任务。</p>;
  return (
    <dl className="inspector-dimensions-grid">
      {DIMENSION_KEYS.map((dimension) => {
        const item = dimensions.find((candidate) => candidate.dimension === dimension);
        return (
          <div key={dimension} title={item?.source}>
            <dt>{DIMENSION_LABELS[dimension]}</dt>
            <dd>
              {dimension === "time_stage" && item ? (
                <select
                  aria-label="改写时间阶段"
                  value={item.label}
                  onChange={(event) => onTimeStageChange(event.currentTarget.value)}
                >
                  {TIME_STAGE_LABELS.map((label) => (
                    <option value={label} key={label}>
                      {label}
                    </option>
                  ))}
                </select>
              ) : (
                <strong>{item?.label ?? "—"}</strong>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * 折叠段:原生 `<details>/<summary>`(冒烟脚本按 `details summary` 找),受 store 的
 * `inspectorSections` 驱动、逐段记忆。summary 一行 36px:左图标 + 段名 + 右对齐状态字 +
 * chevron(展开时旋转 90°,规格 §3.8)。
 */
export function CollapsibleSection({
  id,
  icon,
  title,
  status,
  children,
}: {
  id: InspectorSectionId;
  icon: IconName;
  title: string;
  status: string;
  children: JSX.Element;
}): JSX.Element {
  const open = useWorkspace((state) => state.inspectorSections.includes(id));
  // jsdom(以及部分浏览器实现)在 React 挂载时把 `open` 属性从默认值改成 true 也会触发一次
  // "toggle" 事件,不只是用户点 summary 才触发。onToggle 不加这道「跟 store 比对」的守卫,
  // 挂载时就会把刚从记忆恢复的展开态原地扳回去(初版栽过这个坑)。
  const onToggle = useCallback(
    (event: SyntheticEvent<HTMLDetailsElement>) => {
      if (event.currentTarget.open !== open) {
        dispatchWorkspace({ type: "toggle-inspector-section", id });
      }
    },
    [id, open],
  );
  return (
    <details className="inspector-collapsible" open={open} onToggle={onToggle}>
      <summary>
        <Icon name={icon} className="inspector-section-icon" />
        <span className="inspector-section-title">{title}</span>
        <small className="inspector-section-status">{status}</small>
        <Icon name="chevron-right" size={12} className={open ? "inspector-chevron is-open" : "inspector-chevron"} />
      </summary>
      <div className="inspector-section-body">{children}</div>
    </details>
  );
}

/** 空槽位分支:缺口原因、目标槽位、生成候选、忽略此缺口。折叠层完全不出现。 */
export function GapInspector({ chapterId, slot }: { chapterId: number; slot: string }): JSX.Element {
  const feed = useClipsFeed();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const gap = feed.gaps.find((candidate) => candidate.chapter_id === chapterId && candidate.slot === slot) ?? null;

  const onDismiss = useCallback(() => {
    if (!gap || busy) return;
    setBusy(true);
    dismissStoryGap(gap.id)
      .then(() => {
        dispatchWorkspace({ type: "clear-selection" });
        return refreshClipsFeed(true);
      })
      .catch(() => undefined)
      .finally(() => setBusy(false));
  }, [gap, busy]);

  if (!gap) {
    return <EmptyInspectorNote />;
  }

  return (
    <div className="inspector-gap">
      <Card padding={3} className="inspector-default-section">
        <SectionHeader size="pane" title={<><Icon name="warning" />缺口原因</>} />
        <div className="inspector-card-body">
          <p className="inspector-gap-text">{gap.reason}</p>
        </div>
      </Card>
      <Card padding={3} className="inspector-default-section">
        <SectionHeader size="pane" title={<><Icon name="settings-timeline" />目标槽位</>} meta={gap.chapter_title} />
        <div className="inspector-card-body">
          <p className="inspector-gap-text">{`目标槽位：${gap.slot_label_zh}`}</p>
        </div>
      </Card>
      <div className="inspector-gap-actions">
        <Button variant="primary" icon="settings-generation" onClick={() => setDialogOpen(true)}>
          生成候选
        </Button>
        <Button disabled={busy} onClick={onDismiss}>
          忽略此缺口
        </Button>
      </div>
      {dialogOpen ? (
        <GenerationDialog
          gap={gap}
          readOnly={false}
          availability={null}
          onClose={() => setDialogOpen(false)}
          onSubmitted={() => setDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}

