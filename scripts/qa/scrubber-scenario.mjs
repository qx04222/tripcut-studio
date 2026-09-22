/** R22: same mock page and screenshot/evidence path as the existing preview suite. */
export async function scrubberScenario(page, shot) {
  const track = page.getByRole("slider", { name: "播放位置" });
  const scope = page.getByRole("button", { name: "切换进度条范围" });
  if ((await scope.textContent()) === "全片" && await scope.isEnabled()) await scope.click();
  await shot(page, "r22-scrubber-segment", { settle: 200 });
  const box = await track.boundingBox();
  if (!box || box.width < 100 || box.height < 40) throw new Error(`R22 scrubber has no usable track: ${JSON.stringify(box)}`);
  await page.mouse.move(box.x + box.width * 0.6, box.y + 35);
  await page.getByRole("tooltip").waitFor({ state: "visible" });
  await shot(page, "r22-scrubber-hover", { settle: 200 });
  const handle = page.getByRole("slider", { name: "入点", exact: true });
  const h = await handle.boundingBox();
  if (!h) throw new Error("R22 in handle missing");
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 20, h.y + h.height / 2, { steps: 8 });
  await shot(page, "r22-scrubber-drag-in", { settle: 200 });
  await page.mouse.up();
  await page.mouse.move(2, 2);
}
