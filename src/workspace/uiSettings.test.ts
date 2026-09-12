import { describe, expect, it, vi } from "vitest";
import {
  UI_SETTING_DEFAULTS,
  createUiSettingWriter,
  readUiBool,
  readUiList,
  readUiNumber,
  readUiSetting,
} from "./uiSettings";

describe("readUiSetting", () => {
  it("键缺席时回落到默认值,而不是空串", () => {
    // get_settings 只返回 Rust defaults() 与 settings 表的并集;ui.* 不在 defaults() 里,
    // 从没写过的键根本不出现在 map 中(见计划「已核实的事实 2」)。
    expect(readUiSetting({}, "ui.pane.pool_width")).toBe("320");
    expect(readUiNumber({}, "ui.pane.monitor_height")).toBeCloseTo(0.55);
    expect(readUiBool({}, "ui.pane.pool_collapsed")).toBe(false);
    expect(readUiList({}, "ui.inspector.sections_open")).toEqual([]);
  });
  it("库里的值覆盖默认值", () => {
    expect(readUiNumber({ "ui.pane.pool_width": "460" }, "ui.pane.pool_width")).toBe(460);
    expect(readUiList({ "ui.inspector.sections_open": '["similar"]' }, "ui.inspector.sections_open"))
      .toEqual(["similar"]);
  });
  it("坏值回落默认而不是抛异常", () => {
    expect(readUiNumber({ "ui.pane.pool_width": "abc" }, "ui.pane.pool_width")).toBe(320);
    expect(readUiList({ "ui.inspector.sections_open": "{" }, "ui.inspector.sections_open")).toEqual([]);
  });
  it("每个偏好键都有默认值,空串只允许出现在 ui.pool.dimension", () => {
    // 规格 §5 的表里 ui.pool.dimension 的默认值就是 "",所以这里断言「等于声明的默认值」
    // 而不是「非空」——非空版本会把规格自己的默认值判成缺陷。
    for (const [key, value] of Object.entries(UI_SETTING_DEFAULTS)) {
      expect(readUiSetting({}, key)).toBe(value);
    }
    for (const key of Object.keys(UI_SETTING_DEFAULTS)) {
      if (key !== "ui.pool.dimension") expect(readUiSetting({}, key)).not.toBe("");
    }
  });
});

describe("createUiSettingWriter", () => {
  it("400ms 内同一个键连写只落一次,取最后一次的值", async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockResolvedValue(undefined);
    const writer = createUiSettingWriter(write, 400);
    for (const width of [300, 320, 340, 360, 380]) writer.queue("ui.pane.pool_width", String(width));
    expect(write).not.toHaveBeenCalled(); // 拖分隔条期间一次都不写
    await vi.advanceTimersByTimeAsync(400);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("ui.pane.pool_width", "380");
    vi.useRealTimers();
  });
  it("不同键各自成条,但写入串行(前一条落定再发下一条)", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let release: (() => void) | null = null;
    const write = vi.fn(async (key: string) => {
      order.push(`start:${key}`);
      if (key === "ui.pane.pool_width") await new Promise<void>((r) => { release = r; });
      order.push(`end:${key}`);
    });
    const writer = createUiSettingWriter(write, 400);
    writer.queue("ui.pane.pool_width", "320");
    writer.queue("ui.band.mode", "music");
    await vi.advanceTimersByTimeAsync(400);
    expect(order).toEqual(["start:ui.pane.pool_width"]); // 第二条还没发
    // TS 把只在闭包里赋值的 release 收窄成 null,这里明确回放它真正的类型。
    (release as (() => void) | null)?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual([
      "start:ui.pane.pool_width", "end:ui.pane.pool_width",
      "start:ui.band.mode", "end:ui.band.mode",
    ]);
    vi.useRealTimers();
  });
  it("一条写失败不卡死队列", async () => {
    vi.useFakeTimers();
    const write = vi.fn()
      .mockRejectedValueOnce(new Error("设置项无效"))
      .mockResolvedValue(undefined);
    const writer = createUiSettingWriter(write, 400);
    writer.queue("ui.band.mode", "music");
    await vi.advanceTimersByTimeAsync(400);
    writer.queue("ui.pool.filter", "favorite");
    await vi.advanceTimersByTimeAsync(400);
    expect(write).toHaveBeenCalledTimes(2);
    expect(writer.pendingCount()).toBe(0);
    vi.useRealTimers();
  });
});
