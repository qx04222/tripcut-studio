// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("../testApiMock");
  return createTestApiMock({});
});
vi.mock("../../api", () => apiMock);

import { useSettingsForm } from "./useSettingsForm";

beforeEach(() => {
  vi.clearAllMocks();
  // 持久的 mockResolvedValue / mockImplementation 会跨用例残留,这里回到默认形状。
  apiMock.getSettings.mockReset().mockResolvedValue({});
  apiMock.setSetting.mockReset().mockResolvedValue(undefined);
  apiMock.hasMinimaxKey.mockReset().mockResolvedValue(false);
  delete document.documentElement.dataset.theme;
});
afterEach(cleanup);

describe("useSettingsForm(逐字迁自 SettingsPage 的保存队列 / 回滚 / 校验)", () => {
  it("载入合并 DEFAULT_SETTINGS 与库值,notice 变「设置已从本地项目载入」", async () => {
    apiMock.getSettings.mockResolvedValue({ "appearance.theme": "dark" });
    const { result } = renderHook(() => useSettingsForm());
    expect(result.current.notice).toBe("正在读取本地设置…");
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(result.current.settings["appearance.theme"]).toBe("dark");
    expect(result.current.settings["performance.worker_count"]).toBe("4");
    expect(result.current.notice).toBe("设置已从本地项目载入");
  });

  it("可选状态读取失败时核心设置仍载入,notice 报失败项数", async () => {
    apiMock.getAppInfo.mockRejectedValueOnce(new Error("x"));
    apiMock.listDeviceClocks.mockRejectedValueOnce(new Error("y"));
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(result.current.notice).toBe("核心设置已载入；2 项状态暂时不可用，可稍后刷新");
  });

  it("核心设置读取失败:settingsLoaded 保持 false,notice 说编辑已停用", async () => {
    apiMock.getSettings.mockRejectedValueOnce(new Error("db locked"));
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.notice).toContain("核心设置读取失败"));
    expect(result.current.notice).toContain("编辑已停用");
    expect(result.current.settingsLoaded).toBe(false);
  });

  it("save 串行:第二条等第一条落定才发(SettingsPage.tsx:642 的队列语义)", async () => {
    const order: string[] = [];
    let release!: () => void;
    apiMock.setSetting.mockImplementation(async (key: string) => {
      order.push(`start:${key}`);
      if (key === "a") await new Promise<void>((r) => { release = r; });
      order.push(`end:${key}`);
    });
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    let p1!: Promise<boolean>;
    let p2!: Promise<boolean>;
    await act(async () => {
      p1 = result.current.save("a", "1");
      p2 = result.current.save("b", "2");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(order).toEqual(["start:a"]);
    await act(async () => {
      release();
      await Promise.all([p1, p2]);
    });
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  it("save 失败回滚到已确认值,且旧失败不覆盖新成功(版本号)", async () => {
    apiMock.getSettings.mockResolvedValue({ "performance.worker_count": "4" });
    let rejectFirst!: (e: Error) => void;
    apiMock.setSetting
      .mockImplementationOnce(() => new Promise<void>((_, rej) => { rejectFirst = rej; }))
      .mockResolvedValue(undefined);
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    await act(async () => {
      first = result.current.save("performance.worker_count", "6");
      second = result.current.save("performance.worker_count", "8");
      await Promise.resolve();
      rejectFirst(new Error("磁盘只读"));
      await first;
      await second;
    });
    expect(result.current.settings["performance.worker_count"]).toBe("8");
    expect(result.current.notice).toBe("已保存,后台并行任务数将在重启后生效");
  });

  it("单次 save 失败:值回到已确认值,notice 报「保存失败」", async () => {
    apiMock.setSetting.mockRejectedValueOnce(new Error("磁盘只读"));
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    let ok = true;
    await act(async () => {
      ok = await result.current.save("performance.worker_count", "6");
    });
    expect(ok).toBe(false);
    expect(result.current.settings["performance.worker_count"]).toBe("4");
    // R11 简化专项 #5:错误一句话,不带 `Error:` 这种内部前缀,并说下一步。
    expect(result.current.notice).toBe("保存失败:磁盘只读。再试一次");
  });

  it("未载入前 save 返回 false 并提示", async () => {
    apiMock.getSettings.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useSettingsForm());
    let ok = true;
    await act(async () => {
      ok = await result.current.save("x", "y");
    });
    expect(ok).toBe(false);
    expect(result.current.notice).toBe("核心设置尚未载入，暂不能编辑");
    expect(apiMock.setSetting).not.toHaveBeenCalled();
  });

  it("appearance.* 保存时立刻 applyAppearanceSettings", async () => {
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    await act(async () => { await result.current.save("appearance.theme", "dark"); });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("月预算超 500 被夹住并给 clamp note", async () => {
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    await act(async () => { await result.current.saveMinimaxBudget("900"); });
    expect(apiMock.setSetting).toHaveBeenCalledWith("minimax_monthly_budget_usd", "500");
    expect(result.current.minimaxBudgetClampNote).toBe("月度预算已从 900 调整为 500（上限 500 美元）");
    await act(async () => { await result.current.saveMinimaxBudget("12"); });
    expect(result.current.minimaxBudgetClampNote).toBeNull();
  });

  it("每月 LLM 调用预算不是 0–10000 整数时拒绝、回退并提示", async () => {
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    await act(async () => { await result.current.saveLlmBudget("99999"); });
    expect(apiMock.setSetting).not.toHaveBeenCalled();
    expect(result.current.settings.llm_monthly_budget).toBe("200");
    expect(result.current.notice).toBe("每月调用预算必须是 0–10000 的整数");
    await act(async () => { await result.current.saveLlmBudget("50"); });
    expect(apiMock.setSetting).toHaveBeenCalledWith("llm_monthly_budget", "50");
  });

  it("provider 未锁定时不许启用增强分析(原 L3)", async () => {
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    await act(async () => { await result.current.setLlmEnabled(true); });
    expect(apiMock.setSetting).not.toHaveBeenCalled();
    expect(result.current.notice).toBe("请先明确锁定一个 LLM provider,再启用增强分析");
  });

  it("设备时钟偏移不是数字时拒绝并提示", async () => {
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    act(() => result.current.setClockDraft("DJI Pocket 4", "abc"));
    await act(async () => { await result.current.saveDeviceClock("DJI Pocket 4"); });
    expect(apiMock.setDeviceClockOffset).not.toHaveBeenCalled();
    expect(result.current.notice).toBe("设备时钟偏移必须是有效秒数");
    act(() => result.current.setClockDraft("DJI Pocket 4", "1.5"));
    await act(async () => { await result.current.saveDeviceClock("DJI Pocket 4"); });
    expect(apiMock.setDeviceClockOffset).toHaveBeenCalledWith("DJI Pocket 4", 1500);
  });

  it("MiniMax key:保存后草稿清空、hasKey 重读,key 本身不留在状态里", async () => {
    apiMock.hasMinimaxKey.mockResolvedValueOnce(false).mockResolvedValue(true);
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(result.current.minimaxHasKey).toBe(false);
    act(() => result.current.setMinimaxKeyDraft("sk-secret"));
    await act(async () => { await result.current.saveMinimaxKey(); });
    expect(apiMock.setMinimaxKey).toHaveBeenCalledWith("sk-secret");
    expect(result.current.minimaxKeyDraft).toBe("");
    expect(result.current.minimaxHasKey).toBe(true);
    expect(result.current.minimaxKeyNotice).toBe("已保存");
    expect(JSON.stringify(result.current)).not.toContain("sk-secret");
    await act(async () => { await result.current.clearMinimaxKey(); });
    expect(apiMock.clearMinimaxKey).toHaveBeenCalled();
    expect(result.current.minimaxKeyNotice).toBe("已清除");
  });

  it("清缓存要点两次:第一次只 arm 并提示,第二次才调用并报告释放量", async () => {
    apiMock.clearCacheAndRebuild.mockResolvedValue({ removed_database_rows: 3, reset_jobs: 1, removed_disk_bytes: 2_048 });
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    await act(async () => { await result.current.clearCache(); });
    expect(apiMock.clearCacheAndRebuild).not.toHaveBeenCalled();
    expect(result.current.cacheConfirm).toBe(true);
    // R15:文案改成新手能懂的话(留什么、删什么、进度在哪)。
    expect(result.current.notice).toBe("请再点一次确认;素材、评分和片段都会留着,原片不会被删");
    await act(async () => { await result.current.clearCache(); });
    expect(apiMock.clearCacheAndRebuild).toHaveBeenCalledTimes(1);
    expect(result.current.cacheConfirm).toBe(false);
    expect(result.current.notice).toBe("已清理 2.00 KB 缓存文件,后台正在重新生成 1 个预览文件;进度看底栏");
  });

  it("回滚提示独立于 notice(R6 终审 P2)", async () => {
    apiMock.rollbackComponent.mockResolvedValue({
      id: "ffmpeg",
      title: "FFmpeg",
      installed: true,
      detail: "",
      installable: false,
      approx_size_mb: 0,
      recovered_from_rolling: false,
      has_previous: false,
      previous_version: null,
    });
    const { result } = renderHook(() => useSettingsForm());
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    await act(async () => { await result.current.rollbackTool("ffmpeg"); });
    expect(result.current.rollbackNotice).toBe("FFmpeg 已回滚到上一版");
    expect(result.current.notice).toBe("设置已从本地项目载入");
  });
});

describe("R10 U-34:云端补镜空 Key 与无 Key 启用都要有反馈", () => {
  it("空 Key 点保存:不调 setMinimaxKey,notice 说明先粘贴", async () => {
    const { result } = renderHook(useSettingsForm);
    await act(async () => { await result.current.saveMinimaxKey(); });
    expect(apiMock.setMinimaxKey).not.toHaveBeenCalled();
    expect(result.current.minimaxKeyNotice).toBe("请先粘贴 MiniMax 密钥，再保存。");
    act(() => result.current.setMinimaxKeyDraft("   "));
    await act(async () => { await result.current.saveMinimaxKey(); });
    expect(apiMock.setMinimaxKey).not.toHaveBeenCalled();
  });
  it("没有 Key 时打开开关:仍写 minimax_enabled=true,但 notice 说明现在还不能用;关掉清 notice", async () => {
    const { result } = renderHook(useSettingsForm);
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    await act(async () => { await result.current.saveMinimaxEnabled(true); });
    expect(apiMock.setSetting).toHaveBeenCalledWith("minimax_enabled", "true");
    expect(result.current.minimaxKeyNotice).toContain("还没有密钥");
    await act(async () => { await result.current.saveMinimaxEnabled(false); });
    expect(result.current.minimaxKeyNotice).toBeNull();
  });
});
