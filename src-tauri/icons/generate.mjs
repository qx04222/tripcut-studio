/**
 * 应用图标发生器(R18 / V-06 / M-11)。自己画,不引任何素材。
 *
 *   node src-tauri/icons/generate.mjs      # 重写 icon.svg 与 icon-small.svg(无输出即成功)
 *
 * 再出位图与 icns(rsvg-convert 来自 librsvg,iconutil 是系统自带):
 *   cd src-tauri/icons
 *   for s in 128 256 512; do rsvg-convert -w $s -h $s icon.svg -o icon-$s.png; done
 *   rsvg-convert -w 1024 -h 1024 icon.svg -o icon.png
 *   mkdir -p /tmp/tc.iconset
 *   rsvg-convert -w 16 -h 16 icon-small.svg -o /tmp/tc.iconset/icon_16x16.png
 *   rsvg-convert -w 32 -h 32 icon-small.svg -o /tmp/tc.iconset/icon_16x16@2x.png
 *   cp /tmp/tc.iconset/icon_16x16@2x.png /tmp/tc.iconset/icon_32x32.png
 *   rsvg-convert -w 64  -h 64  icon.svg -o /tmp/tc.iconset/icon_32x32@2x.png
 *   rsvg-convert -w 128 -h 128 icon.svg -o /tmp/tc.iconset/icon_128x128.png
 *   rsvg-convert -w 256 -h 256 icon.svg -o /tmp/tc.iconset/icon_128x128@2x.png
 *   cp /tmp/tc.iconset/icon_128x128@2x.png /tmp/tc.iconset/icon_256x256.png
 *   rsvg-convert -w 512 -h 512 icon.svg -o /tmp/tc.iconset/icon_256x256@2x.png
 *   cp /tmp/tc.iconset/icon_256x256@2x.png /tmp/tc.iconset/icon_512x512.png
 *   rsvg-convert -w 1024 -h 1024 icon.svg -o /tmp/tc.iconset/icon_512x512@2x.png
 *   iconutil -c icns /tmp/tc.iconset -o icon.icns
 *
 * 验收:`swift scripts/qa/native-audit/icon-bounds.swift src-tauri/icons/icon.png` 必须「合格」
 * ——不透明包围盒 824×824 居中(Apple 的 macOS 图标网格)。旧图是 962×953、上下留白 40/31。
 *
 * 设计约束(V-06):macOS 连续曲率超椭圆(squircle,指数 5);内容严格在 824 网格内;
 * **不做镜面高光与内斜角**(那是 2008 年的 Aqua 语言);**只有一个隐喻**(一段胶片 ——
 * 旧图同时画了山景 + 胶片条 + 取景框角标,16px 下只剩一团绿)。
 * 16 / 32 用简化版(不旋转、3 组齿孔),这是 Apple 自己对小尺寸的做法。
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const S = 1024;
const C = S / 2;
const A = 412; // 824 / 2 —— Apple 网格
const N = 5; // 超椭圆指数,≈ macOS squircle
const INK = "#caf24f"; // 品牌强调色(深色主题的 --accent)
const GROUND_TOP = "#23281c";
const GROUND_BOTTOM = "#0e1009";

function squircle() {
  const pts = [];
  for (let d = 0; d < 360; d += 0.25) {
    const t = (d * Math.PI) / 180;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    pts.push([
      (C + Math.sign(ct) * Math.pow(Math.abs(ct), 2 / N) * A).toFixed(2),
      (C + Math.sign(st) * Math.pow(Math.abs(st), 2 / N) * A).toFixed(2),
    ]);
  }
  return "M" + pts.map((p, i) => (i ? "L" : "") + p[0] + " " + p[1]).join(" ") + "Z";
}

/** 一段胶片:圆角矩形 + 上下两排齿孔。 */
function strip({ W, H, R, cols, holeW, holeH, holeR, inset, rot, margin }) {
  const x0 = C - W / 2;
  const y0 = C - H / 2;
  const gap = (W - 2 * margin - cols * holeW) / (cols - 1);
  let holes = "";
  for (let i = 0; i < cols; i += 1) {
    const px = x0 + margin + i * (holeW + gap);
    holes += `<rect x="${px}" y="${y0 + inset}" width="${holeW}" height="${holeH}" rx="${holeR}"/>`;
    holes += `<rect x="${px}" y="${y0 + H - inset - holeH}" width="${holeW}" height="${holeH}" rx="${holeR}"/>`;
  }
  return `<g transform="rotate(${rot} ${C} ${C})">
    <rect x="${x0}" y="${y0}" width="${W}" height="${H}" rx="${R}" fill="${INK}"/>
    <g fill="${GROUND_BOTTOM}">${holes}</g>
  </g>`;
}

const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${GROUND_TOP}"/><stop offset="1" stop-color="${GROUND_BOTTOM}"/></linearGradient></defs>
  <path d="${squircle()}" fill="url(#g)"/>`;

writeFileSync(
  join(HERE, "icon.svg"),
  `${head}${strip({ W: 608, H: 372, R: 48, cols: 4, holeW: 76, holeH: 64, holeR: 20, inset: 34, rot: -12, margin: 46 })}</svg>`,
);
writeFileSync(
  join(HERE, "icon-small.svg"),
  `${head}${strip({ W: 556, H: 340, R: 48, cols: 3, holeW: 88, holeH: 74, holeR: 22, inset: 34, rot: 0, margin: 46 })}</svg>`,
);
