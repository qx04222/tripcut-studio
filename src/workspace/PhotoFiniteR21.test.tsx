// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PoolCard } from "./PoolCard";
import { PhotoInspector } from "./PhotoInspector";
import { PhotoMonitor } from "./PhotoMonitor";
import { bandDurationLabel } from "./BandSegment";
import { monitorSpecLabel, IoRail } from "./MonitorParts";
import { MonitorHeatStrip } from "./MonitorHeatStrip";
import { poolDurationLabel } from "./poolModel";
import { photoFixture, videoFixture } from "./photoTestFixtures";
import { clipFps } from "./useMonitorTransport";

it("PH-03 zero duration/fps: rendered photo snapshot contains no NaN/Infinity or video timecode", () => {
  const markup = renderToStaticMarkup(<>
    <PoolCard clip={photoFixture} columnIndex={1} selected isAnchor inMultiSelection={false} onSelect={() => undefined} />
    <PhotoMonitor clip={photoFixture} clips={[photoFixture]} rootRef={{ current: null }} />
    <PhotoInspector clip={photoFixture} />
    <MonitorHeatStrip points={[{ at: 0, width: 1, score: 0.5 }]} ranges={[]} durationSeconds={0} position={0} activeIndex={-1} />
    <IoRail status={null} inPoint={0} outPoint={0} />
  </>);
  expect(markup).not.toMatch(/NaN|Infinity|当前时间码|播放位置|时刻热力/);
  expect({ text: markup.replace(/<[^>]*>/g, ""), spec: monitorSpecLabel(photoFixture), fpsFallback: clipFps(photoFixture) }).toMatchInlineSnapshot(`
    {
      "fpsFallback": 30,
      "spec": "照片 · 3024×4032",
      "text": "照片RAW3024×4032portrait.jpg08-12未评照片检视portrait.jpg1 / 1上一张下一张适屏100%200%400%保留 F拒绝 X1★2★3★4★5★3024×40322026-08-12T16:00:00+08:00Sony A7R III35mmsRGB0.0 MB1–5 星级 · ← → 换片 · Z 切换倍率 · 滚轮缩放 · 放大后拖动或 ⌥+方向键平移尺寸3024×4032拍摄时间2026-08-12T16:00:00+08:00机身Sony A7R III镜头35mmGPS25.7, 100.2",
    }
  `);
});
it("PH-03 finite guards: malformed timing cannot leak non-finite labels", () => {
  expect(bandDurationLabel(Number.NaN)).toBe("0:00");
  expect(poolDurationLabel({ ...videoFixture, duration_ticks: Infinity })).toBe("—");
  expect(clipFps({ ...photoFixture, fps_num: Infinity, fps_den: 1 })).toBe(30);
});
