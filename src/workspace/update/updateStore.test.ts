// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("../testApiMock");
  return createTestApiMock({});
});
vi.mock("../../api", () => apiMocks);

import { UPDATE_PROGRESS_EVENT } from "../../api";
import {
  __resetUpdateStoreForTests,
  getUpdateSnapshot,
  postponeUpdate,
  runAutoUpdate,
  runUpdateCheck,
  runUpdateDownload,
  skipCurrentVersion,
} from "./updateStore";

const NEW_VERSION = { available: true, version: "0.8.0", notes: "- 修了导出", pub_date: "2026-09-14T08:00:00Z", current_version: "0.8.0", offline: false, skipped: false };
const NOW = Date.parse("2026-09-14T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  __resetUpdateStoreForTests();
  apiMocks.getSettings.mockResolvedValue({});
  apiMocks.checkForUpdate.mockResolvedValue({ available: false, version: "0.7.0", notes: "", pub_date: "", current_version: "0.8.0", offline: false, skipped: false });
  apiMocks.setSetting.mockResolvedValue(undefined);
  apiMocks.downloadUpdate.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

/** R17 车道 B:自动升级状态机。 */
describe("runAutoUpdate", () => {
  it("默认设置:查 → 有新版本 → 静默下载 → ready;写了 updater.last_check", async () => {
    apiMocks.checkForUpdate.mockResolvedValue(NEW_VERSION);
    expect(await runAutoUpdate(NOW, true)).toBe("downloaded");
    const snapshot = getUpdateSnapshot();
    expect(snapshot.phase).toBe("ready");
    expect(snapshot.version).toBe("0.8.0");
    expect(snapshot.awaitingConsent).toBe(false);
    expect(apiMocks.setSetting).toHaveBeenCalledWith("updater.last_check", expect.stringMatching(/^\d{4}-\d\d-\d\dT/));
    expect(apiMocks.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it("自动更新关掉 / 24 小时内查过 / 离线:不打网络", async () => {
    apiMocks.getSettings.mockResolvedValue({ "updater.auto_update": "false" });
    expect(await runAutoUpdate(NOW, true)).toBe("disabled");
    apiMocks.getSettings.mockResolvedValue({ "updater.last_check": new Date(NOW - 3_600_000).toISOString() });
    expect(await runAutoUpdate(NOW, true)).toBe("throttled");
    apiMocks.getSettings.mockResolvedValue({});
    expect(await runAutoUpdate(NOW, false)).toBe("offline");
    expect(apiMocks.checkForUpdate).not.toHaveBeenCalled();
    expect(getUpdateSnapshot().phase).toBe("idle");
  });

  it("「先问我再下载」开着:只标 awaitingConsent,不下载;跳过过的版本不提", async () => {
    apiMocks.checkForUpdate.mockResolvedValue(NEW_VERSION);
    apiMocks.getSettings.mockResolvedValue({ "updater.ask_before_download": "true" });
    expect(await runAutoUpdate(NOW, true)).toBe("asked");
    expect(getUpdateSnapshot()).toMatchObject({ phase: "available", awaitingConsent: true, version: "0.8.0" });
    expect(apiMocks.downloadUpdate).not.toHaveBeenCalled();

    __resetUpdateStoreForTests();
    apiMocks.getSettings.mockResolvedValue({ "updater.skipped_version": "0.8.0" });
    expect(await runAutoUpdate(NOW, true)).toBe("skipped");
    expect(getUpdateSnapshot().phase).toBe("idle");
    expect(apiMocks.downloadUpdate).not.toHaveBeenCalled();
  });

  it("自动检查失败静默回 idle;手动检查失败露出白话原因", async () => {
    apiMocks.checkForUpdate.mockRejectedValue(new Error("error sending request: dns error"));
    expect(await runAutoUpdate(NOW, true)).toBe("failed");
    expect(getUpdateSnapshot().phase).toBe("idle");
    await runUpdateCheck("manual");
    expect(getUpdateSnapshot()).toMatchObject({ phase: "error", failedAt: "check", failure: { reason: "网络连不上更新服务器" } });
  });
});

describe("runUpdateDownload", () => {
  it("进度跟着 tripcut:update-progress 走;下载失败留在 error(download) 可重试", async () => {
    apiMocks.checkForUpdate.mockResolvedValue(NEW_VERSION);
    await runUpdateCheck("manual");
    let rejectDownload: (error: Error) => void = () => undefined;
    apiMocks.downloadUpdate.mockImplementation(
      () =>
        new Promise<void>((_, reject) => {
          rejectDownload = reject;
        }),
    );
    const downloading = runUpdateDownload();
    expect(getUpdateSnapshot().phase).toBe("downloading");
    window.dispatchEvent(new CustomEvent(UPDATE_PROGRESS_EVENT, { detail: { downloaded: 42, total: 100 } }));
    expect(getUpdateSnapshot()).toMatchObject({ downloaded: 42, total: 100 });
    rejectDownload(new Error("The signature verification failed"));
    await downloading;
    expect(getUpdateSnapshot()).toMatchObject({ phase: "error", failedAt: "download", failure: { reason: "更新包没通过安全校验,已拒绝安装" } });
    // 下载结束后不再听进度事件。
    window.dispatchEvent(new CustomEvent(UPDATE_PROGRESS_EVENT, { detail: { downloaded: 99, total: 100 } }));
    expect(getUpdateSnapshot().downloaded).toBe(42);
    // 可重试:第二次成功 → ready。
    apiMocks.downloadUpdate.mockResolvedValue(undefined);
    await runUpdateDownload();
    expect(getUpdateSnapshot().phase).toBe("ready");
  });

  it("不在 available 时不下载", async () => {
    await runUpdateDownload();
    expect(apiMocks.downloadUpdate).not.toHaveBeenCalled();
  });
});

describe("skip / postpone", () => {
  it("跳过写 updater.skipped_version 并回 idle;稍后清掉 last_check 让下次启动再提", async () => {
    apiMocks.checkForUpdate.mockResolvedValue(NEW_VERSION);
    await runUpdateCheck("manual");
    await skipCurrentVersion();
    expect(apiMocks.setSetting).toHaveBeenCalledWith("updater.skipped_version", "0.8.0");
    expect(getUpdateSnapshot().phase).toBe("idle");

    await runUpdateCheck("manual");
    await postponeUpdate();
    expect(apiMocks.setSetting).toHaveBeenCalledWith("updater.last_check", "");
    expect(getUpdateSnapshot().lastCheck).toBeNull();
  });
});
