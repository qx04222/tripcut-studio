// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { photoFixture } from "./photoTestFixtures";
import { PhotoInspector } from "./PhotoInspector";
import { PoolCard } from "./PoolCard";
import type { ClipListItem } from "../api";
afterEach(cleanup);
const raw = { ...photoFixture, file_name: "solo.DNG", companions: [], photo: { ...photoFixture.photo!, raw_container: "dng", preview_source: "embedded", preview_small: true, preview_width: 640, preview_height: 480, embedded_preview_width: 640, embedded_preview_height: 480 } } as ClipListItem;
it("PH10 standalone RAW card shows RAW and small preview notice", () => {
  render(<PoolCard clip={raw} columnIndex={1} selected={false} isAnchor={false} inMultiSelection={false} onSelect={vi.fn()} />);
  expect(screen.getByText("RAW")).toBeTruthy();
  expect(screen.getByText("RAW 预览较小")).toBeTruthy();
});
it("PH10 inspector shows container, preview source and embedded dimensions", () => {
  render(<PhotoInspector clip={raw} />);
  expect(screen.getByText("DNG · RAW")).toBeTruthy();
  expect(screen.getByText(/内嵌预览.*640×480/)).toBeTruthy();
  expect(screen.getByText("RAW 预览较小")).toBeTruthy();
});
it("PH10 ordinary JPG does not show standalone RAW information", () => {
  render(<PhotoInspector clip={photoFixture} />);
  expect(screen.queryByText("RAW 预览较小")).toBeNull();
  expect(screen.queryByText(/· RAW/)).toBeNull();
});
