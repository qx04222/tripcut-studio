/** Real pointer/keyboard actions; shot() retains the repository's primary-button gate. */
export async function bandR22Shots(context, url, shot) {
  const scenarios = ["r22-band-rubber-selection", "r22-band-dragging", "r22-band-min-zoom", "r22-band-folded"];
  for (const name of scenarios) {
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      const band = page.getByRole("region", { name: "镜头带", exact: true });
      const grid = band.getByRole("grid", { name: "镜头序列" });
      const cells = grid.locator('[data-guide="shot"]');
      await cells.first().waitFor();
      await shot(page, name, {
        locate: () => grid,
        settle: 0,
        act: async () => {
          if (name === "r22-band-rubber-selection") {
            const bounds = await grid.boundingBox(), first = await cells.nth(0).boundingBox(), second = await cells.nth(1).boundingBox();
            if (!bounds || !first || !second) throw new Error("Band selection geometry is missing");
            await page.mouse.move(first.x - 5, bounds.y + bounds.height - 10);
            await page.mouse.down();
            await page.mouse.move(second.x + second.width - 2, first.y + first.height / 2, { steps: 12 });
            await grid.locator(".band-selection-box").waitFor();
            if (await grid.locator('[aria-selected="true"]').count() < 2) throw new Error("Rubber band did not select two cuts");
          } else if (name === "r22-band-dragging") {
            await cells.nth(0).click(); await cells.nth(1).click({ modifiers: ["Meta"] });
            const source = await cells.nth(0).boundingBox(), target = await cells.nth(3).boundingBox();
            if (!source || !target) throw new Error("Band drag geometry is missing");
            await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
            await page.mouse.down();
            await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 16 });
            await page.locator(".band-drag-ghost").waitFor();
          } else if (name === "r22-band-min-zoom") {
            for (let i = 0; i < 3; i += 1) await band.getByRole("button", { name: "缩小镜头带" }).click();
            await page.locator('.shot-band[data-zoom="0.35"]').waitFor();
            const rect = await cells.first().boundingBox();
            if (!rect || Math.abs(rect.width - 49) > 1) throw new Error(`Minimum card width is ${rect?.width}, expected 49`);
          } else {
            await band.getByRole("button", { name: "折叠第 1 章", exact: true }).click();
            await band.getByRole("button", { name: "展开第 1 章", exact: true }).waitFor();
          }
        },
      });
      await page.mouse.up();
    } finally { await page.close(); }
  }
}
