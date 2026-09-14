import type { JSX } from "react";

import { Button, SectionHeader, Select, Toggle } from "../ui";
import { SettingsRow } from "./SettingsControls";
import { useSettingsFormContext } from "./SettingsFormContext";

export function PerformanceSection(): JSX.Element {
  const form = useSettingsFormContext();
  const { settings, workspaceV2 } = form;
  return (
    <>
      <SectionHeader title="性能" description="控制后台处理速度与预览小文件的占用;原片始终保持只读。" />
      <div className="settings-sheet-group">
        <SettingsRow title="后台同时处理几条" help="可选 1–8;保存后在下次重启时生效。" htmlFor="settings-worker-count">
          <Select
            id="settings-worker-count"
            value={settings["performance.worker_count"]}
            onChange={(event) => void form.save("performance.worker_count", event.currentTarget.value)}
          >
            {Array.from({ length: 8 }, (_, index) => index + 1).map((count) => (
              <option value={count} key={count}>{count}</option>
            ))}
          </Select>
        </SettingsRow>
        <SettingsRow title="预览用小文件" help="关闭后播放器直接读原片,新导入不再排队生成预览小文件。" align="end">
          <Toggle
            label="预览用小文件"
            checked={settings["performance.proxy_enabled"] === "true"}
            onChange={(next) => void form.save("performance.proxy_enabled", String(next))}
          />
        </SettingsRow>
        <SettingsRow title="内存档位" help="自动按本机内存选择；省内存档会放慢后台处理，避免大项目时卡顿。" htmlFor="settings-memory-profile">
          <Select
            id="settings-memory-profile"
            value={settings["performance.memory_profile"]}
            onChange={(event) => void form.save("performance.memory_profile", event.currentTarget.value)}
          >
            <option value="auto">自动</option>
            <option value="standard">标准</option>
            <option value="low">省内存</option>
          </Select>
        </SettingsRow>
        {/* R11 简化专项 #2:「切回旧界面」从外观搬到高级(性能)—— 新手不该在常用里看见它。
            这一行是个真开关,不是单向门(R8 终审 M2):文案与写入值都由当前 ui.workspace_v2 决定。 */}
        <SettingsRow
          title="界面"
          help={
            workspaceV2
              ? "旅剪工作台是当前默认界面;需要时可以随时切回旧版四步页面。"
              : "当前是旧版四步页面;随时可以切回旅剪工作台。"
          }
          align="end"
        >
          <Button onClick={() => void form.toggleWorkspaceFlag()}>
            {workspaceV2 ? "切回旧界面" : "切换到新界面"}
          </Button>
        </SettingsRow>
      </div>
    </>
  );
}
