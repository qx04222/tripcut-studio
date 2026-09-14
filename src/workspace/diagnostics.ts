import { getAppInfo, getDoctorReport, getSettings, getSettingsStatus, type AppInfo, type DoctorReport, type SettingsMap, type SettingsStatus } from "../api";

/**
 * R16 P2-13「复制诊断信息」:前端拼 `get_app_info` + `get_settings_status` + `get_doctor_report`,
 * **不带路径**(隐私):只有版本 / 工具链是否可用与版本 / 内存档 / 最近 3 条错误摘要。
 * 任何看起来像路径的片段(`/Users/...`、`~/...`、`C:\\...`)在进文本前一律换成「<路径>」。
 */

const PATH_PATTERN = /(?:~|\/(?:Users|Volumes|private|var|tmp|opt|Applications|Library|home|etc)|[A-Za-z]:\\)[^\s"'()、,;:，；]*/g;

export function stripPaths(text: string): string {
  return text.replace(PATH_PATTERN, "<路径>");
}

export interface DiagnosticsInput {
  appInfo: AppInfo;
  status: SettingsStatus;
  doctor: DoctorReport;
  settings: SettingsMap;
  /** 浏览器能读到的机器概况(`navigator.hardwareConcurrency` 等);没有就省略。 */
  machine?: { cores?: number; platform?: string };
}

const tool = (label: string, item: { available: boolean; version: string | null }): string =>
  `${label}:${item.available ? `可用${item.version ? ` ${item.version}` : ""}` : "缺失"}`;

/** 纯函数:拼诊断文本(测试盯它)。 */
export function buildDiagnostics(input: DiagnosticsInput): string {
  const { appInfo, status, doctor, settings, machine } = input;
  const lines: string[] = [
    "旅剪 诊断信息",
    `应用版本:${appInfo.version} · 数据版本 V${appInfo.db_schema_version} · 后台线程 ${appInfo.worker_count} · ${appInfo.read_only ? "只读窗口" : "可编辑"}`,
  ];
  const machineParts: string[] = [];
  if (machine?.platform) machineParts.push(machine.platform);
  if (machine?.cores) machineParts.push(`${machine.cores} 核`);
  machineParts.push(`内存档:${settings["performance.memory_profile"] || "自动"}`);
  lines.push(`机器:${machineParts.join(" · ")}`);
  lines.push(
    `工具链:${[
      tool("视频处理", status.ffmpeg),
      tool("媒体信息", status.ffprobe),
      tool("转写", status.whisper.binary),
      `转写模型:${status.whisper.model_available ? `已安装(${status.whisper.model_tier})` : "缺失"}`,
      `画面识别:${status.clip_sidecar.available ? "已安装" : "未安装"}`,
    ].join(";")}`,
  );
  lines.push(`健康检查:${doctor.status}${doctor.abnormal_exit ? " · 上次非正常退出" : ""}${doctor.recovered_jobs > 0 ? ` · 恢复了 ${doctor.recovered_jobs} 个任务` : ""}${doctor.cache_missing > 0 ? ` · 缓存缺失 ${doctor.cache_missing}/${doctor.cache_sampled}` : ""}`);
  const problems = doctor.checks.filter((check) => check.status !== "OK").slice(0, 3);
  lines.push(problems.length === 0 ? "最近错误:无" : "最近错误:");
  for (const check of problems) lines.push(`- [${check.status}] ${check.title}:${check.detail}`);
  return stripPaths(lines.join("\n"));
}

/** 取三条命令 + 设置,拼好写进剪贴板;返回写进去的文本(toast / 测试用)。 */
export async function copyDiagnostics(): Promise<string> {
  const [appInfo, status, doctor, settings] = await Promise.all([getAppInfo(), getSettingsStatus(), getDoctorReport(), getSettings()]);
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const text = buildDiagnostics({
    appInfo,
    status,
    doctor,
    settings: settings ?? {},
    machine: nav ? { cores: nav.hardwareConcurrency || undefined, platform: nav.platform || undefined } : undefined,
  });
  await writeClipboard(text);
  return text;
}

/**
 * 先走 `navigator.clipboard`(WKWebView 在用户手势里允许);被拒(无头浏览器 / 权限)再退到
 * 隐藏 textarea + `execCommand("copy")`。两条都不行才抛一句人话。
 */
export async function writeClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 走下面的兜底
    }
  }
  if (typeof document !== "undefined") {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let copied: boolean;
    try {
      copied = document.execCommand("copy");
    } finally {
      area.remove();
    }
    if (copied) return;
  }
  throw new Error("这个窗口不允许写入剪贴板,先打开日志目录把文件发给我们");
}
