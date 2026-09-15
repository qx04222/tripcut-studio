// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("../testApiMock");
  return createTestApiMock({});
});
vi.mock("../../api", () => apiMocks);

import { PerformanceSection, currentEffort } from "./PerformanceSection";
import { SettingsFormContext } from "./SettingsFormContext";
import type { SettingsForm } from "./useSettingsForm";

function mount(settings: Record<string, string>, performance: Record<string, unknown> | undefined, cache: Record<string, unknown> = {}) {
  const save = vi.fn(async () => true);
  const form = {
    settings,
    status: { cache: { proxy_bytes: 0, proxy_limit_bytes: 1, ...cache }, performance },
    busy: false,
    save,
  } as unknown as SettingsForm;
  render(
    <SettingsFormContext.Provider value={form}>
      <PerformanceSection />
    </SettingsFormContext.Provider>,
  );
  return save;
}
afterEach(cleanup);

/** R18 W-2:三挡力度取代 1–8 安慰剂旋钮;W-7:快照占用可见。 */
describe("PerformanceSection R18", () => {
  it("标准档给三挡,改挡写 performance.background_effort,旧旋钮不再出现", () => {
    const save = mount({}, { profile: "standard", chip: "base", media_engines: 1, perf_cores: 4, decode_permits: 8, background_effort: "balanced", allows_full_effort: true, worker_count: 6 });
    const select = screen.getByRole("combobox", { name: "后台干活的力度" }) as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(["省电", "平衡(推荐)", "全速(插电时)"]);
    expect(screen.queryByRole("combobox", { name: "后台同时处理几条" })).toBeNull();
    fireEvent.change(select, { target: { value: "eco" } });
    expect(save).toHaveBeenCalledWith("performance.background_effort", "eco");
    expect(screen.getByText(/当前:标准档 · Apple 基础款芯片 · 1 个媒体引擎/)).toBeTruthy();
  });

  it("低配 / 省内存档只给两挡,库里存过 full 也回落到平衡", () => {
    mount({ "performance.background_effort": "full" }, { profile: "low", chip: "base", media_engines: 1, perf_cores: 4, decode_permits: 4, background_effort: "full", allows_full_effort: false, worker_count: 4 });
    const select = screen.getByRole("combobox", { name: "后台干活的力度" }) as HTMLSelectElement;
    expect(select.options.length).toBe(2);
    expect(select.value).toBe("balanced");
    expect(currentEffort("full", { allows_full_effort: false } as never)).toBe("balanced");
    expect(currentEffort(undefined, undefined)).toBe("balanced");
  });

  it("旧后端没有 performance 段也能渲染;有快照字段时显示占用行", () => {
    mount({}, undefined);
    expect(screen.getByRole("combobox", { name: "后台干活的力度" })).toBeTruthy();
    expect(screen.queryByText(/启动快照占用/)).toBeNull();
    cleanup();
    mount({}, undefined, { snapshot_bytes: 12 * 1024 * 1024, snapshot_limit_bytes: 1024 ** 3 });
    expect(screen.getByText(/启动快照占用/)).toBeTruthy();
    expect(screen.getByText(/上限 1\.00 GB/)).toBeTruthy();
  });
});
