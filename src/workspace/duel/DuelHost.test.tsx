// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ClipListItem } from "../../api";
import { duelHandlers } from "../../devMock/duel";
import { requestDuel } from "./duelEntry";
import { DuelHost } from "./DuelHost";
import { __resetUndoForTests } from "../undoStack";
const mocks = vi.hoisted(() => ({ start: vi.fn(), action: vi.fn(), resolve: vi.fn(), refresh: vi.fn().mockResolvedValue(undefined) }));
const feedState = vi.hoisted(() => ({ episode: { activeId: 1, viewing: null as { id: number } | null } }));
vi.mock("../../api", () => ({ startDuel: mocks.start, duelAction: mocks.action }));
vi.mock("../useClipsFeed", () => ({ useClipsFeed: () => ({ clips: [], episode: feedState.episode }), refreshClipsFeed: mocks.refresh }));
vi.mock("./duelEntry", () => ({ OPEN_DUEL: "tripcut:open-duel", requestDuel: () => window.dispatchEvent(new CustomEvent("tripcut:open-duel", { detail: {} })), resolveDuel: mocks.resolve }));
vi.mock("./DuelPreview", () => ({ DuelPreview: () => <div>唯一擂台预览</div> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); __resetUndoForTests(); feedState.episode = { activeId: 1, viewing: null }; });
it("mounts only one preview, resumes backend progress after Esc, and refreshes on finish and batch undo", async () => {
  const clips = Array.from({ length: 3 }, (_, i) => ({ id: i + 1, kind: "photo", select_count: 0 }) as ClipListItem);
  const api = duelHandlers({ clips, segments: [], similarGroups: [], stacks: [], revision: 0 });
  mocks.resolve.mockResolvedValue({ members: clips.map((c) => ({ clip_id: c.id, segment_id: null })), source: "manual" });
  mocks.start.mockImplementation((members, source) => Promise.resolve(api.start_duel({ members, source })));
  mocks.action.mockImplementation((sessionId, action, winner = null) => Promise.resolve(api.duel_action({ sessionId, action, winner })));
  render(<DuelHost><div>原监视器</div></DuelHost>);
  await act(async () => requestDuel());
  expect(await screen.findByText("第 1/2 场")).toBeTruthy();
  expect(screen.queryByText("原监视器")).toBeNull();
  await act(async () => { fireEvent.keyDown(document, { key: "ArrowRight" }); });
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.getByText("原监视器")).toBeTruthy();
  await act(async () => requestDuel());
  expect(screen.getByText("第 2/2 场")).toBeTruthy();
  await act(async () => { fireEvent.keyDown(document, { key: "ArrowRight" }); });
  expect(await screen.findByText("本组已选好")).toBeTruthy();
  expect(mocks.refresh).toHaveBeenCalledOnce();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "整组撤销" })); });
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
});

it("resolveDuel 未落地就切历史集：迟到结果不启动后端擂台", async () => {
  let finishResolve: (value: { members: Array<{ clip_id: number; segment_id: null }>; source: "manual" }) => void = () => undefined;
  mocks.resolve.mockImplementation(() => new Promise((resolve) => { finishResolve = resolve; }));
  const view = render(<DuelHost><div>原监视器</div></DuelHost>);
  act(() => requestDuel());
  feedState.episode = { activeId: 1, viewing: { id: 9 } };
  view.rerender(<DuelHost><div>原监视器</div></DuelHost>);
  await act(async () => finishResolve({ members: [{ clip_id: 1, segment_id: null }, { clip_id: 2, segment_id: null }], source: "manual" }));
  expect(mocks.start).not.toHaveBeenCalled();
  expect(screen.getByText("原监视器")).toBeTruthy();
});

it("startDuel 未落地就换集：迟到 session 不覆盖新集监视器", async () => {
  let finishStart: (value: { id: string }) => void = () => undefined;
  mocks.resolve.mockResolvedValue({ members: [{ clip_id: 1, segment_id: null }, { clip_id: 2, segment_id: null }], source: "manual" });
  mocks.start.mockImplementation(() => new Promise((resolve) => { finishStart = resolve; }));
  const view = render(<DuelHost><div>原监视器</div></DuelHost>);
  await act(async () => requestDuel());
  await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
  feedState.episode = { activeId: 2, viewing: null };
  view.rerender(<DuelHost><div>原监视器</div></DuelHost>);
  await act(async () => finishStart({ id: "late-session" }));
  expect(screen.getByText("原监视器")).toBeTruthy();
  expect(screen.queryByText("唯一擂台预览")).toBeNull();
});
