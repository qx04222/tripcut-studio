// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImportRunningJobs } from "./ImportRunningJobs";
import { runningJobLabel } from "./importModel";

afterEach(cleanup);

const job = (id: number, kind: string, file: string | null) => ({ id, kind, clip_id: 1, file_name: file, started_at: "2026-09-14T00:00:00Z", cancel_requested: false });

/** R16 P1-6:后台任务行「取消」——确认一次(行内),不弹原生对话框;kind 不露内部术语。 */
describe("ImportRunningJobs(R16 P1-6)", () => {
  it("没有任务时不渲染", () => {
    const { container } = render(<ImportRunningJobs jobs={[]} busy={false} onCancel={() => undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("每行一颗「取消」,第一次点只进入确认态,第二次才调 onCancel;「保留」退出确认", () => {
    const onCancel = vi.fn();
    const nativeConfirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ImportRunningJobs jobs={[job(1, "analyze_l1", "A.MOV"), job(2, "transcribe", null)]} busy={false} onCancel={onCancel} />);
    expect(screen.getByRole("region", { name: "正在处理" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消 画质分析 A.MOV" }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByText("确定取消?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保留" }));
    expect(screen.queryByText("确定取消?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "取消 语音转写" }));
    fireEvent.click(screen.getByRole("button", { name: "确定取消 语音转写" }));
    expect(onCancel).toHaveBeenCalledWith(2);
    expect(nativeConfirm).not.toHaveBeenCalled();
    nativeConfirm.mockRestore();
  });

  it("任务名不出现内部术语;没见过的 kind 叫「后台处理」", () => {
    for (const kind of ["analyze_l1", "clip_embed", "proxy", "full_hash", "moments", "strip"]) {
      expect(runningJobLabel(kind)).not.toMatch(/L1|embed|proxy|hash|ticks|strip/i);
    }
    expect(runningJobLabel("something_new")).toBe("后台处理");
  });
});
