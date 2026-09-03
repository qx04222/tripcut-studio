import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LazyCover, VirtualClipList, formatDuration } from "./ImportPage";
import type { ClipListItem } from "./api";

function clip(index: number): ClipListItem {
  return {
    id: index,
    episode_id: 1,
    folder_label: null,
    cover_url: `http://127.0.0.1:4100/cache/${index}/cover.jpg?expires=9999999999&signature=test`,
    path: `/Volumes/CARD/DCIM/clip-${index}.mp4`,
    file_name: `clip-${index}.mp4`,
    byte_size: 1024,
    quick_hash: `quick-${index}`,
    full_hash: null,
    tb_num: 1,
    tb_den: 90_000,
    duration_ticks: 270_000,
    fps_num: 30_000,
    fps_den: 1_001,
    is_vfr: index === 1,
    codec: "h264",
    width: 1920,
    height: 1080,
    captured_at: "2026-08-31T12:34:56Z",
    status: "ready",
    error: null,
    analysis: null,
    analysis_status: "pending",
    analysis_error: null,
    motion: null,
    motion_status: null,
    motion_error: null,
    binary_rating: null,
    star_rating: null,
    select_count: 0,
  };
}

describe("import clip list", () => {
  it("rounds the total duration before splitting minutes and seconds", () => {
    expect(formatDuration({ ...clip(1), duration_ticks: 5_364_000 })).toBe("1:00");
  });

  it("does not attach the cover src before its viewport boundary is visible", () => {
    const markup = renderToStaticMarkup(
      <LazyCover src="http://127.0.0.1/cache/1/cover.jpg?expires=9999999999&signature=test" alt="clip cover" />,
    );

    expect(markup).toContain('data-cache-src="http://127.0.0.1/cache/1/cover.jpg?expires=9999999999&amp;signature=test"');
    expect(markup).not.toContain("<img");
    expect(markup).toContain("clip-cover skeleton");
  });

  it("renders only the virtual window for more than one thousand clips", () => {
    const clips = Array.from({ length: 1_200 }, (_, index) => clip(index));
    const markup = renderToStaticMarkup(<VirtualClipList clips={clips} viewportHeight={396} />);

    expect(markup).toContain('data-total-rows="1200"');
    expect(markup.match(/class="clip-row ready"/g)).toHaveLength(13);
    expect(markup).toContain("clip-0.mp4");
    expect(markup).not.toContain("clip-1199.mp4");
  });
});
