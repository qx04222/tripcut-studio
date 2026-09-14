// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("../testApiMock");
  return createTestApiMock({});
});
vi.mock("../../api", () => apiMocks);

import { LutFilesRow, WhisperModelDelete } from "./ManagedFilesR16";

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.listDisplayLuts.mockResolvedValue(["/luts/Teal.cube", "/luts/Warm.cube"]);
});

/** R16 P2-6:删 LUT / 删模型——不可逆 → 行内确认一次;删后刷新。 */
describe("LutFilesRow", () => {
  it("列出文件名;「删除…」先确认,「确定删除」才调 deleteDisplayLut(文件名)并按返回值刷新", async () => {
    const nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    apiMocks.deleteDisplayLut.mockResolvedValue(["/luts/Warm.cube"]);
    render(<LutFilesRow />);
    await screen.findByText("Teal.cube");
    fireEvent.click(screen.getByRole("button", { name: "删除 Teal.cube" }));
    expect(apiMocks.deleteDisplayLut).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确定删除 Teal.cube" }));
    await waitFor(() => expect(apiMocks.deleteDisplayLut).toHaveBeenCalledWith("Teal.cube"));
    await waitFor(() => expect(screen.queryByText("Teal.cube")).toBeNull());
    expect(screen.getByText("Warm.cube")).toBeTruthy();
    expect(nativeConfirm).not.toHaveBeenCalled();
    nativeConfirm.mockRestore();
  });

  it("空列表给一句去哪添加", async () => {
    apiMocks.listDisplayLuts.mockResolvedValue([]);
    render(<LutFilesRow />);
    await screen.findByText(/还没有调色文件/);
  });
});

describe("WhisperModelDelete", () => {
  it("确认后调 deleteWhisperModel(当前档),再让设置页重新检测", async () => {
    apiMocks.deleteWhisperModel.mockResolvedValue(1_620_000_000);
    const onDeleted = vi.fn().mockResolvedValue(undefined);
    render(<WhisperModelDelete tier="small" busy={false} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole("button", { name: "删除已导入的模型文件" }));
    fireEvent.click(screen.getByRole("button", { name: "确定删除 small 模型文件" }));
    await waitFor(() => expect(apiMocks.deleteWhisperModel).toHaveBeenCalledWith("small"));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    await screen.findByText(/腾出 1\.6 GB/);
  });

  it("后端拒绝(转写在跑)原话进提示", async () => {
    apiMocks.deleteWhisperModel.mockRejectedValue(new Error("有转写任务正在运行"));
    render(<WhisperModelDelete tier="small" busy={false} onDeleted={async () => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "删除已导入的模型文件" }));
    fireEvent.click(screen.getByRole("button", { name: "确定删除 small 模型文件" }));
    await screen.findByText(/有转写任务正在运行/);
  });
});
