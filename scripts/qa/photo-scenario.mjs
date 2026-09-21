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
    // R21 PH-10(接线 W3):独立 ARW(无伴随 JPG)—— 卡片「RAW」角标 + 「RAW 预览较小」提示,
    // 点开后静态检视照常出图。PhotoInspector 的「格式 / 预览来源」两行只挂在视频工作台的检查器里
    // (照片工作台没有检查器,视频媒体池又只列 kind=video),截图剧本够不到,由 PhotoRawR21.test.tsx 盯。
    await shot(page, "44-photo-raw-card", {
      locate: p => p.getByRole("grid", { name: "照片网格" }).getByRole("gridcell").filter({ hasText: "独立星野.ARW" }),
      act: async (cell, p) => {
        await cell.waitFor();
        const card = cell.locator(".pool-card");
        if (!(await card.locator(".photo-r21-standalone-raw").filter({ hasText: /^RAW$/ }).count())) failures.push("44-photo-raw-card: 独立 ARW 缺「RAW」角标");
        if (await card.getByRole("img", { name: "照片", exact: true }).count()) failures.push("44-photo-raw-card: 独立 ARW 不该再挂「照片」角标");
        if (!(await card.locator(".photo-r21-small-preview").filter({ hasText: "RAW 预览较小" }).count())) failures.push("44-photo-raw-card: 缺「RAW 预览较小」提示");
        await card.click();
        const monitor = p.getByRole("region", { name: "照片静态检视" });
        const image = monitor.getByRole("img", { name: "照片预览 独立星野.ARW" });
        await image.waitFor();
        await image.evaluate(img => img.decode());
        if (!(await image.evaluate(img => img.naturalWidth > img.naturalHeight))) failures.push("44-photo-raw-card: 独立 ARW 预览不是横幅");
        if (/NaN|Infinity/.test(await p.locator("body").innerText())) failures.push("44-photo-raw-card: 出现非有限数值");
      },
      settle: 300,
    });
    // R21 照片线(业主拍板:照片不套视频那一套):照片工作台的导出抽屉只有「导出精选照片」——
    // 三张视频交付卡 / 模式 chip 不渲染,清单按张数,文案不含 剪映 / 镜头带 / 章节 / 交付。
    // R21 W3:照片工作台的 rail 是照片自己的三步,第 ③ 步「导出精选照片」;视频四步 rail 在这里不渲染。
    await shot(page, "45-photo-export-drawer", {
      locate: p => p.getByRole("button", { name: "第 3 步 导出精选照片", exact: true }),
      act: async (button, p) => {
        if (await p.getByRole("navigation", { name: "流水线", exact: true }).count()) failures.push("45-photo-export-drawer: 照片工作台仍渲染视频四步 rail");
        for (const name of ["第 3 步 排列", "第 4 步 导出"]) {
          if (await p.getByRole("button", { name, exact: true }).count()) failures.push(`45-photo-export-drawer: 照片工作台不该有「${name}」`);
        }
        await button.click();
        const dialog = p.getByRole("dialog").first();
        await dialog.waitFor();
        await dialog.getByRole("region", { name: "导出精选照片" }).waitFor();
        await dialog.getByRole("list", { name: "将导出的照片" }).waitFor();
        for (const name of ["交给剪映", "导出视频文件", "整包交付", "更多方式"]) {
          if (await dialog.getByRole("button", { name }).count()) failures.push(`45-photo-export-drawer: 照片工作台不该出现「${name}」`);
        }
        if (await dialog.getByRole("group", { name: "交付方式" }).count()) failures.push("45-photo-export-drawer: 三卡仍在渲染");
        if (!(await dialog.getByRole("button", { name: "导出精选照片到上次文件夹" }).count())) failures.push("45-photo-export-drawer: 缺主按钮「导出精选照片」");
        const text = await dialog.innerText();
        const hit = /剪映|镜头带|章节|交付|素材包|整包|粗剪|镜头表/.exec(text);
        if (hit) failures.push(`45-photo-export-drawer: 抽屉文案含视频词「${hit[0]}」`);
        if (!/\d+ 张照片/.test(text)) failures.push("45-photo-export-drawer: 清单没有按张数报");
      },
      settle: 500,
    });
    await page.keyboard.press("Escape");
  } finally {
    await page.close();
  }
}
