/**
 * R17 车道 B:应用内自动升级的纯函数层——「什么时候自动查」「进度怎么念」「失败怎么用白话说」
 * 「更新说明怎么从 markdown 变成几段话」。全是可断言的纯函数;store 与组件只负责接线。
 */
import type { SettingsMap } from "../../api";
import {
  UPDATER_ASK_BEFORE_DOWNLOAD_KEY,
  UPDATER_AUTO_UPDATE_KEY,
  UPDATER_LAST_CHECK_KEY,
  UPDATER_SKIPPED_VERSION_KEY,
} from "../../api";

/** 启动后延迟 30 秒再查,别跟首屏加载抢。 */
export const AUTO_CHECK_DELAY_MS = 30_000;
/** 24 小时内不重复查。 */
export const AUTO_CHECK_THROTTLE_MS = 24 * 60 * 60 * 1000;

export function autoUpdateEnabled(settings: SettingsMap): boolean {
  return settings[UPDATER_AUTO_UPDATE_KEY] !== "false";
}

export function askBeforeDownload(settings: SettingsMap): boolean {
  return settings[UPDATER_ASK_BEFORE_DOWNLOAD_KEY] === "true";
}

export type AutoCheckVerdict = "check" | "disabled" | "throttled" | "offline";

/** 启动后要不要自动查:开关关 → 不查;离线 → 静默;24 小时内查过 → 不查。 */
export function autoCheckVerdict(settings: SettingsMap, now: number, online: boolean): AutoCheckVerdict {
  if (!autoUpdateEnabled(settings)) return "disabled";
  if (!online) return "offline";
  const last = Date.parse(settings[UPDATER_LAST_CHECK_KEY] ?? "");
  if (Number.isFinite(last) && now - last < AUTO_CHECK_THROTTLE_MS) return "throttled";
  return "check";
}

export function isSkippedVersion(settings: SettingsMap, version: string): boolean {
  const skipped = (settings[UPDATER_SKIPPED_VERSION_KEY] ?? "").trim();
  return skipped !== "" && skipped === version.trim();
}

/** 状态条那句:「正在下载更新 42%」;服务器没给总长时退化成「正在下载更新 12 MB」。 */
export function downloadStatusLabel(downloaded: number, total: number | null): string {
  if (total !== null && total > 0) {
    const percent = Math.min(100, Math.max(0, Math.floor((downloaded / total) * 100)));
    return `正在下载更新 ${percent}%`;
  }
  return `正在下载更新 ${mbLabel(downloaded)}`;
}

export function mbLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export interface UpdateFailure {
  /** 给用户看的一句白话。 */
  reason: string;
  /** 原始错误文本,只在设置页的小字里露出,作证据。 */
  detail: string;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// 分类前先把 reqwest 尾巴 `for url (...)` 剥掉——GitHub 资产会 302 到带 X-Amz-Signature 的地址,
// 否则「断网」会被判成「签名不对」(R4 终审那一课,见 updaterClient.ts)。
function stripUrlSuffix(detail: string): string {
  return detail.replace(/ for url \([^)]*\)/gi, "").replace(/ \(url: [^)]*\)/gi, "");
}

const SIGNATURE_PATTERN = /signature (?:verification failed|[^.]*could not be decoded|was created with a different key)/i;
const NETWORK_PATTERN = /network|connection|connect|timed? ?out|dns|resolve|offline|error sending request|reset by peer|unreachable|503|502|404/i;
const DISK_PATTERN = /no space|disk full|permission denied|read-only file system|os error 28|os error 13/i;

/** 把后端错误翻成一句「现在怎么办」看得懂的话。 */
export function describeUpdateFailure(error: unknown): UpdateFailure {
  const detail = describeError(error).trim() || "未知错误";
  const target = stripUrlSuffix(detail);
  if (SIGNATURE_PATTERN.test(target)) return { reason: "更新包没通过安全校验,已拒绝安装", detail };
  if (DISK_PATTERN.test(target)) return { reason: "磁盘空间不够或没有写入权限", detail };
  if (NETWORK_PATTERN.test(target)) return { reason: "网络连不上更新服务器", detail };
  return { reason: "遇到了意外错误", detail };
}

/** 设置页「上次检查」:从未 / 刚刚 / n 分钟前 / n 小时前 / 昨天 / 日期。 */
export function lastCheckLabel(iso: string | null | undefined, now: number): string {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return "还没检查过";
  const diff = Math.max(0, now - at);
  const minute = 60_000;
  if (diff < minute) return "刚刚";
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
  if (diff < 48 * 60 * minute) return "昨天";
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 更新说明:markdown → 纯文本段落(标题去 #、列表去 -/*、粗斜体去星号、链接留文字、代码去反引号)。 */
export function notesToParagraphs(markdown: string | null | undefined): string[] {
  const lines = (markdown ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "• ")
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/(\*\*|__)(.+?)\1/g, "$2")
        .replace(/(\*|_)(.+?)\1/g, "$2")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/^\s*>\s?/, "")
        .trimEnd(),
    );
  const paragraphs: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) paragraphs.push(current.join("\n"));
    current = [];
  };
  for (const line of lines) {
    if (line.trim() === "" || /^\s*(?:---|\*\*\*|```)\s*$/.test(line)) {
      flush();
      continue;
    }
    current.push(line.trim());
  }
  flush();
  return paragraphs;
}
