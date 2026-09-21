import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import * as fixture from "../devMock/fixture";

it("PH-03 preview: six additive photo fixtures include RAW companions and orientation 6", () => {
  const photos = fixture.PHOTO_CLIPS_R21;
  expect(photos).toHaveLength(6);
  expect(photos.every(clip => clip.kind === "photo" && clip.duration_ticks === 0 && !("fps" in clip) && clip.fps_num === null && clip.fps_den === null)).toBe(true);
  expect(photos.some(clip => clip.companions?.some(file => file.role === "raw"))).toBe(true);
  expect(photos.some(clip => clip.photo?.orientation === 6)).toBe(true);
  expect(photos.every(clip => clip.photo?.preview_url && clip.cover_url)).toBe(true);
});
it("PH-10 preview: one standalone RAW fixture outside the similar group carries the RAW badge inputs", () => {
  const raw = fixture.PHOTO_RAW_CLIP_R21;
  expect(fixture.PHOTO_CLIPS_R21.some(clip => clip.id === raw.id)).toBe(false);
  expect(raw.kind).toBe("photo");
  expect(/\.(arw|dng)$/i.test(raw.file_name)).toBe(true);
  expect(raw.companions).toEqual([]);
  expect(raw.photo?.raw_container).toBe("arw");
  expect(raw.photo?.preview_source).toBe("embedded");
  expect(raw.photo?.preview_small).toBe(true);
  expect(raw.photo?.preview_url && raw.cover_url).toBeTruthy();
  const scenario = readFileSync("scripts/qa/photo-scenario.mjs", "utf8");
  expect(scenario).toContain("44-photo-raw-card");
  expect(scenario).toContain("独立星野.ARW");
  expect(scenario).toContain("photo-r21-standalone-raw");
  expect(scenario).toContain("RAW 预览较小");
});
it("PH-03 preview: offline shots run the independent photo workspace and grouped grid scenarios", () => {
  const script = readFileSync("scripts/qa/preview-shots.mjs", "utf8");
  expect(script).toContain("await photoScenario(");
  const scenario = readFileSync("scripts/qa/photo-scenario.mjs", "utf8");
  expect(scenario).toContain("photos=1");
  expect(scenario).toContain("41-photo-ws");
  expect(scenario).toContain("42-photo-grid-groups");
  expect(scenario).toContain("展开相似组 6 张");
  expect(scenario).toContain("竖拍山景.HEIC");
  expect(scenario).toContain("疑似废片");
  expect(scenario).not.toMatch(/37-photo-mixed-pool|38-photo-monitor/);
  // 头部 @import 段(第一条规则之前),顺序 tokens-r19 → photo-r21 → 其它车道(接线约定)。
  const workspace = readFileSync("src/styles/workspace.css", "utf8");
  const photoImport = workspace.indexOf('@import "./workspace/photo-r21.css";');
  const tokensImport = workspace.indexOf('@import "./tokens-r19.css";');
  const firstRule = workspace.search(/^[^@/*\s][^{]*\{/m);
  expect(photoImport).toBeGreaterThan(tokensImport);
  expect(photoImport).toBeLessThan(firstRule);
  const workspaceCss = readFileSync("src/styles/workspace/photo-ws-r21.css", "utf8");
  expect(workspaceCss).toContain(".photo-workspace");
  const mediaCss = readFileSync("src/styles/workspace/photo-r21.css", "utf8");
  expect(mediaCss).toContain("object-fit: contain");
  expect(mediaCss).not.toMatch(/(?:font-size|border-radius|box-shadow|z-index):\s*\d/);
});
