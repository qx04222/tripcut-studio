import type { JianyingAvailability } from "../../api";
import type { ExportMode } from "./quickExportModel";

/**
 * R19 车道 deliver(U-06/P-04,规格 §3 deliver 行,业主拍板 §7 Q-6):导出抽屉首屏从「四枚模式 chip
 * 一起摆出来」减成三张大卡——「交给剪映」「导出视频文件」「整包交付」。「交给剪映」内部按剪映版本
 * 可用性自动选草稿(`jianying`)或素材包(`kit`),不给用户选;未核对版本的机器上点一次就直接落在
 * 素材包那条永远走得通的路。既有四模式 chip 选择器一个不删——移进「更多方式 ⌄」展开后原样可见。
 */

/** 首屏三张卡的 id;与底层 `ExportMode` 分开,因为「交给剪映」这一张卡背后是两种可能的模式。 */
export type DeliverCard = "handoff" | "quick" | "full";

export const DELIVER_CARDS: readonly DeliverCard[] = ["handoff", "quick", "full"];

export const DELIVER_CARD_LABELS: Record<DeliverCard, string> = {
  handoff: "交给剪映",
  quick: "导出视频文件",
  full: "整包交付",
};

export const DELIVER_CARD_HINTS: Record<DeliverCard, string> = {
  handoff: "在剪映里接着剪,能不能用草稿由软件自己判断",
  quick: "只导片段和收藏的视频文件",
  full: "视频 + 参考粗剪 + 镜头表 + 说明",
};

/** 「更多方式」展开按钮——里面是既有四枚 chip(冻结 AX 名不变)。 */
export const MORE_WAYS_LABEL = "更多方式";

/** J-10:剪映不可用时补的一行灰字,说明「交给剪映」这张卡实际会落在哪条路、差在哪里。 */
export const HANDOFF_DOWNGRADE_LINE =
  "草稿(标记/字幕/配乐更完整)暂不可用于你的剪映版本,已改用素材包(顺序仍对)";

/** 点「交给剪映」落到素材包时的一次性 toast——顺序看文件名编号,不用再猜。 */
export const HANDOFF_KIT_TOAST = "顺序 = 编号:文件名前面的数字就是拖进剪映时间线的顺序";

/**
 * 「交给剪映」这张卡背后实际用哪个模式:版本可用 → 草稿;不可用或还没查到 → 素材包
 * (素材包永远走得通,查询中先按保守路径走,可用性回来晚了也不会让用户等在半路)。
 */
export function resolveHandoffMode(availability: JianyingAvailability | null): ExportMode {
  return availability?.supported ? "jianying" : "kit";
}

/** 卡片点击 → 落到哪个既有 `ExportMode`。 */
export function cardToExportMode(card: DeliverCard, availability: JianyingAvailability | null): ExportMode {
  if (card === "handoff") return resolveHandoffMode(availability);
  return card;
}
