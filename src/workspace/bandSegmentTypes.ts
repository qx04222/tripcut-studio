import type { StoryGap } from "../api";

export interface BandSegment {
  /** StoryItem.key,或 `slot:{chapterId}:{slot}`。 */
  key: string;
  kind: "clip" | "slot";
  mediaKind?: "video" | "photo";
  holdMs?: number;
  /** 全带内的 1 基序号,用于 aria-label「镜头 {n}」。 */
  index: number;
  clipId: number | null;
  segmentId: number | null;
  chapterId: number | null;
  slot: string | null;
  fileName: string | null;
  /** R13 §4:本段在素材里的入出点(素材自己的 tick);播放头与拖边裁剪按它换算。整条素材是 0–时长。 */
  inTicks: number;
  outTicks: number;
  /** 分段时长,单位是**本素材自己的 tick**(`tbNum/tbDen`);显示前必须换算(R-02)。 */
  durationTicks: number;
  tbNum: number;
  tbDen: number;
  takeCount: number;
  /** 本段在同镜头 Take 里的 1 基位次(「Take 1/3」的 1);不在 Stack 里就是 1。 */
  takeIndex: number;
  isGenerated: boolean;
  /** 封面缩略图(规格 §3.3 的分段缩略图);没封面/空槽位为 null。 */
  coverUrl: string | null;
  gap: StoryGap | null;
  groupedGaps?: readonly StoryGap[];
  /** 本章内的 1 基槽位序号(A 稿瓦片左下的「槽位 01」),按章重置;`index` 才是全带序号。 */
  slotIndex: number;
  /** 叙事模式下 beat 的角色词(瓦片右下);legacy 模式与空槽位为 null。 */
  roleLabel: string | null;
  /** R12 §2:精选段镜块的「片段 0.5–4.5 s」小标;整条素材与空槽位为 null。 */
  rangeLabel: string | null;
}
