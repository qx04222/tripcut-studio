import { useEffect, useRef, type JSX } from "react";

import type { RemovalPreview, RemovalRequest } from "../../api";
import { REMOVAL_CONFIRM_BUTTON, REMOVAL_CONFIRM_LABEL } from "../copy";
import { Button, Card } from "../ui";

/** 后果预览的标题:清空当前集 / 撤销整批 / 移除选中(媒体池、检查器、缺失页也走这一张卡)。 */
export function removalTitle(request: RemovalRequest): string {
  if (request.all) return "清空当前集并重新选择素材";
  if (request.batch_id) return "撤销这次导入";
  return "从当前集移除选中素材";
}

/**
 * R16 P1-1:导入页的 `alertdialog` 确认卡抽成组件 —— 媒体池右键「移除素材…」、检查器头部、
 * 缺失页「这个盘不会再回来了…」都复用它。文案逐字沿用导入页那张:后果数字 + 「原视频不会删」。
 * 弹出时把焦点交给卡本身(alertdialog),列表再长也滚到它。
 */
export function RemovalConfirm({
  request,
  preview,
  busy,
  title,
  onConfirm,
  onCancel,
}: {
  request: RemovalRequest;
  preview: RemovalPreview;
  busy: boolean;
  /** 不传就按 request 形状取默认标题。 */
  title?: string;
  onConfirm(): void;
  onCancel(): void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = ref.current;
    node?.scrollIntoView?.({ block: "nearest" });
    node?.focus();
  }, []);
  return (
    <Card ref={ref} tabIndex={-1} level="raised" padding={4} className="import-confirm" role="alertdialog" aria-label={REMOVAL_CONFIRM_LABEL}>
      <strong className="import-confirm-title">{title ?? removalTitle(request)}</strong>
      <p>将移除 {preview.clips} 条素材、{preview.favorites} 条评分记录、{preview.selections} 个精选段和 {preview.cache_entries} 项缓存记录。相关筛选与故事引用也会清除。</p>
      <p>磁盘原视频不会删除。先停止相关任务并保存数据库快照；相关文件夹自动同步会暂停。进行中的批次会先停止，最终数量可能增加。</p>
      <div className="import-confirm-actions">
        <Button disabled={busy} onClick={onCancel}>取消</Button>
        <Button variant="primary" tone="danger" busy={busy} onClick={onConfirm}>
          {busy ? "正在停止任务并清理…" : REMOVAL_CONFIRM_BUTTON}
        </Button>
      </div>
    </Card>
  );
}
