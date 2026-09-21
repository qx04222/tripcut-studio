import { expect, it, vi } from "vitest";
import { createPhotoOrderQueue } from "./photoOrderSettings";

it("每个集各自串行，切集不丢旧集已排队写入且两个 key 可并行", async () => {
  const calls: string[] = [];
  let releaseOne: () => void = () => undefined;
  const write = vi.fn(async (key: string, value: string) => {
    calls.push(`${key}:${value}`);
    if (value === "[1]") await new Promise<void>((resolve) => { releaseOne = resolve; });
  });
  const queue = createPhotoOrderQueue(write);
  const first = queue.save("ui.photo.order.1", [1]);
  const finalOne = queue.save("ui.photo.order.1", [2]);
  const other = queue.save("ui.photo.order.2", [9]);
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toEqual(["ui.photo.order.1:[1]", "ui.photo.order.2:[9]"]);
  releaseOne();
  await Promise.all([first, finalOne, other]);
  expect(calls).toEqual(["ui.photo.order.1:[1]", "ui.photo.order.2:[9]", "ui.photo.order.1:[2]"]);
});

it("交付屏障等待当前排队写入，失败会持续阻止交付直到同一 key 保存成功", async () => {
  let release: () => void = () => undefined;
  let fail = true;
  const write = vi.fn(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    if (fail) throw new Error("disk full");
  });
  const queue = createPhotoOrderQueue(write);
  const first = queue.save("ui.photo.order.1", [2, 1]);
  const barrier = queue.flush("ui.photo.order.1");
  let barrierSettled = false;
  void barrier.finally(() => { barrierSettled = true; }).catch(() => undefined);

  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  expect(barrierSettled).toBe(false);
  release();
  await expect(first).rejects.toThrow("disk full");
  await expect(barrier).rejects.toThrow("照片顺序未保存");
  await expect(queue.flush("ui.photo.order.1")).rejects.toThrow("照片顺序未保存");

  fail = false;
  const retry = queue.save("ui.photo.order.1", [2, 1]);
  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
  release();
  await retry;
  await expect(queue.flush("ui.photo.order.1")).resolves.toBeUndefined();
});

it("A 集失败不会阻断 B 集交付，各集屏障只检查自己的保存状态", async () => {
  const write = vi.fn(async (key: string) => {
    if (key === "ui.photo.order.1") throw new Error("A disk full");
  });
  const queue = createPhotoOrderQueue(write);
  await queue.save("ui.photo.order.1", [1]).catch(() => undefined);
  await queue.save("ui.photo.order.2", [2]);

  await expect(queue.flush("ui.photo.order.2")).resolves.toBeUndefined();
  await expect(queue.flush("ui.photo.order.1")).rejects.toThrow("照片顺序未保存");
});
