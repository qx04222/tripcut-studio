import type { JSX } from "react";

import { SectionHeader, Select, Toggle } from "../ui";
import { SettingsRow } from "./SettingsControls";
import { useSettingsFormContext } from "./SettingsFormContext";
import type { SettingsStatus, PreviewQuality } from "../../api";
import { playerSetPreviewQuality } from "../../api";
import { requestStatusRefreshSoon } from "../previewSourceRefresh";
import { bytesLabel } from "./settingsModel";

/** R16:预览小文件目录上限可选档(GB)。 */
export const PROXY_CACHE_LIMIT_OPTIONS_GB = [5, 10, 20, 50, 100] as const;

const PROFILE_LABEL: Record<string, string> = { low_spec: "省电 / 低配档", low: "省内存档", standard: "标准档", high_perf: "高性能档" };
const CHIP_LABEL: Record<string, string> = { base: "Apple 基础款芯片", pro: "Apple Pro 芯片", max: "Apple Max 芯片", ultra: "Apple Ultra 芯片" };

/** 「后台干活的力度」的说明:带上当前档位与芯片,让人知道为什么只有两挡 / 三挡。 */
export function effortHelp(performance: SettingsStatus["performance"] | undefined): string {
  const base = "省电:后台只用一半力气,风扇更安静;平衡:按这台电脑的档位来;全速:插着电、想尽快处理完时用。改完立刻生效。";
  if (!performance) return base;
  const profile = PROFILE_LABEL[performance.profile] ?? performance.profile;
  const chip = CHIP_LABEL[performance.chip] ?? "";
  const engines = performance.media_engines > 0 ? ` · ${performance.media_engines} 个媒体引擎` : "";
  return `当前:${profile}${chip ? ` · ${chip}` : ""}${engines}。${base}`;
}

/** 旧库只存过 `worker_count` 时,按后端同一条映射(≤2 省电 / 3–5 平衡 / ≥6 全速)显示;没资格全速的档位回落到平衡。 */
export function currentEffort(saved: string | undefined, performance: SettingsStatus["performance"] | undefined): string {
  const value = saved || performance?.background_effort || "balanced";
  if (value === "full" && performance?.allows_full_effort === false) return "balanced";
  return ["eco", "balanced", "full"].includes(value) ? value : "balanced";
}

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
        {/* R18 W-2:「后台同时处理几条」1–8 旋钮实测在 4 以上是安慰剂(4 与 8 只差 17 ms),
            换成三挡力度 —— 写 `performance.background_effort`;低配 / 省内存档只给两挡(全速画出来就是骗人)。
            旧键 `performance.worker_count` 不删,回退旧版本还要靠它。 */}
        <SettingsRow title="后台干活的力度" help={effortHelp(status?.performance)} htmlFor="settings-background-effort">
          <Select
            id="settings-background-effort"
            aria-label="后台干活的力度"
            value={currentEffort(settings["performance.background_effort"], status?.performance)}
            onChange={(event) => void form.save("performance.background_effort", event.currentTarget.value)}
          >
            <option value="eco">省电</option>
            <option value="balanced">平衡(推荐)</option>
            {status?.performance?.allows_full_effort !== false ? <option value="full">全速(插电时)</option> : null}
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
        <SettingsRow title="预览画质" htmlFor="settings-preview-quality"
          help={`自动：播放、暂停都看原片，原片掉帧或省内存机器才改播代理（有 1080p 用 1080p）；高画质：1080p 代理；原片：直接读原文件；性能优先：540p 代理。原片始终只读，导出永远读原片。${settings["performance.proxy_enabled"] === "false" ? "预览用小文件已关闭，所有档位均读取原片。" : ""}`}>
          <Select id="settings-preview-quality" aria-label="预览画质"
            value={settings["performance.preview_quality"] ?? "auto"}
            disabled={settings["performance.proxy_enabled"] === "false"}
            onChange={(event) => {
              const value = event.currentTarget.value as PreviewQuality;
              void form.save("performance.preview_quality", value).then((saved) => {
                if (saved) return playerSetPreviewQuality(value).then(() => { requestStatusRefreshSoon(); });
              }).catch(() => undefined);
            }}>
            <option value="auto">自动(推荐):看原片,掉帧才改播代理</option>
            <option value="high">高画质:1080p 代理</option>
            <option value="original">原片:直接读原文件</option>
            <option value="performance">性能优先:540p 代理</option>
          </Select>
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
        {/* R18 W-7:启动快照有了总量上限(后端 1 GiB),这一行让它可见;旧后端没有这两个字段就不显示。 */}
        {status?.cache.snapshot_bytes !== undefined ? (
          <SettingsRow
            title="启动快照占用"
            help={`现在占 ${bytesLabel(status.cache.snapshot_bytes ?? 0)} / 上限 ${bytesLabel(status.cache.snapshot_limit_bytes ?? 0)}。每次启动留一份数据库快照,超过上限时从最旧的清起,至少留一份。`}
          >
            <span className="settings-sheet-static">{bytesLabel(status.cache.snapshot_bytes ?? 0)}</span>
          </SettingsRow>
        ) : null}
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
