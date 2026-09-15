import type { JSX } from "react";

import { Icon, type IconName } from "./ui";

/**
 * R18 车道 layout · V-22:栏折叠后的 40px 竖条。
 *
 * 旧版把栏名写成**竖排中文**(`writing-mode: vertical-rl`)——macOS 上几乎没人这么排,
 * 1280 下(13" MacBook,主力机型)那一条基本读不出来(08-narrow-1280.png)。
 * 这里改成横排:一个「›」箭头 + 横排栏名(「检查器」三个字在 40px 里排得下),
 * 整条都可点,`title` 给一句完整的 tooltip。
 *
 * AX 名不动:仍然是「展开<栏名>」—— 冒烟脚本与既有断言按这个找它。
 */
export function InspectorCollapsed({
  label,
  icon = "chevron-right",
  onExpand,
}: {
  label: string;
  icon?: IconName;
  onExpand: () => void;
}): JSX.Element {
  return (
    <div className="workspace-rail workspace-rail--r18">
      <button
        type="button"
        className="workspace-rail-button"
        aria-label={`展开${label}`}
        title={`展开${label}(点一下把它拉回来)`}
        onClick={onExpand}
      >
        <span className="workspace-rail-icon" aria-hidden="true">
          <Icon name={icon} size={16} />
        </span>
        <span className="workspace-rail-label">{label}</span>
      </button>
    </div>
  );
}
