// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ApiModule from "./api";
import type { GenerationDraftPreview, GenerationRequestSummary, StoryGap } from "./api";

const apiMocks = vi.hoisted(() => ({
  previewGeneration: vi.fn(),
  submitGeneration: vi.fn(),
}));
// P3 的新场景需要真的挂 useGlobalHotkeys/WorkspaceStore(它们从 "./api" 引入
// setSetting 等其它导出),所以这里改成保留原模块、只替换用到的两个函数——
// 不能像之前那样把整个 "./api" 换成只有 previewGeneration/submitGeneration
// 的对象,否则 WorkspaceStore 模块顶层的 createUiSettingWriter() 一读到
// 不存在的 setSetting 就直接抛错。
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  previewGeneration: apiMocks.previewGeneration,
  submitGeneration: apiMocks.submitGeneration,
}));

import { GenerationDialog } from "./GenerationDialog";
import { __resetModalStackForTests } from "./workspace/modalStack";
import { useGlobalHotkeys } from "./workspace/useGlobalHotkeys";
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./workspace/WorkspaceStore";

function gap(overrides: Partial<StoryGap> = {}): StoryGap {
  return {
    id: 1,
    chapter_id: 1,
    chapter_title: "第1章",
    beat_id: null,
    slot: "establishing",
    slot_label_zh: "建立镜头",
    reason: "该章缺一个建立镜头",
    status: "open",
    latest_request: null,
    ...overrides,
  };
}

function preview(overrides: Partial<GenerationDraftPreview> = {}): GenerationDraftPreview {
  return {
    mode: "t2v",
    model: "MiniMax-H3-Max",
    resolution: "768P",
    duration_s: 6,
    ratio: "16:9",
    prompt: "航拍缓推：海边，黄昏，自然光，写实纪录片质感，无人物，无文字，无字幕",
    refs: [{ path: "/tmp/a.jpg", role: "first_frame", preview_url: "file:///tmp/a.jpg" }],
    estimated_cost_usd: 0.3,
    notes: [],
    ...overrides,
  };
}

function requestSummary(overrides: Partial<GenerationRequestSummary> = {}): GenerationRequestSummary {
  return {
    id: 42,
    status: "submitted",
    error: null,
    estimated_cost_usd: 0.3,
    actual_cost_usd: null,
    result_clip_id: null,
    ...overrides,
  };
}

describe("GenerationDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onClose = vi.fn();
  const onSubmitted = vi.fn();

  beforeEach(() => {
    apiMocks.previewGeneration.mockResolvedValue(preview());
    apiMocks.submitGeneration.mockResolvedValue(requestSummary());
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function mount(props: Partial<Parameters<typeof GenerationDialog>[0]> = {}) {
    await act(async () => {
      root.render(
        <GenerationDialog
          gap={gap()}
          readOnly={false}
          availability={{ enabled: true, has_key: true, budget_remaining_usd: 12 }}
          onClose={onClose}
          onSubmitted={onSubmitted}
          {...props}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("loads the preview on open and shows the estimated cost", async () => {
    await mount();
    expect(apiMocks.previewGeneration).toHaveBeenCalledWith(1, {});
    expect(container.textContent).toContain("约 $0.30");
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.value).toContain("航拍缓推");
  });

  it("edits the prompt and re-previews after a debounce, updating the char counter", async () => {
    vi.useFakeTimers();
    try {
      await mount();
      const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
      apiMocks.previewGeneration.mockResolvedValue(preview({ estimated_cost_usd: 0.42 }));
      const setTextareaValue = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      await act(async () => {
        setTextareaValue.call(textarea, "新提示词");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(container.querySelector(".generation-prompt-count")?.textContent).toBe("4 / 7000");
      await act(async () => {
        vi.advanceTimersByTime(400);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiMocks.previewGeneration).toHaveBeenLastCalledWith(1, {
        prompt: "新提示词",
        model: "MiniMax-H3-Max",
        resolution: "768P",
        duration_s: 6,
      });
      expect(container.textContent).toContain("约 $0.42");
    } finally {
      vi.useRealTimers();
    }
  });

  it("debounces rapid duration changes into a single re-preview", async () => {
    vi.useFakeTimers();
    try {
      await mount();
      apiMocks.previewGeneration.mockClear();
      apiMocks.previewGeneration.mockResolvedValue(preview({ duration_s: 9, estimated_cost_usd: 0.5 }));
      const rangeInput = container.querySelector('input[type="range"]') as HTMLInputElement;
      const setRangeValue = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      await act(async () => {
        setRangeValue.call(rangeInput, "7");
        rangeInput.dispatchEvent(new Event("input", { bubbles: true }));
        setRangeValue.call(rangeInput, "8");
        rangeInput.dispatchEvent(new Event("input", { bubbles: true }));
        setRangeValue.call(rangeInput, "9");
        rangeInput.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(apiMocks.previewGeneration).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(400);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiMocks.previewGeneration).toHaveBeenCalledTimes(1);
      expect(apiMocks.previewGeneration).toHaveBeenLastCalledWith(1, {
        prompt: preview().prompt,
        model: "MiniMax-H3-Max",
        resolution: "768P",
        duration_s: 9,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("labels the dialog via aria-labelledby pointing at the visible heading", async () => {
    await mount();
    const dialog = container.querySelector('[role="dialog"]') as HTMLDivElement;
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    const heading = container.querySelector(`#${labelledBy}`);
    expect(heading?.tagName).toBe("H2");
    expect(heading?.textContent).toContain("生成候选");
  });

  it("disallows submitting a prompt over the 7000 character limit", async () => {
    await mount();
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const setTextareaValue = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setTextareaValue.call(textarea, "字".repeat(7001));
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submitButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.startsWith("提交"),
    ) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
    expect(container.textContent).toContain("提示词超过 7000 字符上限");
  });

  it("submits with the edited overrides and calls onSubmitted", async () => {
    await mount();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const setTextareaValue = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setTextareaValue.call(textarea, "编辑后的提示词");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const setSelectValue = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value",
    )!.set!;
    const [modelSelect, resolutionSelect] = Array.from(
      container.querySelectorAll("select"),
    ) as HTMLSelectElement[];
    await act(async () => {
      setSelectValue.call(modelSelect, "MiniMax-H3");
      modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      setSelectValue.call(resolutionSelect, "2K");
      resolutionSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const rangeInput = container.querySelector('input[type="range"]') as HTMLInputElement;
    const setRangeValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setRangeValue.call(rangeInput, "8");
      rangeInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const submitButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.startsWith("提交"),
    ) as HTMLButtonElement;
    await act(async () => {
      submitButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(apiMocks.submitGeneration).toHaveBeenCalledTimes(1);
    expect(apiMocks.submitGeneration).toHaveBeenCalledWith(1, {
      prompt: "编辑后的提示词",
      model: "MiniMax-H3",
      resolution: "2K",
      duration_s: 8,
    });
    expect(onSubmitted).toHaveBeenCalledWith(1, requestSummary());
    expect(onClose).toHaveBeenCalled();
  });

  it("disables submit with a Chinese hint when cloud generation is unavailable", async () => {
    await mount({ availability: { enabled: false, has_key: false, budget_remaining_usd: 0 } });
    const submitButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.startsWith("提交"),
    ) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
    expect(container.textContent).toContain("先在设置页启用云端补镜");
  });

  it("disables every control for a read-only historical episode", async () => {
    await mount({ readOnly: true });
    expect(container.textContent).toContain("历史集为只读档案");
    const submitButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.startsWith("提交"),
    ) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
  });
});

describe("P3: GenerationDialog 挂上模态栈,壳的全局 Esc 不再越权", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onSubmitted = vi.fn();

  function Harness(props: { onClose: () => void }) {
    // 真正的全局键位钩子——不是自己重写一份判定逻辑,而是复用壳实际挂载的
    // 那一个,这样测的是「对话框注册进模态栈之后,壳的既有逻辑是否让开」。
    useGlobalHotkeys();
    return (
      <GenerationDialog
        gap={gap()}
        readOnly={false}
        availability={{ enabled: true, has_key: true, budget_remaining_usd: 12 }}
        onClose={props.onClose}
        onSubmitted={onSubmitted}
      />
    );
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    apiMocks.previewGeneration.mockResolvedValue(preview());
    apiMocks.submitGeneration.mockResolvedValue(requestSummary());
    __resetModalStackForTests();
    __resetWorkspaceForTests({ immersive: true, query: "湖" });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    __resetModalStackForTests();
    __resetWorkspaceForTests();
    vi.clearAllMocks();
  });

  it("Esc 只关生成对话框,沉浸模式和搜索词原封不动", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<Harness onClose={onClose} />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(getWorkspaceSnapshot().immersive).toBe(true);
    expect(getWorkspaceSnapshot().query).toBe("湖");
  });
});
