import { beforeEach, expect, it } from "vitest";
import { __resetUndoForTests, peekUndo, pushUndo, runUndo } from "../undoStack";
beforeEach(__resetUndoForTests);
it("keeps a failed undo retryable and preserves preceding operations", async () => {
  pushUndo({ label: "移动 3 段", undo: async () => undefined });
  let first = true;
  pushUndo({ label: "修剪 1 段", undo: async () => { if (first) { first = false; throw new Error("temporary"); } } });
  await expect(runUndo()).rejects.toThrow("temporary");
  expect(peekUndo()?.label).toBe("修剪 1 段");
  expect((await runUndo())?.label).toBe("修剪 1 段");
  expect((await runUndo())?.label).toBe("移动 3 段");
});
