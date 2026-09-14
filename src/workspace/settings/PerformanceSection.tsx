import type { JSX } from "react";

import { SectionHeader, Select, Toggle } from "../ui";
import { SettingsRow } from "./SettingsControls";
import { useSettingsFormContext } from "./SettingsFormContext";
import { bytesLabel } from "./settingsModel";

/** R16:预览小文件目录上限可选档(GB)。 */
export const PROXY_CACHE_LIMIT_OPTIONS_GB = [5, 10, 20, 50, 100] as const;

export function PerformanceSection(): JSX.Element {
  const form = useSettingsFormContext();
  const { settings, status } = form;
  const proxyLimitGb = settings["performance.proxy_cache_limit_gb"] ?? "10";
  const proxyBytes = status?.cache.proxy_bytes;
  const proxyLimitBytes = status?.cache.proxy_limit_bytes ?? Number(proxyLimitGb) * 1024 ** 3;
  return (
    <>
      <SectionHeader title="性能" description="控制后台处理速度与预览小文件的占用;原片始终保持只读。" />
      <div className="settings-sheet-group">
        <SettingsRow title="后台同时处理几条" help="可选 1–8,默认 4 就好:视频解码器大约 4 路并行到顶,再多不会更快;只导一条大文件时也会自动把空闲的几路用上。保存后在下次重启时生效。" htmlFor="settings-worker-count">
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
        {/* R16 车道 E:「省电 / 低配模式」三态。自动 = 8 GB 及以下的电脑自动开;开 = 任何电脑都用
            低配档(4K 一次只处理一条、不起画面识别、语音识别用小模型);关 = 8 GB 电脑也按省内存档跑。 */}
        <SettingsRow
          title="省电 / 低配模式"
          help="后台慢一点,换电脑不卡、风扇不响。「自动」在内存 8 GB 及以下的电脑上自动打开;打开后 4K 一次只处理一条、不做画面识别、语音识别用小模型。保存后在下次重启时完全生效。"
          htmlFor="settings-low-spec-mode"
        >
          <Select
            id="settings-low-spec-mode"
            value={settings["performance.low_spec_mode"] ?? "auto"}
            onChange={(event) => void form.save("performance.low_spec_mode", event.currentTarget.value)}
          >
            <option value="auto">自动</option>
            <option value="on">开</option>
            <option value="off">关</option>
          </Select>
        </SettingsRow>
        {/* R16 §3⑤:「只在我不用电脑时做后台工作」。后端 get_settings 给的是生效值(低配档默认开)。 */}
        <SettingsRow
          title="只在我不用电脑时做后台工作"
          help="打开后,键盘鼠标停下 60 秒才开始分析和生成预览;正在做的不会中断。电脑过热时后台会自动放慢,不用你管。"
          align="end"
        >
          <Toggle
            label="只在我不用电脑时做后台工作"
            checked={settings["performance.background_only_when_idle"] === "true"}
            onChange={(next) => void form.save("performance.background_only_when_idle", String(next))}
          />
        </SettingsRow>
        <SettingsRow title="预览用小文件" help="关闭后播放器直接读原片,新导入不再排队生成预览小文件。" align="end">
          <Toggle
            label="预览用小文件"
            checked={settings["performance.proxy_enabled"] === "true"}
            onChange={(next) => void form.save("performance.proxy_enabled", String(next))}
          />
        </SettingsRow>
        {/* R16 车道 E:预览小文件目录上限 + LRU。占用来自 status.cache.proxy_bytes(旧后端没有就不显示数字)。 */}
        <SettingsRow
          title="预览小文件最多占"
          help={
            proxyBytes === undefined
              ? "超过上限时,最久没播过的预览小文件会自动清掉,需要时再重新生成;原片不受影响。"
              : `现在占 ${bytesLabel(proxyBytes)} / 上限 ${bytesLabel(proxyLimitBytes)}。超过上限时,最久没播过的预览小文件会自动清掉,需要时再重新生成;原片不受影响。`
          }
          htmlFor="settings-proxy-cache-limit"
        >
          <Select
            id="settings-proxy-cache-limit"
            value={PROXY_CACHE_LIMIT_OPTIONS_GB.some((gb) => String(gb) === proxyLimitGb) ? proxyLimitGb : "10"}
            onChange={(event) => void form.save("performance.proxy_cache_limit_gb", event.currentTarget.value)}
          >
            {PROXY_CACHE_LIMIT_OPTIONS_GB.map((gb) => (
              <option value={gb} key={gb}>{gb} GB</option>
            ))}
          </Select>
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
      </div>
    </>
  );
}
