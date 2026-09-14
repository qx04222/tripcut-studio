/**
 * R17 车道 B:应用内自动升级的状态层(与 toastStore 同一套 useSyncExternalStore 写法)。
 * 全应用只有一份:启动后的自动检查(`UpdateHost`)、状态条的进度(`UpdateStatusChip`)、
 * 设置 › 关于 的「检查更新」(`AboutUpdate`)都读写这一份,所以「同一套下载流程」是真的同一套。
 *
 * 状态机:idle → checking → (up-to-date | available) → downloading → ready → (重启)
 *                                    ↘ error(检查失败,只在手动检查时露出)  ↙ error(下载失败,可重试)
 */
import { useSyncExternalStore } from "react";

import {
  UPDATE_PROGRESS_EVENT,
  UPDATE_RELEASE_PAGE_URL,
  UPDATER_LAST_CHECK_KEY,
  UPDATER_SKIPPED_VERSION_KEY,
  checkForUpdate,
  downloadUpdate,
  getSettings,
  openExternalUrl,
  restartToUpdate,
  setSetting,
  type SettingsMap,
  type UpdateProgressEvent,
} from "../../api";
import {
  askBeforeDownload,
  autoCheckVerdict,
  describeUpdateFailure,
  isSkippedVersion,
  type AutoCheckVerdict,
  type UpdateFailure,
} from "./updateModel";

export type UpdatePhase = "idle" | "checking" | "up-to-date" | "available" | "downloading" | "ready" | "error";

export interface UpdateState {
  phase: UpdatePhase;
  /** 这次检查是启动后自动发起的,还是用户在设置页点的。 */
  source: "auto" | "manual" | null;
  /** 出错发生在哪一步(决定错误露在哪:检查失败只在设置页内联;下载失败出 toast)。 */
  failedAt: "check" | "download" | "restart" | null;
  version: string | null;
  notes: string | null;
  pubDate: string | null;
  downloaded: number;
  total: number | null;
  failure: UpdateFailure | null;
  /** 上次检查时间(ISO);启动时从设置读一次,之后每次检查完刷新。 */
  lastCheck: string | null;
  /** 自动流程发现新版本但用户设了「先问我再下载」时为 true——`UpdateHost` 据此出「有新版本」toast。 */
  awaitingConsent: boolean;
}

export const IDLE_UPDATE_STATE: UpdateState = {
  phase: "idle",
  source: null,
  failedAt: null,
  version: null,
  notes: null,
  pubDate: null,
  downloaded: 0,
  total: null,
  failure: null,
  lastCheck: null,
  awaitingConsent: false,
};

let state: UpdateState = IDLE_UPDATE_STATE;
const listeners = new Set<() => void>();

function set(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function getUpdateSnapshot(): UpdateState {
  return state;
}

export function subscribeUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(subscribeUpdate, getUpdateSnapshot, getUpdateSnapshot);
}

async function readSettings(): Promise<SettingsMap> {
  try {
    return await getSettings();
  } catch {
    return {};
  }
}

async function writeSetting(key: string, value: string): Promise<void> {
  try {
    await setSetting(key, value);
  } catch {
    // 记不下「上次检查时间」不该让更新流程本身失败;下次启动最多再查一次。
  }
}

/** 启动时把「上次检查」读进来给设置页显示(不查网)。 */
export async function loadLastCheck(): Promise<void> {
  const settings = await readSettings();
  set({ lastCheck: settings[UPDATER_LAST_CHECK_KEY] ?? null });
}

/**
 * 查一次更新服务器。手动检查的失败露在设置页;自动检查的失败静默回到 idle。
 * 返回查到的状态,方便调用方接着决定下不下载。
 */
export async function runUpdateCheck(source: "auto" | "manual"): Promise<UpdateState> {
  if (state.phase === "checking" || state.phase === "downloading") return state;
  // 已经下好了就别再查——重启前的状态要保住。
  if (state.phase === "ready") return state;
  set({ phase: "checking", source, failedAt: null, failure: null, awaitingConsent: false });
  try {
    const result = await checkForUpdate();
    const lastCheck = new Date().toISOString();
    await writeSetting(UPDATER_LAST_CHECK_KEY, lastCheck);
    if (result?.offline) {
      // 后端说端点没连上:不是错误也不是「已是最新」,静默回到 idle(手动点「检查更新」时由设置页提示离线)。
      set({ phase: "idle", version: null, notes: null, pubDate: null, lastCheck, failedAt: "check", failure: { reason: "现在连不上更新服务器,稍后会再试。", detail: "offline" } });
    } else if (!result || !result.available) {
      set({ phase: "up-to-date", version: result?.current_version ?? result?.version ?? null, notes: null, pubDate: null, lastCheck });
    } else {
      set({ phase: "available", version: result.version, notes: result.notes || null, pubDate: result.pub_date || null, lastCheck });
    }
  } catch (error) {
    if (source === "manual") {
      set({ phase: "error", failedAt: "check", failure: describeUpdateFailure(error) });
    } else {
      set({ phase: "idle" });
    }
  }
  return state;
}

/** 下载并安装当前查到的版本;进度来自 `tripcut:update-progress` window 事件;可以边用边下。 */
export async function runUpdateDownload(): Promise<UpdateState> {
  if (state.phase !== "available" && !(state.phase === "error" && state.failedAt === "download")) return state;
  set({ phase: "downloading", failedAt: null, failure: null, downloaded: 0, total: null, awaitingConsent: false });
  const onProgress = (event: Event) => {
    const detail = (event as CustomEvent<UpdateProgressEvent>).detail;
    if (!detail) return;
    set({ downloaded: Number(detail.downloaded) || 0, total: typeof detail.total === "number" ? detail.total : null });
  };
  window.addEventListener(UPDATE_PROGRESS_EVENT, onProgress);
  try {
    await downloadUpdate();
    set({ phase: "ready", downloaded: state.total ?? state.downloaded, total: state.total });
  } catch (error) {
    set({ phase: "error", failedAt: "download", failure: describeUpdateFailure(error) });
  } finally {
    window.removeEventListener(UPDATE_PROGRESS_EVENT, onProgress);
  }
  return state;
}

/** 重启到新版本。失败时留在 ready 并给出原因(用户还能再点一次)。 */
export async function runUpdateRestart(): Promise<void> {
  try {
    await restartToUpdate();
  } catch (error) {
    set({ phase: "ready", failedAt: "restart", failure: describeUpdateFailure(error) });
  }
}

/** 「跳过这个版本」:记下版本号,自动流程以后不再提它;手动检查仍会看到。 */
export async function skipCurrentVersion(): Promise<void> {
  const version = state.version;
  if (!version) return;
  await writeSetting(UPDATER_SKIPPED_VERSION_KEY, version);
  set({ phase: "idle", awaitingConsent: false, version: null, notes: null, pubDate: null, downloaded: 0, total: null });
}

/**
 * 「稍后」:这次不装。清掉「上次检查」时间戳,让下次启动越过 24 小时节流再提一次
 * (后端若支持退出时安装,合并时车道 A 接管;否则下次启动重新走一遍下载)。
 */
export async function postponeUpdate(): Promise<void> {
  await writeSetting(UPDATER_LAST_CHECK_KEY, "");
  set({ awaitingConsent: false, lastCheck: null });
}

/** 兜底:打开 GitHub 下载页。后端没提供 `open_url` 时退回浏览器新窗口。 */
export async function openDownloadPage(): Promise<void> {
  try {
    await openExternalUrl(UPDATE_RELEASE_PAGE_URL);
  } catch {
    window.open(UPDATE_RELEASE_PAGE_URL, "_blank", "noopener");
  }
}

export type AutoUpdateOutcome = AutoCheckVerdict | "skipped" | "up-to-date" | "asked" | "downloaded" | "failed";

/**
 * 启动后的自动流程(`UpdateHost` 在 30 秒后调一次):按开关 / 节流 / 离线决定查不查;
 * 查到新版本 → 跳过过的版本不提;「先问我再下载」开着就只标 awaitingConsent,否则静默下载。
 */
export async function runAutoUpdate(now = Date.now(), online = typeof navigator === "undefined" ? true : navigator.onLine): Promise<AutoUpdateOutcome> {
  const settings = await readSettings();
  set({ lastCheck: settings[UPDATER_LAST_CHECK_KEY] ?? null });
  const verdict = autoCheckVerdict(settings, now, online);
  if (verdict !== "check") return verdict;
  const checked = await runUpdateCheck("auto");
  if (checked.phase !== "available" || !checked.version) return checked.phase === "up-to-date" ? "up-to-date" : "failed";
  if (isSkippedVersion(settings, checked.version)) {
    set({ phase: "idle", version: null, notes: null, pubDate: null });
    return "skipped";
  }
  if (askBeforeDownload(settings)) {
    set({ awaitingConsent: true });
    return "asked";
  }
  const downloaded = await runUpdateDownload();
  return downloaded.phase === "ready" ? "downloaded" : "failed";
}

/** 测试用:清空状态。 */
export function __resetUpdateStoreForTests(): void {
  state = IDLE_UPDATE_STATE;
  for (const listener of listeners) listener();
}
