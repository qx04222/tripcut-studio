// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = await vi.hoisted(async () => {
  const { createTestApiMock } = await import("./testApiMock");
  return createTestApiMock({});
});
vi.mock("../api", () => apiMock);

import { undoSkippedMovedSuffix } from "./copy";
import { takeStoryUndoSuffix, undoStoryChangeNoticing } from "./storyUndo";
import { __resetToastsForTests } from "./ui/toastStore";
import { __resetUndoForTests, runUndo } from "./undoStack";
import { pushStoryUndo } from "./useBandDrag";

beforeEach(() => {
  vi.clearAllMocks();
  __resetUndoForTests();
  __resetToastsForTests();
  apiMock.undoStoryChange.mockResolvedValue({ skipped_moved: 0 });
});

/** R17 epmove:后端撤销排片时跳过了「已移到别的集」的镜 —— 前端 toast 文案追加「(n 条已移到别的集,没有放回)」。 */
describe("R17 epmove:撤销排片跳过已移走的镜", () => {
  it("undoStoryChangeNoticing 回跳过数并把后缀留给下一条 toast;取一次就清空;跳过 0 条没有后缀", async () => {
    apiMock.undoStoryChange.mockResolvedValueOnce({ skipped_moved: 2 });
    expect(await undoStoryChangeNoticing()).toBe(2);
    expect(takeStoryUndoSuffix()).toBe(undoSkippedMovedSuffix(2));
    expect(undoSkippedMovedSuffix(2)).toBe("(2 条已移到别的集,没有放回)");
    expect(takeStoryUndoSuffix()).toBe("");
    expect(await undoStoryChangeNoticing()).toBe(0);
    expect(takeStoryUndoSuffix()).toBe("");
  });

  it("⌘Z 栈里的镜头带条目(pushStoryUndo)走同一条路:撤完后缀可取", async () => {
    apiMock.undoStoryChange.mockResolvedValueOnce({ skipped_moved: 1 });
    pushStoryUndo("调整顺序");
    await runUndo();
    expect(apiMock.undoStoryChange).toHaveBeenCalledTimes(1);
    expect(takeStoryUndoSuffix()).toBe("(1 条已移到别的集,没有放回)");
  });
});
