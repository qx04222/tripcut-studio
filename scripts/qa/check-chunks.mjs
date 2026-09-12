#!/usr/bin/env node
// chunk 预算与懒加载核对(规格 §9)。跑在 `npm run build` 之后,读 dist/assets 的
// 实际产物 —— 不看构建日志,日志里那几行是人眼判断,改错了照样"看起来还行"。
//
// 判据两条:
//   1. 每个 .js chunk < 500 kB;
//   2. 首屏 index chunk **静态** import 的东西里不许出现 drawers / settings ——
//      这两块是 `React.lazy()` 的,只能以 dynamic import 出现。静态 import 一旦
//      出现,lazy() 就白写了(打开抽屉前它已经下载完了),而这件事在构建日志里
//      完全看不出来。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const assetsDir = join(repoRoot, "dist/assets");
const LIMIT_BYTES = 500 * 1024;
/** 必须只以 dynamic import 出现在首屏 chunk 里的懒加载块。 */
const LAZY_ONLY = ["drawers", "settings"];

const files = readdirSync(assetsDir).filter((name) => name.endsWith(".js"));
if (files.length === 0) {
  console.error("FAIL dist/assets 里一个 .js 都没有 —— 先跑 npm run build");
  process.exit(1);
}

let failed = false;

const oversized = files
  .map((name) => ({ name, size: statSync(join(assetsDir, name)).size }))
  .filter((entry) => entry.size > LIMIT_BYTES);
if (oversized.length > 0) {
  failed = true;
  for (const entry of oversized) {
    console.error(`FAIL chunk.budget ${entry.name} ${(entry.size / 1024).toFixed(1)} kB > 500 kB`);
  }
} else {
  const biggest = files
    .map((name) => ({ name, size: statSync(join(assetsDir, name)).size }))
    .sort((a, b) => b.size - a.size)[0];
  console.log(
    `PASS chunk.budget ${files.length} 个 chunk 全部 < 500 kB(最大 ${biggest.name} ${(biggest.size / 1024).toFixed(1)} kB)`,
  );
}

// 首屏图 = index 与它**静态**可达的那些 chunk。drawers / settings 只能从这张图里
// 以 dynamic import 出现;旧壳 LegacyShell 自己也是 lazy 的,它静态 import 这两块
// 是对的(旧四页本来就在里面),所以它不算在首屏图里。
const LEGACY_ONLY = /^LegacyShell-/;
const eager = files.filter((name) => !LEGACY_ONLY.test(name));
const sources = new Map(eager.map((name) => [name, readFileSync(join(assetsDir, name), "utf8")]));

for (const group of LAZY_ONLY) {
  const staticRef = new RegExp(`from\\s*["'\`]\\./(${group}-[\\w-]+\\.js)["'\`]`);
  const dynamicRef = new RegExp(`import\\(\\s*["'\`]\\./(${group}-[\\w-]+\\.js)["'\`]`);
  const offenders = [...sources].filter(([, source]) => staticRef.test(source)).map(([name]) => name);
  const loaders = [...sources].filter(([, source]) => dynamicRef.test(source)).map(([name]) => name);
  if (offenders.length > 0) {
    failed = true;
    console.error(`FAIL chunk.lazy ${group} 被 ${offenders.join(", ")} 静态 import —— lazy() 白写了`);
    continue;
  }
  if (loaders.length === 0) {
    failed = true;
    // 校准跑证实过这一条:把 `SettingsSheet` 从 lazy() 改成静态 import 后,
    // rolldown 直接把 settings 这组并进 workspace,产物里连 settings-*.js 都不存在
    // ——"找不到引用"的第一嫌疑因此是"这组根本没成块",不是正则漂了。
    const materialized = files.some((name) => name.startsWith(`${group}-`));
    console.error(
      materialized
        ? `FAIL chunk.lazy ${group} 有独立 chunk 却没人 dynamic import 它 —— 先怀疑本脚本的正则`
        : `FAIL chunk.lazy ${group} 没有独立 chunk —— 多半被某处静态 import,整组被并进了别的 chunk`,
    );
    continue;
  }
  console.log(`PASS chunk.lazy ${group} 只以 dynamic import 出现(由 ${loaders.join(", ")} 拉取)`);
}

process.exit(failed ? 1 : 0);
