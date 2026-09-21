/** R21:从照片工作台的相似组进入六张照片擂台。 */
export async function duelScenario(context, viteUrl, shot, failures, withTheme) {
  const page = await context.newPage();
  try {
    await page.goto(withTheme(`${viteUrl}?photos=1`), { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "照片工作台" }).click();
    await page.getByRole("main", { name: "照片工作台" }).waitFor();
    await shot(page, "43-photo-duel", {
      locate: p => p.getByRole("grid", { name: "照片网格" }).getByRole("button", { name: "擂台", exact: true }),
      act: async (entry, p) => {
        await entry.click();
        const arena = p.getByRole("region", { name: "擂台" });
        await arena.waitFor();
        await arena.getByText("第 1/5 场").waitFor();
        for (const name of ["左边更好", "右边更好", "两个都留", "撤销上一场", "退出擂台"]) {
          if (!(await arena.getByRole("button", { name, exact: true }).count())) failures.push(`43-photo-duel: 缺按钮「${name}」`);
        }
        if ((await arena.getByRole("img", { name: /对比照片/ }).count()) !== 2) failures.push("43-photo-duel: 不是左右两张静态预览");
        if (!(await arena.getByRole("list", { name: "本组照片 6 张" }).count())) failures.push("43-photo-duel: 缺六张成员缩略带");
        if ((await arena.getByText("EXIF", { exact: false }).count()) === 0 && (await arena.locator(".photo-duel-exif").count()) !== 2) failures.push("43-photo-duel: 缺双侧 EXIF 对比");
        const zoom = arena.getByRole("button", { name: "200%", exact: true });
        await zoom.click();
        if (await zoom.getAttribute("aria-pressed") !== "true") failures.push("43-photo-duel: 同步 200% 缩放未生效");
        if (await p.getByRole("region", { name: "照片静态检视" }).getByRole("img", { name: /照片预览/ }).count()) failures.push("43-photo-duel: 静态检视与擂台同时挂着");
      },
      settle: 400,
    });
    const arena = page.getByRole("region", { name: "擂台" });
    for (let round = 1; round <= 5; round += 1) {
      await arena.getByText(`第 ${round}/5 场`).waitFor();
      await arena.getByRole("button", { name: "右边更好", exact: true }).click();
    }
    await arena.getByText("本组已选好").waitFor();
    if (!(await arena.getByText("山路云海.JPG", { exact: true }).count())) failures.push("43-photo-duel: 五场完成后 winner 不对");
    await arena.getByRole("button", { name: "退出擂台", exact: true }).click();
    await arena.waitFor({ state: "hidden" });
    const grid = page.getByRole("grid", { name: "照片网格" });
    const first = grid.getByRole("gridcell").first();
    await first.waitFor();
    if (!/山路云海\.JPG/.test(await first.locator(".pool-card").getAttribute("aria-label") ?? "")) failures.push("43-photo-duel: winner 没回写成相似组主图");
    if (!(await page.getByRole("region", { name: "照片精选带" }).getByRole("button", { name: "检视照片 · 山路云海.JPG" }).count())) failures.push("43-photo-duel: winner 没刷新到精选带");
  } finally {
    await page.close();
  }
}
