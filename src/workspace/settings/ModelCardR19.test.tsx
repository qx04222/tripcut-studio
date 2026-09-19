// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("../testApiMock");
  return createTestApiMock({});
});
vi.mock("../../api", () => apiMocks);

import { MODEL_PROGRESS_EVENT, type ModelCard as ModelCardData } from "../../api";
import { EMPTY_GUIDE_SIGNALS, __resetGuidesForTests, getGuideSnapshot, hydrateGuides, reportGuideSignals } from "../guides";
import { INSTALL_MODELS_EVENT, __resetModelsForTests, applyProgress, getModelsSnapshot, loadModels, startModelsHost, useModels } from "../modelStore";
import { ModelStatusPhrase, modelDownloadLabel } from "../ModelStatusPhrase";
import { ModelCard, formatModelSize } from "./ModelCard";

const CLIP: ModelCardData = {
  id: "chinese-clip-vit-b-16",
  title: "画面理解模型",
  purpose: "看懂画面里有什么。",
  size_bytes: 753_290_873,
  installed: false,
  location: null,
  allowed: true,
  blocked_reason: null,
  recommended: true,
  phase: "idle",
  downloaded: 0,
  total: 753_290_873,
  error: null,
  fetched_on: "2026-09-18",
};
const WHISPER: ModelCardData = {
  ...CLIP,
  id: "whisper-large-v3-turbo",
  title: "转写模型(默认质量)",
  purpose: "把说话内容转成文字。",
  size_bytes: 1_624_555_275,
  total: 1_624_555_275,
  recommended: false,
};

/** 卡片跟 store 走:这样进度事件改的是同一张卡。 */
function StoreCard({ id }: { id: string }) {
  const { cards } = useModels();
  const card = cards.find((item) => item.id === id);
  return card ? <ModelCard card={card} /> : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetModelsForTests();
  __resetGuidesForTests();
  apiMocks.listModels.mockResolvedValue([CLIP, WHISPER]);
  apiMocks.startModelDownload.mockResolvedValue(undefined);
  apiMocks.cancelModelDownload.mockResolvedValue(undefined);
  apiMocks.bridgeModelProgressEvents.mockResolvedValue(() => undefined);
  apiMocks.getSettings.mockResolvedValue({});
});
afterEach(cleanup);

describe("R19 P-06 模型卡三态", () => {
  it("未安装:标题、用途一句、「未安装(≈753 MB)」与「安装 <标题>」按钮;推荐的带「推荐」", () => {
    render(<ModelCard card={CLIP} />);
    const card = screen.getByRole("group", { name: "画面理解模型" });
    expect(card.getAttribute("data-model-state")).toBe("idle");
    expect(within(card).getByText("看懂画面里有什么。")).toBeTruthy();
    expect(formatModelSize(CLIP.size_bytes)).toBe("≈753 MB");
    expect(formatModelSize(1_624_555_275)).toBe("≈1.6 GB");
    expect(within(card).getByText("未安装(≈753 MB)")).toBeTruthy();
    expect(within(card).getByText("推荐")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "安装 画面理解模型" })).toBeTruthy();
    expect(within(card).queryByRole("button", { name: /取消/ })).toBeNull();
    // 旧文案一个都不留。
    expect(card.textContent).not.toContain("组件尚未提供");
    expect(card.textContent).not.toContain("不提供在线下载");
  });

  it("下载中:「下载中 42%」+ 进度条 + 「取消下载 <标题>」;点取消调 cancelModelDownload", async () => {
    await act(async () => {
      await loadModels();
    });
    render(<StoreCard id={CLIP.id} />);
    act(() => applyProgress({ phase: "downloading", model_id: CLIP.id, file: "pytorch_model.bin", downloaded: Math.round(CLIP.total * 0.42), total: CLIP.total }));
    const card = screen.getByRole("group", { name: "画面理解模型" });
    expect(card.getAttribute("data-model-state")).toBe("downloading");
    expect(within(card).getByText("下载中 42%")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: /^安装/ })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "取消下载 画面理解模型" }));
    expect(apiMocks.cancelModelDownload).toHaveBeenCalledWith(CLIP.id);
    act(() => applyProgress({ phase: "cancelled", model_id: CLIP.id }));
    expect(card.getAttribute("data-model-state")).toBe("idle");
    expect(within(card).getByRole("button", { name: "安装 画面理解模型" })).toBeTruthy();
  });

  it("已安装:「已安装」+ 位置,没有安装 / 取消按钮", () => {
    render(<ModelCard card={{ ...CLIP, installed: true, phase: "installed", location: "/Users/x/Library/Application Support/TripCutStudio/models/chinese-clip-vit-b-16" }} />);
    const card = screen.getByRole("group", { name: "画面理解模型" });
    expect(card.getAttribute("data-model-state")).toBe("installed");
    expect(within(card).getByText("已安装")).toBeTruthy();
    expect(within(card).getByText(/models\/chinese-clip-vit-b-16$/)).toBeTruthy();
    expect(within(card).queryByRole("button")).toBeNull();
  });

  it("「安装」= startModelDownload 并立刻进入下载中;后端 reject 时卡上显示原因与「重试」", async () => {
    await act(async () => {
      await loadModels();
    });
    render(<StoreCard id={CLIP.id} />);
    fireEvent.click(screen.getByRole("button", { name: "安装 画面理解模型" }));
    expect(apiMocks.startModelDownload).toHaveBeenCalledWith(CLIP.id);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("group", { name: "画面理解模型" }).getAttribute("data-model-state")).toBe("downloading");
    act(() => applyProgress({ phase: "error", model_id: CLIP.id, message: "pytorch_model.bin 的 SHA-256 校验失败,已丢弃,不会启用" }));
    const card = screen.getByRole("group", { name: "画面理解模型" });
    expect(card.getAttribute("data-model-state")).toBe("error");
    expect(within(card).getByRole("alert").textContent).toContain("SHA-256");
    fireEvent.click(within(card).getByRole("button", { name: "重试下载 画面理解模型" }));
    expect(apiMocks.startModelDownload).toHaveBeenCalledTimes(2);
  });

  it("内存档不够:不给「安装」,显示原因", () => {
    render(<ModelCard card={{ ...CLIP, allowed: false, recommended: false, blocked_reason: "这台机器内存不够跑它(需要 16 GB 及以上)" }} />);
    const button = screen.getByRole("button", { name: "安装 画面理解模型" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/需要 16 GB 及以上/)).toBeTruthy();
  });
});

describe("R19 P-06 状态条一句 + 首启气泡同一入口", () => {
  it("状态条只在下载中出一句「正在下载画面理解模型 42%」;装完后消失并重读清单", async () => {
    render(<ModelStatusPhrase />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/正在下载/)).toBeNull();
    act(() => {
      window.dispatchEvent(new CustomEvent(MODEL_PROGRESS_EVENT, { detail: { phase: "downloading", model_id: CLIP.id, file: "pytorch_model.bin", downloaded: Math.round(CLIP.total * 0.42), total: CLIP.total } }));
    });
    expect(screen.getByText(modelDownloadLabel("画面理解模型", 42, 100))).toBeTruthy();
    apiMocks.listModels.mockResolvedValue([{ ...CLIP, installed: true, phase: "installed", location: "/m" }, WHISPER]);
    await act(async () => {
      window.dispatchEvent(new CustomEvent(MODEL_PROGRESS_EVENT, { detail: { phase: "installed", model_id: CLIP.id, dir: "/m" } }));
      await Promise.resolve();
    });
    expect(screen.queryByText(/正在下载/)).toBeNull();
    expect(apiMocks.listModels).toHaveBeenCalledTimes(2);
  });

  it("首启气泡:清单里有推荐且未装的 → models 气泡可出;「安装」事件把推荐的全排上;装完 / 下载中不再提", async () => {
    // nav / notify 当已看过(它们排在前面);其余气泡的条件都不满足,轮到 models。
    apiMocks.getSettings.mockResolvedValue({ "guide.nav.viewed": "true", "guide.notify.viewed": "true" });
    const stop = startModelsHost();
    await act(async () => {
      await hydrateGuides();
      await Promise.resolve();
    });
    reportGuideSignals({ ...EMPTY_GUIDE_SIGNALS, inWorkspace: true });
    await waitFor(() => expect(getGuideSnapshot().active).toBe("models"));
    expect(getModelsSnapshot().cards.filter((card) => card.recommended && !card.installed).map((card) => card.id)).toEqual([CLIP.id]);
    await act(async () => {
      window.dispatchEvent(new CustomEvent(INSTALL_MODELS_EVENT));
      await Promise.resolve();
    });
    // 只排推荐的那一个(转写默认档已在清单里标为不推荐),与设置页「安装」同一条命令。
    expect(apiMocks.startModelDownload).toHaveBeenCalledTimes(1);
    expect(apiMocks.startModelDownload).toHaveBeenCalledWith(CLIP.id);
    expect(getGuideSnapshot().active).not.toBe("models");
    stop();
  });

  it("≤ 8 GB 档:清单只推荐转写低内存档,画面理解不允许 → 「安装」只排转写模型", async () => {
    apiMocks.listModels.mockResolvedValue([
      { ...CLIP, allowed: false, recommended: false, blocked_reason: "内存不够" },
      { ...WHISPER, id: "whisper-small", title: "转写模型(低内存)", recommended: true },
    ]);
    const stop = startModelsHost();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent(INSTALL_MODELS_EVENT));
      await Promise.resolve();
    });
    expect(apiMocks.startModelDownload).toHaveBeenCalledTimes(1);
    expect(apiMocks.startModelDownload).toHaveBeenCalledWith("whisper-small");
    stop();
  });
});
