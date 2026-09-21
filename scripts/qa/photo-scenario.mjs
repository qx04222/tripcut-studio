/** R21 §0.5:独立照片工作台，只用离线假数据。 */
export async function photoScenario(context, viteUrl, shot, failures, withTheme) {
  const page = await context.newPage();
  try {
    await page.goto(withTheme(`${viteUrl}?photos=1`), { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "照片工作台" }).click();
    const workspace = page.getByRole("main", { name: "照片工作台" });
    await workspace.waitFor();
    await shot(page, "41-photo-ws", {
      locate: p => p.getByRole("main", { name: "照片工作台" }),
      act: async (_main, p) => {
        await p.getByRole("grid", { name: "照片网格" }).waitFor();
        await p.getByRole("region", { name: "照片静态检视" }).waitFor();
        await p.getByRole("region", { name: "照片精选带" }).waitFor();
        if (await p.getByRole("region", { name: "镜头带" }).count()) failures.push("41-photo-ws: 照片工作台仍挂着视频镜头带");
        if (await p.getByRole("region", { name: "媒体池" }).count()) failures.push("41-photo-ws: 照片工作台仍挂着视频媒体池");
      },
      settle: 500,
    });
    await shot(page, "42-photo-grid-groups", {
      locate: p => p.getByRole("button", { name: "展开相似组 6 张" }),
      act: async (expand, p) => {
        const grid = p.getByRole("grid", { name: "照片网格" });
        const group = grid.getByRole("rowgroup").first();
        await group.waitFor();
        if (!(await group.getByText("×6", { exact: true }).count())) failures.push("42-photo-grid-groups: 相似组没有折叠为 ×6");
        const collapsed = group.getByRole("gridcell");
        if ((await collapsed.count()) !== 1 || !/湖畔晨光\.JPG/.test(await collapsed.first().locator(".pool-card").getAttribute("aria-label") ?? "")) failures.push("42-photo-grid-groups: 折叠态不是主图第一");
        await expand.click();
        const cells = group.getByRole("gridcell");
        await cells.nth(5).waitFor();
        if ((await cells.count()) !== 6) failures.push("42-photo-grid-groups: 展开后不是 6 张");
        if (!/湖畔晨光\.JPG/.test(await cells.first().locator(".pool-card").getAttribute("aria-label") ?? "")) failures.push("42-photo-grid-groups: 展开后主图不在第一张");
        const junk = cells.filter({ hasText: "山路云海.JPG" });
        if (!(await junk.getByText("疑似废片", { exact: true }).count())) failures.push("42-photo-grid-groups: 山路云海缺疑似废片 chip");
        if (!/山路云海\.JPG/.test(await cells.last().locator(".pool-card").getAttribute("aria-label") ?? "")) failures.push("42-photo-grid-groups: 疑似废片没有排在组末");
        if (!(await group.getByRole("button", { name: "擂台", exact: true }).count())) failures.push("42-photo-grid-groups: 相似组缺擂台入口");
        if (!(await p.getByRole("region", { name: "照片精选带" }).count())) failures.push("42-photo-grid-groups: 缺精选带");
        await cells.filter({ hasText: "竖拍山景.HEIC" }).locator(".pool-card").click();
        const monitor = p.getByRole("region", { name: "照片静态检视" });
        const image = monitor.getByRole("img", { name: "照片预览 竖拍山景.HEIC" });
        await image.waitFor();
        await image.evaluate(img => img.decode());
        if (!(await image.evaluate(img => img.naturalHeight > img.naturalWidth))) failures.push("42-photo-grid-groups: 竖拍像素方向错误");
        for (const name of ["播放", "入点", "出点"]) if (await monitor.getByRole("button", { name, exact: true }).count()) failures.push(`42-photo-grid-groups: 照片检视器仍出现视频控件「${name}」`);
        if (await monitor.getByRole("slider").count()) failures.push("42-photo-grid-groups: 照片出现视频进度条");
        if (!(await monitor.getByText("照片检视", { exact: true }).count())) failures.push("42-photo-grid-groups: 缺照片专属检视标题");
        if ((await monitor.getByRole("button", { name: / 星$/ }).count()) !== 5) failures.push("42-photo-grid-groups: 缺照片星级工具");
        const zoom = monitor.getByRole("button", { name: "100%", exact: true });
        await zoom.click();
        if (await zoom.getAttribute("aria-pressed") !== "true") failures.push("42-photo-grid-groups: 100% 放大未生效");
        if (/NaN|Infinity/.test(await p.locator("body").innerText())) failures.push("42-photo-grid-groups: 出现非有限数值");
      },
      settle: 300,
    });
  } finally {
    await page.close();
  }
}
