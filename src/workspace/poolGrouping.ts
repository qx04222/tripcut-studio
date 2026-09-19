/**
 * U-04/P-10「导入即有地图」:媒体池按「日期 › 时段」把素材先分组显示成占位卡的分组头——
 * 拍摄时间(`captured_at`,EXIF/文件 mtime 先到)先于分析结果出现,导入完成的一刻就能看出
 * 「这批素材大致是哪天、哪个时段拍的」,不必等分析跑完。纯函数,只读 `ClipListItem`,
 * 不碰 UI —— MediaPool.tsx 只负责把结果渲染成一条分组头 chip 行。
 */
import type { ClipListItem } from "../api";

export type TimePeriod = "凌晨" | "上午" | "下午" | "傍晚" | "夜间";

const UNKNOWN_DATE = "时间未知";

/** 0-4 凌晨,5-10 上午,11-16 下午,17-19 傍晚,20-23 夜间(与 24 小时制常识对齐,不需要业主拍板)。 */
export function timePeriodOf(hour: number): TimePeriod {
  if (hour < 5) return "凌晨";
  if (hour < 11) return "上午";
  if (hour < 17) return "下午";
  if (hour < 20) return "傍晚";
  return "夜间";
}

export interface PoolDateGroup {
  key: string;
  /** `YYYY-MM-DD`,拍摄时间缺失时为 null(归进「时间未知」一组)。 */
  date: string | null;
  period: TimePeriod | null;
  count: number;
}

/**
 * 按 `captured_at` 的日期 + 时段分组计数,组内顺序按素材原始顺序里第一次出现排列
 * (不重新按时间排序 —— 排序是媒体池网格自己的事,这里只负责「有几组、每组几条」)。
 * 没有 `captured_at` 的素材全部归进末尾的「时间未知」组,不与真实日期混在一起。
 */
export function groupClipsByDateAndPeriod(clips: readonly ClipListItem[]): PoolDateGroup[] {
  const order: string[] = [];
  const counts = new Map<string, PoolDateGroup>();
  for (const clip of clips) {
    let key: string;
    let date: string | null = null;
    let period: TimePeriod | null = null;
    if (clip.captured_at) {
      const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):/.exec(clip.captured_at);
      if (match) {
        date = match[1]!;
        period = timePeriodOf(Number(match[2]));
        key = `${date} ${period}`;
      } else {
        key = UNKNOWN_DATE;
      }
    } else {
      key = UNKNOWN_DATE;
    }
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { key, date, period, count: 1 });
      order.push(key);
    }
  }
  // 「时间未知」组固定排到最后,不管它在素材列表里第一次出现在哪 —— 真实日期组才是地图,
  // 未知组只是兜底,排前面会把地图截断。
  return order
    .filter((key) => key !== UNKNOWN_DATE)
    .map((key) => counts.get(key)!)
    .concat(counts.has(UNKNOWN_DATE) ? [counts.get(UNKNOWN_DATE)!] : []);
}
