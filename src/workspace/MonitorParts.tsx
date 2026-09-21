import { photoSizeLabel } from "./photoModel";
import type { JSX, RefObject } from "react";

import type { ClipListItem, PlayerStatus, StoryGap } from "../api";
import { PaneHead } from "./PaneHead";
import { EmptyState } from "./ui";

/** 监视器的静态零件(从 Monitor.tsx 拆出只为守住 400 行上限;导出名与位置对旧调用点不变)。 */

/** 空槽位时监视器显示什么:章节标题 + 缺口 reason。 */
export function slotPlaceholderCopy(gap: StoryGap): { title: string; reason: string } {
  return { title: `${gap.chapter_title} · ${gap.slot_label_zh}`, reason: gap.reason };
}

/** 井右上角的规格 chip(A 稿「4K · 25p · 12.5 MB」):分辨率档 · 帧率 · 文件大小。 */
export function monitorSpecLabel(clip: ClipListItem): string {
  if (clip.kind === "photo") return `照片 · ${photoSizeLabel(clip)}`;
  const height = Math.min(clip.width ?? 0, clip.height ?? 0) || (clip.height ?? 0);
  const long = Math.max(clip.width ?? 0, clip.height ?? 0);
  const resolution =
    long >= 3840 ? "4K" : long >= 2560 ? "2.7K" : height > 0 ? `${height}p` : "—";
  const fps =
    clip.fps_num !== null && clip.fps_den !== null && clip.fps_den > 0
      ? `${Math.round(clip.fps_num / clip.fps_den)}p`
      : "—";
  const bytes = clip.byte_size ?? 0;
  const size =
    bytes >= 1024 ** 3
      ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
      : bytes >= 1024 ** 2
        ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
        : `${(bytes / 1024).toFixed(1)} KB`;
  return `${resolution} · ${fps} · ${size}`;
}

/** 井底的 I/O 轨:入出点区间用强调色、播放头一根白线;纯装饰,数据都在控件条里。 */
export function IoRail({
  status,
  inPoint,
  outPoint,
}: {
  status: PlayerStatus | null;
  inPoint: number | null;
  outPoint: number | null;
}): JSX.Element | null {
  if (!status || status.phase !== "ready" || status.duration <= 0 || !Number.isFinite(status.duration)) return null;
  const pct = (seconds: number) => `${Math.min(100, Math.max(0, (seconds / status.duration) * 100))}%`;
  return (
    <div className="monitor-io" aria-hidden="true">
      <div className="monitor-io-rail">
        {inPoint !== null ? (
          <span
            className="monitor-io-range"
            style={{ left: pct(inPoint), right: outPoint === null ? "auto" : `calc(100% - ${pct(outPoint)})`, width: outPoint === null ? "2px" : undefined }}
          />
        ) : null}
        {inPoint !== null ? <span className="monitor-io-mark monitor-io-mark--in" style={{ left: pct(inPoint) }} /> : null}
        {outPoint !== null ? <span className="monitor-io-mark monitor-io-mark--out" style={{ left: pct(outPoint) }} /> : null}
        <span className="monitor-io-head" style={{ left: pct(status.pos) }} />
      </div>
    </div>
  );
}

export function Placeholder({ title, reason }: { title: string; reason?: string }): JSX.Element {
  return (
    <div className="monitor-stage">
      <div className="monitor-well monitor-well--empty">
        <EmptyState icon="play" size="inline" tone="dark" title={title} body={reason} />
      </div>
    </div>
  );
}

/** 栏标题条 + 画面区的公共外壳:标题右侧的状态字说的是「现在看的是哪一条」。 */
export function MonitorFrame({
  meta,
  rootRef,
  children,
}: {
  meta: string;
  rootRef?: RefObject<HTMLDivElement | null>;
  children: JSX.Element | JSX.Element[];
}): JSX.Element {
  return (
    <div className="monitor" ref={rootRef}>
      <PaneHead title="预览监视器" meta={meta} />
      {children}
    </div>
  );
}
