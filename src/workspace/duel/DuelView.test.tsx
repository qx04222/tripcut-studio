// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DuelSession } from "../../api";
import { DuelView } from "./DuelView";
import { __resetUndoForTests, peekUndo } from "../undoStack";

const action = vi.hoisted(() => vi.fn());
vi.mock("../../api", () => ({ duelAction: action }));
vi.mock("../useClipsFeed", () => ({ refreshClipsFeed: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./DuelPreview", () => ({ DuelPreview: () => <div>预览</div> }));
const initial = (): DuelSession => ({ id: 1, members: Array.from({ length: 7 }, (_, i) => ({ clip_id: i + 1, segment_id: i === 6 ? 77 : i === 5 ? 66 : null })), pair: ["photo:1", "photo:2"], winners: [], round: 0, total: 6, finished: false, undone: false });
afterEach(() => { cleanup(); vi.clearAllMocks(); __resetUndoForTests(); });
describe("DuelView", () => {
  it("arrow sequence →→←→↑→ yields winners; AX and one batch undo", async () => {
    let s = initial(); const queue = ["photo:1", "photo:2", "photo:3", "photo:4", "photo:5", "video:66", "video:77"];
    action.mockImplementation(async (_id, op, winner) => {
      if (op === "decide") {
        const [a, b] = queue.splice(0, 2);
        if (winner === null) { s.winners.push(a!); queue.unshift(b!); } else queue.unshift(winner);
        s = { ...s, round: s.round + 1, pair: queue.length > 1 ? queue.slice(0, 2) : [], winners: queue.length === 1 ? [...s.winners, queue[0]!] : s.winners };
      } else if (op === "finish") s = { ...s, finished: true };
      return structuredClone(s);
    });
    render(<DuelView initial={s} clips={[]} onClose={vi.fn()} />);
    expect(screen.getByRole("region", { name: "擂台" })).toBeTruthy();
    for (const name of ["左边更好", "右边更好", "两个都留", "撤销上一场"]) expect(screen.getByRole("button", { name })).toBeTruthy();
    const keys = ["ArrowRight", "ArrowRight", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowRight"];
    for (const [i, key] of keys.entries()) {
      await act(async () => { fireEvent.keyDown(document, { key }); });
      await waitFor(() => expect(action.mock.calls.filter((c) => c[1] === "decide")).toHaveLength(i + 1));
    }
    expect(await screen.findByText("本组已选好")).toBeTruthy();
    expect(peekUndo()?.label).toBe("撤销擂台");
  });
  it("Esc retains progress; reopened session continues; cmd-z undoes only last match", async () => {
    const close = vi.fn(); const s = { ...initial(), round: 2, pair: ["photo:3", "photo:4"] };
    action.mockResolvedValue({ ...s, round: 1, pair: ["photo:2", "photo:3"] });
    const view = render(<DuelView initial={s} clips={[]} onClose={close} />);
    fireEvent.keyDown(document, { key: "Escape" }); expect(close).toHaveBeenCalledOnce(); expect(action).not.toHaveBeenCalled();
    view.unmount(); render(<DuelView initial={s} clips={[]} onClose={close} />);
    expect(screen.getByText("第 3/6 场")).toBeTruthy();
    await act(async () => { fireEvent.keyDown(document, { key: "z", metaKey: true }); });
    expect(action).toHaveBeenCalledWith(1, "undo_last");
    expect(screen.getByText("第 2/6 场")).toBeTruthy();
  });
});

it("keeps the last durable verdict when finish fails, then retries finish", async () => {
  const s = { ...initial(), round: 5, pair: ["photo:6", "video:77"] };
  const decided = { ...s, round: 6, pair: [], winners: ["video:77"] };
  let attempts = 0;
  action.mockImplementation(async (_id, op) => {
    if (op === "decide") return decided;
    if (op === "finish" && attempts++ === 0) throw new Error("database busy");
    return { ...decided, finished: true };
  });
  render(<DuelView initial={s} clips={[]} onClose={vi.fn()} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "右边更好" })); });
  fireEvent.click(await screen.findByRole("button", { name: "完成本组" }));
  expect(await screen.findByText("本组已选好")).toBeTruthy();
  expect(action.mock.calls.filter((call) => call[1] === "decide")).toHaveLength(1);
});
