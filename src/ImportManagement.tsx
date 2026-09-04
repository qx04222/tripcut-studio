import { useEffect, useState } from "react";
import { cancelImportBatch, dismissImportNotices, listImportBatches, previewImportRemoval, removeImportedMaterial, type ImportBatch, type RemovalPreview, type RemovalRequest } from "./api";

export function ImportManagement({ selectedIds, onChanged }: { selectedIds: number[]; onChanged: () => void }) {
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ request: RemovalRequest; preview: RemovalPreview } | null>(null);
  useEffect(() => {
    let active = true; let timer: number | undefined; let inFlight = false;
    const visible = () => document.visibilityState !== "hidden";
    const poll = async () => {
      if (!active || inFlight || !visible()) return;
      inFlight = true;
      try { const value = await listImportBatches(); if (active) setBatches(value); }
      catch (error) { if (active) setNotice(String(error)); }
      finally { inFlight = false; if (active && visible()) timer = window.setTimeout(() => void poll(), 1500); }
    };
    const onVisibility = () => { window.clearTimeout(timer); if (visible()) void poll(); };
    document.addEventListener("visibilitychange", onVisibility);
    void poll();
    return () => { active = false; window.clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, []);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setNotice(null);
    try { await action(); } catch (error) { setNotice(String(error)); } finally { setBusy(false); }
  };
  const arm = (request: RemovalRequest) => void run(async () => {
    setConfirmation({ request, preview: await previewImportRemoval(request) });
  });
  return <div className="import-management" aria-label="导入管理">
    <div className="import-management-actions">
      <button disabled={busy || selectedIds.length === 0} onClick={() => arm({ batch_id: null, clip_ids: selectedIds, all: false })}>移除选中 {selectedIds.length ? `(${selectedIds.length})` : ""}</button>
      <button disabled={busy} onClick={() => arm({ batch_id: null, clip_ids: [], all: true })}>清空当前集素材…</button>
      <button disabled={busy} onClick={() => void run(async () => { await dismissImportNotices(); setNotice("已清理重复/失败提示，原素材保留，可重新选择文件夹重试。"); onChanged(); })}>清理重复/失败提示</button>
    </div>
    {batches.length ? <details open><summary>最近导入批次</summary><div className="import-batches">
      {batches.map((batch) => <div className="import-batch" key={batch.id}>
        <strong title={batch.source}>{batch.source.split("/").filter(Boolean).at(-1)}</strong>
        <span>{batch.status === "cancelled" ? "已停止" : batch.status === "scanning" ? "正在扫描" : batch.status === "failed" ? "扫描未完成，可重试" : batch.status === "completed" ? "索引完成" : "等待处理"} · 新增 {batch.imported} · 重复 {batch.duplicates} · 失败 {batch.failed}</span>
        <span>{batch.done} / {batch.total} 索引完成{batch.running ? ` · ${batch.running} 正在处理` : ""}</span>
        <div>
          <button disabled={busy || batch.status === "cancelled"} onClick={() => void run(async () => { await cancelImportBatch(batch.id); setBatches(await listImportBatches()); setNotice("已停止本批后续导入和分析；已入库素材保留。相关文件夹自动同步已暂停。"); onChanged(); })}>停止本批</button>
          <button disabled={busy} onClick={() => arm({ batch_id: batch.id, clip_ids: [], all: false })}>撤销本批…</button>
        </div>
      </div>)}
    </div></details> : null}
    {confirmation ? <div className="import-removal-confirm" role="alertdialog" aria-label="确认移除素材">
      <strong>{confirmation.request.all ? "清空当前集并重新选择素材" : confirmation.request.batch_id ? "撤销这次导入" : "从当前集移除选中素材"}</strong>
      <p>将移除 {confirmation.preview.clips} 条素材、{confirmation.preview.favorites} 条评分记录、{confirmation.preview.selections} 个精选段和 {confirmation.preview.cache_entries} 项缓存记录。相关筛选与故事引用也会清除。</p>
      <p>磁盘原视频不会删除。先停止相关任务并保存数据库快照；相关文件夹自动同步会暂停。进行中的批次会先停止，最终数量可能增加。</p>
      <button disabled={busy} onClick={() => void run(async () => { const count = await removeImportedMaterial(confirmation.request); setConfirmation(null); setNotice(`已移除 ${count} 条素材，原视频保留。现在可以重新选择文件夹。`); setBatches(await listImportBatches()); onChanged(); })}>{busy ? "正在停止任务并清理…" : "确认移除，保留原视频"}</button>
      <button disabled={busy} onClick={() => setConfirmation(null)}>取消</button>
    </div> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </div>;
}
