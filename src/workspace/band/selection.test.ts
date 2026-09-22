import { expect, it } from "vitest";
import { selectBandKey, keysInBox } from "./selection";

it("ranges and toggles by segment key, including two cuts of the same clip", () => {
  const order = ["segment:1", "segment:2", "segment:3", "segment:4"];
  let state = selectBandKey({ keys: [], anchor: null }, order, order[0]!);
  state = selectBandKey(state, order, order[2]!, { shiftKey: true });
  expect(state.keys).toEqual(order.slice(0, 3));
  state = selectBandKey(state, order, order[1]!, { metaKey: true });
  expect(state.keys).toEqual([order[0], order[2]]);
  expect(state.anchor).toBe(order[1]);
});

it("rubber band intersects rectangles in either drag direction and excludes gaps", () => {
  expect(keysInBox({ x: 90, y: 80 }, { x: 10, y: 10 }, [
    { key: "segment:1", left: 0, top: 0, right: 20, bottom: 20 },
    { key: "segment:2", left: 70, top: 70, right: 110, bottom: 110 },
    { key: "segment:3", left: 120, top: 0, right: 150, bottom: 40 },
  ])).toEqual(["segment:1", "segment:2"]);
});
