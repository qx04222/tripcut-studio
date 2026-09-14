// @vitest-environment jsdom
// R16 车道 A:设置页各行 —— P2-5 整集重算、P2-8 导出文件夹「清除」、P2-11 重置新手引导、P2-12 恢复默认布局、P2-13 复制诊断信息。
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMocks);

import type { AppInfo, DoctorReport, SettingsStatus } from "../api";
import { SETTINGS_ACTIONS } from "./copy";
import { buildDiagnostics, stripPaths } from "./diagnostics";
import { ONBOARDING_RESET_KEYS } from "./onboardingReset";
import { __resetToastsForTests, getToastSnapshot } from "./ui/toastStore";
import { WorkspaceShell } from "./WorkspaceShell";
import { __resetWorkspaceForTests } from "./WorkspaceStore";

async function openTab(name: string): Promise<HTMLElement> {
  render(<WorkspaceShell />);
  await act(async () => {
    const button = screen.getByRole("button", { name: "设置" });
    button.focus();
    button.click();
    await Promise.resolve();
  });
  const dialog = await screen.findByRole("dialog", { name: "设置" });
  await waitFor(() => expect(within(dialog).getByRole("status").textContent).toContain("设置已从本地项目载入"));
  await act(async () => {
    within(dialog).getByRole("tab", { name }).click();
    await Promise.resolve();
  });
  return within(dialog).getByRole("tabpanel");
}

const settle = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  __resetWorkspaceForTests();
  __resetToastsForTests();
  vi.clearAllMocks();
  apiMocks.setSetting.mockReset().mockResolvedValue(undefined);
  apiMocks.setFirstRunDone.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("P2-11 / P2-13 关于", () => {
  it("「重置新手引导」连 guide.*.viewed、onboarding.steps_seen、pipeline.hint_seen.1–4、首启向导一起清", async () => {
    const panel = await openTab("关于");
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: SETTINGS_ACTIONS.resetOnboarding }));
    });
    await waitFor(() => expect(apiMocks.setFirstRunDone).toHaveBeenCalledWith(false));
    const written = apiMocks.setSetting.mock.calls.filter(([, value]) => value === "false").map(([key]) => key);
    for (const key of ONBOARDING_RESET_KEYS) expect(written).toContain(key);
    expect(written.some((key) => key.startsWith("guide.") && key.endsWith(".viewed"))).toBe(true);
    expect(ONBOARDING_RESET_KEYS).toEqual(["onboarding.steps_seen", "pipeline.hint_seen.1", "pipeline.hint_seen.2", "pipeline.hint_seen.3", "pipeline.hint_seen.4"]);
    await settle();
    expect(getToastSnapshot()?.text).toContain("四步提示");
  });

  it("「复制诊断信息」拼三条命令写进剪贴板;内容不含路径", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    apiMocks.getDoctorReport.mockResolvedValue({
      status: "WARN",
      checks: [
        { id: "a", title: "缓存目录", status: "WARN", detail: "找不到 /Users/xin/Library/Caches/tripcut/covers/1.jpg" },
        { id: "b", title: "正常项", status: "OK", detail: "/Volumes/CARD 在线" },
      ],
      abnormal_exit: true,
      recovered_jobs: 2,
      cache_sampled: 20,
      cache_missing: 1,
      snapshots: ["/Users/xin/Library/Application Support/TripCutStudio/snap-1.db"],
      restart_required: false,
    } as DoctorReport);
    const panel = await openTab("关于");
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: SETTINGS_ACTIONS.copyDiagnostics }));
    });
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const text = writeText.mock.calls[0]![0] as string;
    expect(text).toContain("应用版本:0.0.0");
    expect(text).toContain("视频处理:可用 6.0");
    expect(text).toContain("健康检查:WARN · 上次非正常退出 · 恢复了 2 个任务 · 缓存缺失 1/20");
    expect(text).toContain("[WARN] 缓存目录:找不到 <路径>");
    expect(text).not.toContain("/Users");
    expect(text).not.toContain("snap-1.db");
    expect(text).not.toContain("正常项");
    await settle();
    expect(getToastSnapshot()?.text).toContain("已复制");
  });

  it("buildDiagnostics:最近错误最多 3 条、没有就写「无」;stripPaths 覆盖 ~ / Windows 盘符", () => {
    const appInfo: AppInfo = { version: "1.2.3", db_schema_version: 41, worker_count: 4, read_only: true };
    const status = {
      ffmpeg: { configured_path: "/opt/x", resolved_path: "/opt/x", available: false, version: null, note: null },
      ffprobe: { configured_path: "", resolved_path: "", available: true, version: "7.0", note: null },
      whisper: { binary: { configured_path: "", resolved_path: "", available: true, version: null, note: null }, model_tier: "small", model_path: "/Users/a/m.bin", model_available: true, models_directory: "/Users/a" },
      clip_sidecar: { venv_path: "/Users/a/venv", service_path: "", setup_script: "", available: false, service_available: false, note: "" },
      cache: { database_bytes: 1, disk_bytes: 2 },
    } as SettingsStatus;
    const checks = [1, 2, 3, 4].map((n) => ({ id: `c${n}`, title: `错 ${n}`, status: "FAIL" as const, detail: `在 ~/x${n} 与 C:\\Users\\x${n} 出错` }));
    const doctor: DoctorReport = { status: "FAIL", checks, abnormal_exit: false, recovered_jobs: 0, cache_sampled: 0, cache_missing: 0, snapshots: [], restart_required: false };
    const text = buildDiagnostics({ appInfo, status, doctor, settings: { "performance.memory_profile": "low" }, machine: { cores: 8, platform: "MacIntel" } });
    expect(text).toContain("应用版本:1.2.3 · 数据版本 V41 · 后台线程 4 · 只读窗口");
    expect(text).toContain("机器:MacIntel · 8 核 · 内存档:low");
    expect(text).toContain("视频处理:缺失");
    expect(text).toContain("转写模型:已安装(small)");
    expect(text.match(/^- \[FAIL\]/gm)?.length).toBe(3);
    expect(text).not.toMatch(/~\/|C:\\/);
    expect(buildDiagnostics({ appInfo, status, doctor: { ...doctor, checks: [] }, settings: {} })).toContain("最近错误:无");
    expect(stripPaths("看 /Users/xin/Movies/a.mp4 和 ~/Desktop/b 与 C:\\Users\\x\\c.txt")).toBe("看 <路径> 和 <路径> 与 <路径>");
  });
});
