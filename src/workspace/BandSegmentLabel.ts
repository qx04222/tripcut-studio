import { fileNameLines } from "./poolModel";
import type { BandSegment } from "./shotBandModel";

/**
 * R19 V-06 的镜块常显名 / tooltip 纯函数,从 `BandSegment.tsx` 拆出来只为守住 400 行上限
 * (同 `BandSegmentMenu.tsx` 的拆法)。常显只留封面 + 时长 + 一行名;第 n/m 条、AI 生成、
 * 槽位与角色挪进这颗缩略图的 `title`(悬停 tooltip)与检查器。`slotIndexLabel` 也放在
 * 这里(而不是 `BandSegment.tsx`)只是为了让这份 tooltip 逻辑不用倒过去 import 那个
 * 文件——避免循环依赖;`BandSegment.tsx` 从这里 re-export 回去,导入路径不变。
 */

/** 「槽位 01」—— A 稿瓦片左下那个按章重置的序号。 */
export function slotIndexLabel(slotIndex: number): string {
  return `槽位 ${String(slotIndex).padStart(2, "0")}`;
}

/** `20260812_` / `2026-08-12_` 这类拍摄日期前缀——常显名去掉它,原名仍在 title 里。 */
const BAND_DATE_PREFIX_RE = /^(\d{4}-?\d{2}-?\d{2})[_-]/;

/**
 * 镜块常显的一行文件名:去掉日期前缀,复用池卡 `fileNameLines` 的断点逻辑取前半段——
 * CSS 的 `text-overflow: ellipsis` 兜底截多出来的部分,不用在这里手工再截一次。
 */
export function bandTileNameLabel(fileName: string | null | undefined): string {
  const name = fileName ?? "";
  const stripped = name.replace(BAND_DATE_PREFIX_RE, "");
  const base = stripped.length > 0 ? stripped : name;
  return fileNameLines(base, 18)[0];
}

/** 把第 n/m 条、AI 生成、槽位与角色拼成一句,给缩略图的 `title` 用。 */
export function bandTileTooltip(segment: BandSegment): string {
  const parts: string[] = [];
  if (segment.takeCount > 1) parts.push(`第 ${segment.takeIndex}/${segment.takeCount} 条`);
  if (segment.isGenerated) parts.push("AI 生成");
  parts.push(
    segment.rangeLabel
      ? `${slotIndexLabel(segment.slotIndex)} · ${segment.rangeLabel}`
      : slotIndexLabel(segment.slotIndex),
  );
  if (segment.roleLabel) parts.push(segment.roleLabel);
  return parts.join(" · ");
}
