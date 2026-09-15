// @vitest-environment jsdom

/**
 * R18 AI-A1:检查器的「AI 描述」段在**没有云端描述**时要显示本地生成的那一句,
 * 并标出它是本地生成的 —— 不能让用户以为这是云端模型看过画面之后写的。
 * 反过来,云端描述一旦有了,显示的就是云端那句(本地那句退成兜底)。
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  getClipBrief: vi.fn(),
}));

vi.mock("../api", () => apiMocks);

import { AiDescriptionSection } from "./inspectorFields";

const BRIEF = "俯拍近景的食物,画面里的人在吃喝,手持拍摄,画面文字「城南面馆」。";

beforeEach(() => {
  apiMocks.getClipBrief.mockReset();
  apiMocks.getClipBrief.mockResolvedValue(BRIEF);
});

afterEach(cleanup);

function renderSection(overrides: Partial<Parameters<typeof AiDescriptionSection>[0]> = {}) {
  return render(
    <AiDescriptionSection
      aiDescription={null}
      llmEnabled={false}
      llmBudgetExhausted={false}
      aiBusy={false}
      onDescribe={() => {}}
      clipId={7}
      {...overrides}
    />,
  );
}

it("没有云端描述时显示本地那一句,并标「本地生成」", async () => {
  renderSection();
  expect(await screen.findByText(BRIEF)).toBeTruthy();
  expect(screen.getByText("本地生成")).toBeTruthy();
  expect(apiMocks.getClipBrief).toHaveBeenCalledWith(7);
});

it("云端描述有了就显示云端那句,不再显示本地那句", async () => {
  renderSection({
    aiDescription: {
      clip_id: 7,
      description: "云端写的一句话。",
      tags: ["甲", "乙", "丙"],
      provider: "codex",
    },
    llmEnabled: true,
  });
  expect(await screen.findByText("云端写的一句话。")).toBeTruthy();
  await waitFor(() => expect(screen.queryByText(BRIEF)).toBeNull());
});

it("本地描述取不到时不假装有东西,也不报错", async () => {
  apiMocks.getClipBrief.mockResolvedValue(null);
  renderSection();
  await waitFor(() => expect(apiMocks.getClipBrief).toHaveBeenCalled());
  expect(screen.queryByText("本地生成")).toBeNull();
});

it("没给 clipId 时根本不去取(旧壳调用点不受影响)", async () => {
  renderSection({ clipId: undefined });
  await waitFor(() => expect(apiMocks.getClipBrief).not.toHaveBeenCalled());
});
