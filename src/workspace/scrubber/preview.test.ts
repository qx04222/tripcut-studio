import { expect, it, vi } from "vitest";
import { PreviewCache, PreviewScheduler } from "./preview";
it("LRU evicts least recently used of 200 frames and expires signed URLs", async () => {
  const load = vi.fn(async (_clip: number, time: number) => `url:${time}`);
  const cache = new PreviewCache(load, 200);
  for (let n = 0; n < 200; n++) await cache.get(1, n);
  await cache.get(1, 0);
  await cache.get(1, 200);
  await cache.get(1, 0);
  expect(load).toHaveBeenCalledTimes(201);
  await cache.get(1, 1);
  expect(load).toHaveBeenCalledTimes(202);
});
it("hover waits 150ms, coalesces moves and cancellation suppresses stale responses", async () => {
  vi.useFakeTimers();
  const load = vi.fn(async (_id: number, seconds: number) => String(seconds));
  const show = vi.fn();
  const scheduler = new PreviewScheduler(new PreviewCache(load), show);
  scheduler.request(1, 1); scheduler.request(1, 2);
  await vi.advanceTimersByTimeAsync(149); expect(load).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(load).toHaveBeenCalledExactlyOnceWith(1, 2);
  expect(show).toHaveBeenCalledWith(2, "2");
  scheduler.request(1, 3); scheduler.cancel();
  await vi.advanceTimersByTimeAsync(200); expect(load).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});
