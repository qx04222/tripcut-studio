// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("../testApiMock");
  return createTestApiMock({});
});
vi.mock("../../api", () => apiMocks);

import { UPDATE_PROGRESS_EVENT } from "../../api";
import { UpdateStatusChip } from "./UpdateStatusChip";
import { __resetUpdateStoreForTests, runUpdateCheck, runUpdateDownload } from "./updateStore";

beforeEach(() => {
  vi.clearAllMocks();
  __resetUpdateStoreForTests();
  apiMocks.setSetting.mockResolvedValue(undefined);
  apiMocks.checkForUpdate.mockResolvedValue({ available: true, version: "0.8.0", notes: "", pub_date: "", current_version: "0.8.0", offline: false, skipped: false });
});
afterEach(cleanup);

/** R17 车道 B:状态条「正在下载更新 42%」,下完留一枚「重启完成更新」。 */
describe("UpdateStatusChip", () => {
  it("空闲不渲染;下载中跟进度念百分比;下完变成可点的重启链接", async () => {
    const { container } = render(<UpdateStatusChip />);
    expect(container.textContent).toBe("");
    let finish: () => void = () => undefined;
    apiMocks.downloadAndInstallUpdate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => {
      await runUpdateCheck("manual");
    });
    let downloading!: Promise<unknown>;
    act(() => {
      downloading = runUpdateDownload();
    });
    act(() => {
      window.dispatchEvent(new CustomEvent(UPDATE_PROGRESS_EVENT, { detail: { downloaded: 42, total: 100 } }));
    });
    expect(screen.getByText("正在下载更新 42%")).toBeTruthy();
    await act(async () => {
      finish();
      await downloading;
    });
    const restart = screen.getByRole("button", { name: "更新已下载 · 重启完成更新" });
    fireEvent.click(restart);
    expect(apiMocks.restartToUpdate).toHaveBeenCalledTimes(1);
  });
});
