// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AnalysisSection } from "./AnalysisSection";
import { SettingsFormContext } from "./SettingsFormContext";
import type { SettingsForm } from "./useSettingsForm";
import { __setShowAllFeaturesForTests } from "../showAllFeatures";

const names = ["地平线端正", "局部曝光", "主体清晰"];
afterEach(cleanup);
function mount(all: boolean) {
  __setShowAllFeaturesForTests(all);
  const save = vi.fn();
  const form = { settings: { "moments.weights": '{"sharp":0.24,"interest":0.2}' }, llmLedger: [], save } as unknown as SettingsForm;
  render(<SettingsFormContext.Provider value={form}><AnalysisSection /></SettingsFormContext.Provider>);
  return save;
}
it("keeps calibration controls behind show-all", () => {
  mount(false);
  for (const name of names) expect(screen.queryByRole("slider", { name })).toBeNull();
});
it("defaults all three to zero and saves one weight without dropping others", () => {
  const save = mount(true);
  for (const name of names) expect((screen.getByRole("slider", { name }) as HTMLInputElement).value).toBe("0.00");
  const slider = screen.getByRole("slider", { name: names[0] });
  fireEvent.change(slider, { target: { value: "0.35" } });
  fireEvent.blur(slider);
  expect(save).toHaveBeenCalledWith("moments.weights", JSON.stringify({ sharp: 0.24, interest: 0.2, horizon_tilt_deg: 0.35 }));
  expect(screen.getAllByText(/标定后生效/)).toHaveLength(3);
});
