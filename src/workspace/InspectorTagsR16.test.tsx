// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMocks);

import { InspectorTags } from "./InspectorTags";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.listTags.mockResolvedValue([
    { id: 1, label: "古城", source: "ai_l3", deletable: false },
    { id: 2, label: "海边", source: "user", deletable: true },
  ]);
});

/** R16 P2-10:检查器标签段真能加删;AI 标签没有 ×。 */
describe("InspectorTags", () => {
  it("列出 AI 与用户标签;只有用户标签带「删除标签 x」;条数报给父级", async () => {
    const onCount = vi.fn();
    render(<InspectorTags clipId={3} onCount={onCount} />);
    await screen.findByText("古城");
    expect(screen.getByRole("button", { name: "删除标签 海边" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "删除标签 古城" })).toBeNull();
    expect(onCount).toHaveBeenLastCalledWith(2);
  });

  it("「添加标签」→ 输入框,回车调 addTag 并追加 chip;Esc 收起", async () => {
    apiMocks.addTag.mockResolvedValue({ id: 9, label: "无人机", source: "user", deletable: true });
    const onCount = vi.fn();
    render(<InspectorTags clipId={3} onCount={onCount} />);
    await screen.findByText("古城");
    fireEvent.click(screen.getByRole("button", { name: "添加标签" }));
    const input = screen.getByRole("textbox", { name: "新标签" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: " 无人机 " } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(apiMocks.addTag).toHaveBeenCalledWith(3, "无人机"));
    await screen.findByRole("button", { name: "删除标签 无人机" });
    expect(onCount).toHaveBeenLastCalledWith(3);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "新标签" }), { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "新标签" })).toBeNull();
    expect(screen.getByRole("button", { name: "添加标签" })).toBeTruthy();
  });

  it("点 × 调 removeTag 并拿掉 chip;后端拒绝原话进提示", async () => {
    apiMocks.removeTag.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("rating failed: AI 生成的标签不能删除"));
    apiMocks.listTags.mockResolvedValue([
      { id: 2, label: "海边", source: "user", deletable: true },
      { id: 5, label: "临时", source: "user", deletable: true },
    ]);
    render(<InspectorTags clipId={3} />);
    await screen.findByText("海边");
    fireEvent.click(screen.getByRole("button", { name: "删除标签 海边" }));
    await waitFor(() => expect(apiMocks.removeTag).toHaveBeenCalledWith(3, 2));
    await waitFor(() => expect(screen.queryByText("海边")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "删除标签 临时" }));
    await screen.findByText(/AI 生成的标签不能删除/);
    expect(screen.getByText("临时")).toBeTruthy();
  });

  it("只读集不给加删入口", async () => {
    render(<InspectorTags clipId={3} readOnly />);
    await screen.findByText("海边");
    expect(screen.queryByRole("button", { name: "添加标签" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除标签 海边" })).toBeNull();
  });
});
