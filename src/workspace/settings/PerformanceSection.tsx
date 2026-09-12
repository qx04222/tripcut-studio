import type { JSX } from "react";

import { SectionHeader, Select, Toggle } from "../ui";
import { SettingsRow } from "./SettingsControls";
import { useSettingsFormContext } from "./SettingsFormContext";

export function PerformanceSection(): JSX.Element {
  const form = useSettingsFormContext();
  const { settings } = form;
  return (
    <>
      <SectionHeader title="性能" description="控制后台吞吐与代理文件占用；原片始终保持只读。" />
      <div className="settings-sheet-group">
        <SettingsRow title="worker 并发" help="可选 1–8；保存后在下次重启时生效。" htmlFor="settings-worker-count">
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
        <SettingsRow title="自动生成 540p 代理" help="关闭后播放器优先读取原片，新导入不再排队生成代理。" align="end">
          <Toggle
            label="自动生成 540p 代理"
            checked={settings["performance.proxy_enabled"] === "true"}
            onChange={(next) => void form.save("performance.proxy_enabled", String(next))}
          />
        </SettingsRow>
        <SettingsRow title="内存档位" help="自动按本机内存选择；省内存档降低解码并发以避免大项目时被系统换出。" htmlFor="settings-memory-profile">
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
      </div>
    </>
  );
}
