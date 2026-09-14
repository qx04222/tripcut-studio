// @vitest-environment jsdom
import { act } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({ getSettings: vi.fn().mockResolvedValue({}), setSetting: vi.fn().mockResolvedValue(undefined) }));

import { ActionKbd } from "./KeymapKbd";
import { __resetKeymapForTests, notifyKeymap } from "./keymapStore";

beforeEach(() => __resetKeymapForTests());
afterEach(cleanup);

describe("R13 §1:ActionKbd 随键位表变化", () => {
  it("默认剪映预设下导出是 ⌘E;切到 Premiere 变 ⌘M;自定义覆盖后显示新键", () => {
    render(<p aria-label="键帽"><ActionKbd action="export" /></p>);
    expect(screen.getByLabelText("键帽").textContent).toBe("⌘E");
    act(() => notifyKeymap("premiere", ""));
    expect(screen.getByLabelText("键帽").textContent).toBe("⌘M");
    act(() => notifyKeymap("custom", JSON.stringify({ base: "jianying", overrides: { export: ["Mod+Shift+x"] } })));
    expect(screen.getByLabelText("键帽").textContent).toBe("⇧⌘X");
    act(() => notifyKeymap("custom", JSON.stringify({ base: "jianying", overrides: { export: [] } })));
    expect(screen.getByLabelText("键帽").textContent).toBe("");
  });
});
