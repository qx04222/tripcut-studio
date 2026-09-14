import type { JSX } from "react";
import { Button, Card, Icon } from "../ui";
import { dispatchWorkspace } from "../WorkspaceStore";

/** Z-07:与后端 `media_source::MISSING_SOURCE_REASON` 同一句话。 */
export const MISSING_SOURCE_REASON = "原片不在原来的位置(可能拔了卡或移了文件夹)";
/** Z-07:按钮文字 = AX 名(新控件)。 */
export const RELOCATE_MISSING_ACTION = "去缺失素材页重新定位";

/** 「原片不在原来的位置(可能拔了卡或移了文件夹):A.mov、B.mov 等 5 条」。 */
export function missingSourcesLine(missing: readonly string[]): string {
  const listed = missing.length > 3 ? `${missing.slice(0, 3).join("、")} 等 ${missing.length} 条` : missing.join("、");
  return `${MISSING_SOURCE_REASON}:${listed}`;
}

/**
 * Z-07 / Z-08(R14 stress):导出清单里有原片不在原位的素材时,清单上方给一句原因 + 一个按钮;
 * 主按钮同时禁用(`canExport`),不让任务跑到一半才「交付失败」。按钮打开导入抽屉的「缺失素材」页。
 */
export function MissingSourcesNotice({ missing }: { missing: readonly string[] | undefined }): JSX.Element | null {
  if (!missing || missing.length === 0) return null;
  return (
    <Card className="deliver-missing-notice" padding={3} role="alert" aria-label="原片缺失">
      <span className="deliver-missing-icon" aria-hidden="true">
        <Icon name="warning" size={16} />
      </span>
      <p className="deliver-missing-text">{missingSourcesLine(missing)}</p>
      <Button
        variant="secondary"
        size="sm"
        aria-label={RELOCATE_MISSING_ACTION}
        onClick={() => dispatchWorkspace({ type: "open-drawer", drawer: "import", tab: "missing" })}
      >
        {RELOCATE_MISSING_ACTION}
      </Button>
    </Card>
  );
}
