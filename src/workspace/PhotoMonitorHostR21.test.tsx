// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { photoFixture, videoFixture } from "./photoTestFixtures";
import { __resetWorkspaceForTests } from "./WorkspaceStore";

const hostMocks = vi.hoisted(() => ({ feed: { clips: [] as unknown[] } }));
vi.mock("./useClipsFeed", () => ({ useClipsFeed: () => hostMocks.feed }));
import { PhotoMonitorHost } from "./PhotoMonitorHost";

afterEach(() => { cleanup(); __resetWorkspaceForTests(); });

it("mounts the selected photo directly without the video Monitor or Player shell", () => {
  hostMocks.feed.clips = [photoFixture, videoFixture];
  __resetWorkspaceForTests({ workspaceMode: "photo", selection: { kind: "clip", clipId: photoFixture.id! } });
  render(<PhotoMonitorHost />);
  expect(screen.getByRole("img", { name: /照片预览/ })).toBeTruthy();
  expect(document.querySelector(".player-overlay")).toBeNull();
  const source = readFileSync("src/workspace/PhotoWorkspace.tsx", "utf8");
  expect(source).toContain('import { PhotoMonitorHost } from "./PhotoMonitorHost"');
  expect(source).not.toContain('import { Monitor } from "./Monitor"');
});

it("renders no media when stale selection points at a video", () => {
  hostMocks.feed.clips = [photoFixture, videoFixture];
  __resetWorkspaceForTests({ workspaceMode: "photo", selection: { kind: "clip", clipId: videoFixture.id! } });
  render(<PhotoMonitorHost />);
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText("从照片网格选择一张照片")).toBeTruthy();
});
