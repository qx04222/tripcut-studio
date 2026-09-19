import { useSyncExternalStore } from "react";

import { bridgeModelProgressEvents, cancelModelDownload, listModels, startModelDownload, type ModelCard, type ModelProgressEvent } from "../api";
import { reportGuideSignals } from "./guides";

/** 与 `api.MODEL_PROGRESS_EVENT` 同值;这里写字面量是因为状态条挂在每个壳测试里,手抄的 api 替身不一定导出它。 */
const MODEL_PROGRESS_EVENT = "tripcut:model-download-progress";

/**
 * R19 P-06(models 车道):模型卡的状态层(与 updateStore 同一套 useSyncExternalStore 写法)。
 * 全应用一份:设置 › 工具与模型 的三张卡(`ModelCard`)、状态条的进度一句(`ModelStatusPhrase`)、
 * 首启气泡的「安装」都读写这一份——「同一入口」是真的同一入口。
 * 后端进度事件 → `applyProgress` 改对应那张卡的 phase / downloaded;终态(installed / error /
 * cancelled)后再 `loadModels()` 一次拿真实的 installed / location。
 */
export interface ModelsState {
  cards: ModelCard[];
  /** 已经从后端读过一次(读之前一张卡都不画,免得闪)。 */
  loaded: boolean;
}

let state: ModelsState = { cards: [], loaded: false };
const listeners = new Set<() => void>();

function set(next: ModelsState): void {
  state = next;
  for (const listener of listeners) listener();
  // 首启气泡的信号:有推荐且未装、允许装、也没在下载 → 该提一句「装画面理解」。
  reportGuideSignals({ modelInstallSuggested: next.loaded && next.cards.some(isSuggestable) });
}

export function isSuggestable(card: ModelCard): boolean {
  return card.recommended && card.allowed && !card.installed && card.phase !== "downloading";
}

export function getModelsSnapshot(): ModelsState {
  return state;
}

export function subscribeModels(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useModels(): ModelsState {
  return useSyncExternalStore(subscribeModels, getModelsSnapshot, getModelsSnapshot);
}

/** 从后端读一次清单;读失败保持原样(设置页会显示读不到)。 */
export async function loadModels(): Promise<ModelCard[]> {
  try {
    const cards = await listModels();
    // 旧后端 / 测试替身可能回 undefined:当作空清单,别让状态条因此炸掉。
    const next = Array.isArray(cards) ? cards : [];
    set({ cards: next, loaded: true });
    return next;
  } catch {
    return state.cards;
  }
}

function patchCard(id: string, patch: Partial<ModelCard>): void {
  if (!state.cards.some((card) => card.id === id)) return;
  set({ ...state, cards: state.cards.map((card) => (card.id === id ? { ...card, ...patch } : card)) });
}

/** 「安装」/「重试」:一个入口。后端 reject(只读窗口、内存档不够、已在下载)时把原因写到卡上。 */
export async function installModel(id: string): Promise<void> {
  const card = state.cards.find((item) => item.id === id);
  if (!card || card.phase === "downloading") return;
  patchCard(id, { phase: "downloading", downloaded: 0, error: null });
  try {
    await startModelDownload(id);
  } catch (error) {
    patchCard(id, { phase: "error", error: String(error) });
  }
}

/** 首启气泡的「安装」:把这一档推荐的模型全部排上(≥ 16 GB 是画面理解 + 转写默认档,≤ 8 GB 只有转写低内存档)。 */
export async function installRecommendedModels(): Promise<void> {
  for (const card of state.cards.filter(isSuggestable)) {
    await installModel(card.id);
  }
}

export async function cancelModel(id: string): Promise<void> {
  try {
    await cancelModelDownload(id);
  } catch {
    // 取消失败(后端不在了)也只能等它自己收尾;卡上的状态由下一条进度事件决定。
  }
}

/** 后端进度事件 → 卡片状态;终态后重读一次清单拿真实落地信息。 */
export function applyProgress(event: ModelProgressEvent): void {
  switch (event.phase) {
    case "downloading":
      patchCard(event.model_id, { phase: "downloading", downloaded: event.downloaded, total: event.total, error: null });
      return;
    case "verifying":
      return;
    case "installed":
      patchCard(event.model_id, { phase: "installed", installed: true, location: event.dir, downloaded: 0, error: null });
      void loadModels();
      return;
    case "cancelled":
      patchCard(event.model_id, { phase: "cancelled", downloaded: 0 });
      return;
    case "error":
      patchCard(event.model_id, { phase: "error", downloaded: 0, error: event.message });
      return;
  }
}

/** 首启气泡「安装」派发的事件名(GuideHost 只会 dispatch,不知道要做什么;这里接)。 */
export const INSTALL_MODELS_EVENT = "tripcut:install-models";

/**
 * 壳里挂一次(`ModelStatusPhrase` 的 effect 调):桥接 Tauri 事件、读一次清单、接首启气泡的「安装」。
 * 返回解除函数。
 */
export function startModelsHost(): () => void {
  const onProgress = (event: Event) => applyProgress((event as CustomEvent<ModelProgressEvent>).detail);
  const onInstall = () => void installRecommendedModels();
  window.addEventListener(MODEL_PROGRESS_EVENT, onProgress);
  window.addEventListener(INSTALL_MODELS_EVENT, onInstall);
  let unlisten: (() => void) | null = null;
  let active = true;
  // 桥接失败(非 Tauri 环境 / 手抄的 api 替身没有这条)不影响清单与卡片本身。
  try {
    void bridgeModelProgressEvents()
      .then((stop) => {
        if (active) unlisten = stop;
        else stop();
      })
      .catch(() => undefined);
  } catch {
    // 没有桥就没有进度事件;卡片仍可读清单、发起安装。
  }
  void loadModels();
  return () => {
    active = false;
    unlisten?.();
    window.removeEventListener(MODEL_PROGRESS_EVENT, onProgress);
    window.removeEventListener(INSTALL_MODELS_EVENT, onInstall);
  };
}

export function __resetModelsForTests(): void {
  state = { cards: [], loaded: false };
}
