import { getCurrentEpisode, setSetting } from "../api";

export interface PhotoOrderQueue {
  save(key: string, order: readonly number[]): Promise<void>;
  flush(key: string): Promise<void>;
  reset(): void;
}

export const PHOTO_ORDER_SAVE_ERROR = "照片顺序未保存，已停止交付。请重新调整顺序后再试。";
export const PHOTO_ORDER_EPISODE_CHANGED_ERROR = "等待照片顺序保存时已切换集，已停止交付。请在当前集重新交付。";
export function photoOrderKey(episodeId: number | null): string {
  return `ui.photo.order.${episodeId ?? "current"}`;
}

export function createPhotoOrderQueue(write: (key: string, value: string) => Promise<void>): PhotoOrderQueue {
  const tails = new Map<string, Promise<void>>();
  const failures = new Map<string, unknown>();
  return {
    save(key, order) {
      const previous = tails.get(key) ?? Promise.resolve();
      const task = previous.catch(() => undefined).then(() => write(key, JSON.stringify(order))).then(
        () => { failures.delete(key); },
        (failure: unknown) => {
          failures.set(key, failure);
          throw failure;
        },
      );
      tails.set(key, task);
      const cleanup = () => { if (tails.get(key) === task) tails.delete(key); };
      void task.then(cleanup, cleanup);
      return task;
    },
    async flush(key) {
      while (tails.has(key)) await Promise.allSettled([tails.get(key)!]);
      if (failures.has(key)) throw new Error(PHOTO_ORDER_SAVE_ERROR);
    },
    reset() {
      tails.clear();
      failures.clear();
    },
  };
}

const photoOrderPersistence = createPhotoOrderQueue(setSetting);

export function savePhotoOrder(key: string, order: readonly number[]): Promise<void> {
  return photoOrderPersistence.save(key, order);
}

export function flushPhotoOrderSaves(key: string): Promise<void> {
  return photoOrderPersistence.flush(key);
}

export async function ensureCurrentPhotoOrderSaved(): Promise<void> {
  const before = await getCurrentEpisode();
  await flushPhotoOrderSaves(photoOrderKey(before.id));
  const after = await getCurrentEpisode();
  if (after.id !== before.id) throw new Error(PHOTO_ORDER_EPISODE_CHANGED_ERROR);
}

export function __resetPhotoOrderPersistenceForTests(): void {
  photoOrderPersistence.reset();
}
