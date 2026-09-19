// @vitest-environment jsdom
// R19 Wave 2 接线(results 车道待拍板项):自动挑选带 `run_id` 时结果面板已经开着、里面有「全部撤销」,
// toast 就不再带「撤销」那条(两处同一件事的入口,首次零决定用户只看一处);没有 run_id 的旧路径照旧。
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JSX } from "react";
import { useEffect } from "react";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  undoAutoSelect: vi.fn().mockResolvedValue(3),
}));
vi.mock("./useClipsFeed", () => ({ useClipsFeed: () => ({ clips: [] }), refreshClipsFeed: vi.fn(async () => undefined) }));

import type { AutoSelectResult } from "./BandAutoSelect";
import { ToastHost } from "./ui/Toast";
import { useBandArrange } from "./useBandArrange";

const BASE: AutoSelectResult = { created: [1, 2, 3], total_secs: 44.6, chapters_covered: 2, batch_id: "auto-7", placed: 3, arrange_batch_id: "arr-7", scope_used: "all", fell_back: false };

function Fire({ outcome }: { outcome: AutoSelectResult }): JSX.Element {
  const { onAutoSelected } = useBandArrange();
  useEffect(() => onAutoSelected(outcome), [onAutoSelected, outcome]);
  return <ToastHost />;
}

afterEach(cleanup);

describe("R19 接线:结果面板开着时 toast 不再带「撤销」", () => {
  it("outcome 带 run_id(结果面板会开)→ toast 仍报「已挑选」但没有「撤销」按钮", async () => {
    render(<Fire outcome={{ ...BASE, run_id: "auto-7", undo_id: 1 }} />);
    const toast = await screen.findByRole("status");
    await waitFor(() => expect(toast.textContent).toContain("已挑选 3 段"));
    expect(within(toast).queryByRole("button", { name: "撤销" })).toBeNull();
  });

  it("首次零决定(first_run)带 run_id:「改范围 / 改时长」次要动作留着,「撤销」不在", async () => {
    render(<Fire outcome={{ ...BASE, run_id: "auto-7", undo_id: 1, first_run: true, budget_secs: 45, platform_label: "抖音" }} />);
    const toast = await screen.findByRole("status");
    expect(within(toast).queryByRole("button", { name: "撤销" })).toBeNull();
    expect(within(toast).getAllByRole("button").length).toBeGreaterThan(0);
  });

  it("没有 run_id 的旧路径:toast 照旧带「撤销」", async () => {
    render(<Fire outcome={BASE} />);
    const toast = await screen.findByRole("status");
    expect(within(toast).getByRole("button", { name: "撤销" })).toBeTruthy();
  });
});
