// @vitest-environment jsdom
import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMock);

import { SelectSegmentsSection } from "./InspectorSegments";
import { PoolCard } from "./PoolCard";
import { readInterestWeight, writeInterestWeight } from "./settings/AnalysisSection";

const clip = {
  id: 9,
  file_name: "IMG_0812.mov",
  cover_url: null,
  duration_ticks: 8000,
  tb_num: 1,
  tb_den: 1000,
} as unknown as Parameters<typeof PoolCard>[0]["clip"];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("R18 B-4:自动挑选说得出为什么,也能只丢一段", () => {
  it("自动挑的段画出「为什么选它」,按钮说「不要这一段」;手打的段两样都没有", async () => {
    apiMock.listSelectSegments.mockResolvedValue([
      { id: 1, clip_id: 3, in_ticks: 0, out_ticks: 4000, tb_num: 1, tb_den: 1000, source: "auto", reasons: ["清晰", "有人声"] },
      { id: 2, clip_id: 3, in_ticks: 5000, out_ticks: 9000, tb_num: 1, tb_den: 1000, source: null, reasons: [] },
    ]);
    render(<SelectSegmentsSection clipId={3} selectCount={2} readOnly={false} />);
    await screen.findByRole("list", { name: "精选段列表" });
    expect(screen.getByText("为什么选它:清晰 · 有人声")).toBeTruthy();
    expect(screen.getByRole("button", { name: "不要这一段 1" })).toBeTruthy();
    // 手打的段还是原来的名字(冻结的 AX 名不许改)。
    expect(screen.getByRole("button", { name: "删除精选段 2" })).toBeTruthy();
  });

  it("「不要这一段」走的是同一条软删路径(后端顺手把它从批次里摘掉)", async () => {
    apiMock.listSelectSegments.mockResolvedValue([
      { id: 11, clip_id: 3, in_ticks: 0, out_ticks: 4000, tb_num: 1, tb_den: 1000, source: "auto", reasons: [] },
    ]);
    render(<SelectSegmentsSection clipId={3} selectCount={1} readOnly={false} />);
    await screen.findByRole("list", { name: "精选段列表" });
    // 没有理由时也要有一句话,不能空着。
    expect(screen.getByText("自动挑的:这一段整体分最高")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "不要这一段 1" }));
    });
    expect(apiMock.deleteSelectSegment).toHaveBeenCalledWith(11);
  });
});

describe("R18 C-2:搜索结果卡说得出第几秒", () => {
  it("有命中时刻就画「第 n 秒」,点它定位;没有就不画", () => {
    const onSeekToMatch = vi.fn();
    const { rerender } = render(
      <PoolCard
        clip={clip}
        columnIndex={1}
        semanticScore={0.8}
        semanticAtSeconds={4.4}
        onSeekToMatch={onSeekToMatch}
        selected={false}
        isAnchor={false}
        inMultiSelection={false}
        onSelect={() => undefined}
      />,
    );
    const badge = document.querySelector(".pool-card-at");
    expect(badge?.textContent).toContain("第 4 秒");
    fireEvent.click(badge as Element);
    expect(onSeekToMatch).toHaveBeenCalledTimes(1);

    rerender(
      <PoolCard
        clip={clip}
        columnIndex={1}
        semanticScore={0.8}
        selected={false}
        isAnchor={false}
        inMultiSelection={false}
        onSelect={() => undefined}
      />,
    );
    expect(document.querySelector(".pool-card-at")).toBeNull();
  });
});

describe("R18 B-1:设置里的「画面少见」只动 moments.weights 里的一个键", () => {
  it("读缺省 0.20;写回时其余五项原样保留", () => {
    expect(readInterestWeight(undefined)).toBe("0.20");
    expect(readInterestWeight("不是 JSON")).toBe("0.20");
    expect(readInterestWeight('{"interest":0.35}')).toBe("0.35");
    const next = writeInterestWeight('{"sharp":0.5,"motion":0.2}', "0.40");
    expect(JSON.parse(next)).toEqual({ sharp: 0.5, motion: 0.2, interest: 0.4 });
  });
});
