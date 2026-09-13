// @vitest-environment jsdom
import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("../testApiMock");
  return createTestApiMock({});
});
vi.mock("../../api", () => apiMock);

import { SelectSegmentsSection } from "../InspectorSegments";
import { Menu } from "../ui/Menu";
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "../WorkspaceStore";
import { ExportSelectedButton, PoolExportContextMenu } from "./QuickExportEntry";
import { __resetQuickExportForTests, takePendingQuickSelection } from "./quickExportModel";

beforeEach(() => {
  vi.clearAllMocks();
  __resetWorkspaceForTests();
  __resetQuickExportForTests();
});
afterEach(cleanup);

describe("「导出所选…」入口(R11 车道 E)", () => {
  it("检查器精选段区:有段才出现「导出所选」,点了只把这些段交给抽屉的快速导出", async () => {
    apiMock.listSelectSegments.mockResolvedValue([
      { id: 7, clip_id: 3, in_ticks: 0, out_ticks: 1000, tb_num: 1, tb_den: 1000 },
      { id: 8, clip_id: 3, in_ticks: 2000, out_ticks: 3000, tb_num: 1, tb_den: 1000 },
    ]);
    render(<SelectSegmentsSection clipId={3} selectCount={2} readOnly={false} />);
    const button = await screen.findByRole("button", { name: "导出所选" });
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(getWorkspaceSnapshot().openDrawer).toBe("deliver");
    expect(takePendingQuickSelection()).toEqual({ segment_ids: [7, 8] });
  });

  it("检查器没有精选段时不出现「导出所选」", async () => {
    apiMock.listSelectSegments.mockResolvedValue([]);
    render(<SelectSegmentsSection clipId={3} selectCount={0} readOnly={false} />);
    await screen.findByText(/还没有精选段/);
    expect(screen.queryByRole("button", { name: "导出所选" })).toBeNull();
  });

  it("按钮本体:没有段就禁用", () => {
    render(<ExportSelectedButton segmentIds={[]} />);
    expect((screen.getByRole("button", { name: "导出所选" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("媒体池右键:点中的卡在多选里 → 菜单「导出所选」带整批多选;不在 → 只带它一张", async () => {
    render(
      <div className="media-pool">
        <div role="grid" aria-label="媒体池">
          <div role="row">
            <div role="gridcell" id="pool-clip-3" aria-label="三" />
            <div role="gridcell" id="pool-clip-9" aria-label="九" />
          </div>
        </div>
        <PoolExportContextMenu multiSelection={[3, 4]} />
      </div>,
    );
    fireEvent.contextMenu(screen.getByRole("gridcell", { name: "三" }), { clientX: 40, clientY: 50 });
    const item = await screen.findByRole("menuitem", { name: "导出所选" });
    expect(item.textContent).toContain("2 条");
    await act(async () => {
      item.click();
      await Promise.resolve();
    });
    expect(getWorkspaceSnapshot().openDrawer).toBe("deliver");
    expect(takePendingQuickSelection()).toEqual({ clip_ids: [3, 4] });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.contextMenu(screen.getByRole("gridcell", { name: "九" }), { clientX: 40, clientY: 50 });
    const single = await screen.findByRole("menuitem", { name: "导出所选" });
    await act(async () => {
      single.click();
      await Promise.resolve();
    });
    expect(takePendingQuickSelection()).toEqual({ clip_ids: [9] });
  });

  it("右键点在空白处不弹菜单", () => {
    render(
      <div className="media-pool">
        <div role="grid" aria-label="媒体池">
          <p>空白</p>
        </div>
        <PoolExportContextMenu multiSelection={[]} />
      </div>,
    );
    fireEvent.contextMenu(screen.getByText("空白"));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("套件 Menu", () => {
  it("打开即聚焦第一项;Esc 关闭;↓ 在项间移动;Enter 选中并关闭", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <Menu
        x={10}
        y={10}
        ariaLabel="测试菜单"
        items={[
          { id: "a", label: "甲" },
          { id: "b", label: "乙" },
        ]}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    const menu = screen.getByRole("menu", { name: "测试菜单" });
    const first = screen.getByRole("menuitem", { name: "甲" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "乙" }));
    (document.activeElement as HTMLButtonElement).click();
    expect(onSelect).toHaveBeenCalledWith("b");
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("点菜单外面关闭", () => {
    const onClose = vi.fn();
    render(
      <div>
        <button type="button">外面</button>
        <Menu x={0} y={0} ariaLabel="m" items={[{ id: "a", label: "甲" }]} onSelect={() => undefined} onClose={onClose} />
      </div>,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "外面" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
