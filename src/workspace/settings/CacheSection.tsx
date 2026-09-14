import type { JSX } from "react";

import { Button, Card, Icon, SectionHeader } from "../ui";
import { useSettingsFormContext } from "./SettingsFormContext";
import { bytesLabel } from "./settingsModel";

export function CacheSection(): JSX.Element {
  const form = useSettingsFormContext();
  const { status, cacheConfirm, busy } = form;
  return (
    <>
      <SectionHeader title="缓存与重建" description="只管理可重建产物，不触碰原片、片段选择与评级。" />
      <div className="settings-sheet-meter" aria-label="缓存占用">
        <div><span>数据库记录</span><strong>{bytesLabel(status?.cache.database_bytes ?? 0)}</strong></div>
        <div><span>目录实测</span><strong>{bytesLabel(status?.cache.disk_bytes ?? 0)}</strong></div>
      </div>
      {/* Z-18:说清缓存里最大的一块是什么、大概多大,磁盘紧张时知道能不能清。 */}
      <p className="settings-sheet-note">
        预览用小文件(每条素材一份)占用通常不超过原片大小;清掉后需要时会自动重建,不影响原片。
      </p>
      <Card className="settings-sheet-danger" padding={4}>
        <div className="settings-sheet-danger-copy">
          <Icon name="settings-cache" size={20} />
          <div>
            <strong>清空缓存并重建</strong>
            <small>会移除可重建缓存并重置对应任务；评级、片段和原始素材不会被删除。</small>
          </div>
        </div>
        <Button
          tone="danger"
          variant={cacheConfirm ? "primary" : "secondary"}
          disabled={busy}
          onClick={() => void form.clearCache()}
        >
          {cacheConfirm ? "再次点击确认清空" : "清空缓存并重建"}
        </Button>
      </Card>
    </>
  );
}
