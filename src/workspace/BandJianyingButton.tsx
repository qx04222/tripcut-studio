import { useEffect, useState, type JSX } from "react";

import { getJianyingAvailability, type JianyingAvailability } from "../api";
import { onJianyingAvailabilityChanged } from "./deliver/jianyingHumanCheck";
import { KIT_BAND_BUTTON_LABEL, KIT_LEAD_LINE } from "./deliver/kitExportModel";
import { openDeliverAs } from "./deliver/exportModeRequest";
import { Button } from "./ui";

/**
 * R13 §4 / §5:镜头带右上常驻的「导入剪映继续剪」。剪映可用(`get_jianying_availability`,仍由
 * `SUPPORTED_JIANYING_VERSIONS` 白名单决定)时是 primary,点它打开交付抽屉并落在「剪映草稿」模式。
 * R14 §9 B:不可用时这条路是死的,按钮改成「导出剪映素材包」(AX 名同步),点它落在「剪映素材包」
 * 模式 —— 剪映不管哪个版本都走得通,不再让新手撞上「(待验证)」。可用性还没回来时先按素材包画
 * (一帧内就换,两条路都能用)。secondary 皮不变:镜头带上的 primary 留给排入 / 自动挑选。
 */

export const JIANYING_BUTTON_LABEL = "导入剪映继续剪";
export { KIT_BAND_BUTTON_LABEL };

const CHECKING: JianyingAvailability = { installed_version: null, supported: false, reason: "" };

export function useJianyingAvailability(): JianyingAvailability {
  const [availability, setAvailability] = useState<JianyingAvailability>(CHECKING);
  useEffect(() => {
    let alive = true;
    getJianyingAvailability()
      .then((next) => {
        if (alive && next && typeof next === "object" && "supported" in next) setAvailability(next);
      })
      .catch(() => undefined);
    // R14 A:业主在结果卡点「可以用」后,可用性会广播出来,按钮要立刻从「导出剪映素材包」变回「导入剪映继续剪」。
    const stop = onJianyingAvailabilityChanged((next) => {
      if (alive) setAvailability(next);
    });
    return () => {
      alive = false;
      stop();
    };
  }, []);
  return availability;
}

/** 不可用时 tooltip:先说为什么不能直接出草稿,再说素材包这条路会发生什么。 */
function kitTitle(installedVersion: string | null): string {
  const why = installedVersion ? `检测到剪映 ${installedVersion},这个版本还没人工核对过,先走素材包` : "没检测到剪映,先把片段按顺序导出来";
  return `${why}:${KIT_LEAD_LINE}`;
}

export function BandJianyingButton({ disabled = false }: { disabled?: boolean }): JSX.Element {
  const jianying = useJianyingAvailability();
  const label = jianying.supported ? JIANYING_BUTTON_LABEL : KIT_BAND_BUTTON_LABEL;
  return (
    <Button
      // 镜头带上一次只许一个 primary(R11 简化专项 #4);草稿可用时它才是主动作,素材包是稳妥的次选。
      variant={jianying.supported ? "primary" : "secondary"}
      size="sm"
      icon="deliver"
      className="band-jianying"
      aria-label={label}
      title={jianying.supported ? "把镜头带生成剪映草稿,在剪映里接着剪" : kitTitle(jianying.installed_version)}
      disabled={disabled}
      onClick={() => openDeliverAs(jianying.supported ? "jianying" : "kit")}
    >
      {label}
    </Button>
  );
}
