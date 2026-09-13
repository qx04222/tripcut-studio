import type { JSX } from "react";
import type { ExportStatus } from "../../api";
import { Card, Icon, SectionHeader, type IconName } from "../ui";
import { ROUGH_CUT_TARGET_LABELS, formatDuration, roughCutTargetKey, summaryLine, wholeFavoritesNote, type CanvasSize, type TargetSecondsOption } from "./deliverModel";

export interface DeliverContentsProps {
  status: ExportStatus;
  includeContactSheet: boolean;
  useJianyingDraft: boolean;
  targetSeconds: TargetSecondsOption;
  /** R-03:本次交付解析出的画布;参考粗剪按它缩放,文案跟着写 W×H,读不到才回落「1080p」。 */
  canvas?: CanvasSize | null;
}

function roughCutSpec(canvas: CanvasSize | null | undefined): string {
  return canvas ? `${canvas.width}×${canvas.height} 通用 MP4` : "1080p 通用 MP4";
}

interface ContentRow {
  icon: IconName;
  name: string;
  count: string;
  skipped?: boolean;
}

/** 「内容」节:一行汇总 + 将要产出的每一类及其数量(规格 §4.2 第 2 条)。 */
export function DeliverContents({ status, includeContactSheet, useJianyingDraft, targetSeconds, canvas }: DeliverContentsProps): JSX.Element {
  const rows: ContentRow[] = [
    { icon: "mark-in", name: "精选片段", count: `${status.selected_segment_count} 段 · 帧精确重编码` },
    { icon: "heart", name: "整条收藏", count: `${status.selected_whole_count} 条 · ${wholeFavoritesNote(status) ?? "整条原画质导出"}` },
    {
      icon: "play",
      name: "参考粗剪",
      count: `1 条 · ${ROUGH_CUT_TARGET_LABELS[roughCutTargetKey(targetSeconds)]} · ${roughCutSpec(canvas)}`,
    },
    { icon: "grip", name: "镜头表 CSV", count: "1 份 · UTF-8 BOM" },
    includeContactSheet
      ? { icon: "info", name: "联系表.pdf", count: "1 份 · A4 网格" }
      : { icon: "info", name: "联系表.pdf", count: "未勾选 · 本次不放入", skipped: true },
    { icon: "save", name: "交付说明", count: "1 份 · 一屏中文" },
  ];
  if (useJianyingDraft) rows.push({ icon: "deliver", name: "剪映草稿", count: "1 份 · 写入剪映草稿目录" });

  return (
    <section className="deliver-section" aria-label="内容">
      <SectionHeader title="内容" meta={`预计 ${formatDuration(status.total_duration_seconds)}`} />
      <Card className="deliver-manifest" padding={4}>
        <p className="deliver-summary-line">{summaryLine(status)}</p>
        <ul className="deliver-content-list">
          {rows.map((row) => (
            <li key={row.name} className={row.skipped ? "deliver-content-row deliver-content-row--skipped" : "deliver-content-row"}>
              <span className="deliver-content-icon">
                <Icon name={row.icon} size={16} />
              </span>
              <span className="deliver-content-name">{row.name}</span>
              <span className="deliver-content-count">{row.count}</span>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

function parts(canvas: CanvasSize | null | undefined): ReadonlyArray<{ title: string; body: string }> {
  return [
    { title: "精选片段", body: "打点的片段按帧精确重新编码;没有打点的收藏素材整条原画质导出。" },
    { title: "参考粗剪", body: `按拍摄时间顺序,统一生成一条 ${roughCutSpec(canvas)} 文件,手机和电脑都能直接播。` },
    { title: "镜头表 CSV", body: "可用 Excel 直接打开,含章节、故事顺序、画面参数、星级、基础分析角标和失败备注。" },
    { title: "交付说明", body: "一屏中文说明,告诉你如何把稳定包带入剪映。" },
  ];
}

/** 「交付包里有什么」四条说明,折叠段,默认收起,没有 01/02/03 水印(规格 §4.2 第 6 条)。 */
export function DeliverPartsDetails({ canvas }: { canvas?: CanvasSize | null }): JSX.Element {
  const rows = parts(canvas);
  return (
    <details className="deliver-parts">
      <summary className="deliver-parts-summary">交付包里有什么</summary>
      <dl className="deliver-parts-list">
        {rows.map((part) => (
          <div key={part.title} className="deliver-part">
            <dt>{part.title}</dt>
            <dd>{part.body}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
