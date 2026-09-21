// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createTestApiMock } from "../testApiMock";
import { photoFixture, videoFixture } from "../photoTestFixtures";
import type { DuelSession } from "../../api";

const mocks = vi.hoisted(() => ({ player: vi.fn() }));
vi.mock("../../api", async () => createTestApiMock());
vi.mock("../../PlayerOverlay", () => ({ PlayerOverlay: mocks.player, EmbeddedPlayerControls: {} }));
vi.mock("../usePlayerOcclusion", () => ({ usePlayerOcclusion: () => undefined }));
import { DuelPreview } from "./DuelPreview";
import { DuelView } from "./DuelView";

const other = { ...photoFixture, id: 3, file_name: "other.jpg", iso_value: 800, shutter_speed: "1/500", aperture: "f/4" };
const session: DuelSession = {
  id: 5,
  members: [{ clip_id: 2, segment_id: null }, { clip_id: 3, segment_id: null }, { clip_id: 4, segment_id: null }],
  pair: ["photo:2", "photo:3"],
  winners: [], round: 0, total: 2, finished: false, undone: false,
};

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("shows two full photo previews, EXIF differences, synchronized zoom/pan and the full member strip without PlayerOverlay", () => {
  const third = { ...photoFixture, id: 4, file_name: "third.jpg" };
  render(<DuelPreview session={session} clips={[photoFixture, other, third]} active={0} onActive={vi.fn()} />);
  expect(screen.getAllByRole("img", { name: /对比照片/ })).toHaveLength(2);
  expect(screen.getAllByText("3024×4032")).toHaveLength(2);
  expect(screen.getByText("800").parentElement?.getAttribute("data-different")).toBe("true");
  expect(screen.getByRole("list", { name: "本组照片 3 张" }).children).toHaveLength(3);
  fireEvent.click(screen.getByRole("button", { name: "200%" }));
  const canvases = screen.getAllByRole("group", { name: /照片查看区/ });
  fireEvent.pointerDown(canvases[0]!, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(canvases[0]!, { pointerId: 1, clientX: 35, clientY: 26 });
  fireEvent.pointerUp(canvases[0]!, { pointerId: 1 });
  for (const image of screen.getAllByRole("img", { name: /对比照片/ })) expect(image.getAttribute("style")).toMatch(/translate\(25px, 16px\).*scale\(2\)/);
  expect(mocks.player).not.toHaveBeenCalled();
  expect(document.querySelector(".player-overlay")).toBeNull();
});

it("keeps the existing single-player path for video and mixed pairs", () => {
  const mixed: DuelSession = { ...session, members: [{ clip_id: 1, segment_id: 9, preview: { id: 9, clip_id: 1, in_ticks: 0, out_ticks: 10, tb_num: 1, tb_den: 1 } }, { clip_id: 2, segment_id: null }], pair: ["video:9", "photo:2"] };
  render(<DuelPreview session={mixed} clips={[videoFixture, photoFixture]} active={0} onActive={vi.fn()} />);
  expect(document.querySelectorAll(".duel-player")).toHaveLength(1);
  expect(document.querySelector(".photo-duel-stage")).toBeNull();
});

it("lets DuelView cycle photo zoom with Z without changing the verdict shortcuts", () => {
  render(<DuelView initial={session} clips={[photoFixture, other]} onClose={vi.fn()} />);
  fireEvent.keyDown(document, { key: "z" });
  expect(screen.getByRole("button", { name: "100%" }).getAttribute("aria-pressed")).toBe("true");
});
