// @vitest-environment jsdom
/**
 * R18 图标几何门禁(规范见 `docs/design/design-system.md`「图标规范」)。
 *
 * 判据取自**渲染后的 DOM**(不是 `SHAPES` 常量),所以「r<0.5 就偷偷改成填充」这类
 * 渲染期分支也在门禁范围内。四条断言:
 *  ① 四分格:所有在线坐标 ∈ `.25 / .75`(1.5 描边在 2x 下唯一能落设备像素的位置);
 *  ② 活动区:笔画中心线的外接框落在 [1.75, 14.25] 内,且长边 ≥ 8;
 *  ③ 点径:点只有一种 —— 填充圆 r=0.75;描边圆半径 ≥1.5 且为 0.5 的整数倍;
 *  ④ 内部间隙:任意两个子形状要么相交/相接(≤0.35),要么中心线距离 ≥2.0。
 *
 * 2026-09-14 首次对当时的 `icons.tsx` 跑这四条,红的计数记录在
 * `.superpowers/sdd/r18/lane-icons-report.md`(检测器先红的证据)。
 */
import { render, cleanup } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { DOT_RADIUS, ICON_NAMES, Icon, type IconName } from "./icons";

afterEach(cleanup);

const ACTIVE_MIN = 1.75;
const ACTIVE_MAX = 14.25;
const MIN_GAP = 2.0;
const TOUCHING = 0.35;

type Pt = { x: number; y: number };
/** 一个子形状:在线锚点(判四分格)+ 密集采样点(判间隙与外接框)。 */
type Geom = { anchors: Pt[]; samples: Pt[] };

const near = (v: number, t: number) => Math.abs(v - t) < 1e-6;
/** 坐标必须是 x.25 或 x.75 —— 即 v-0.25 是 0.5 的整数倍。 */
function onQuarterGrid(v: number): boolean {
  const k = (v - 0.25) / 0.5;
  return Math.abs(k - Math.round(k)) < 1e-6;
}

// ---------------------------------------------------------------- 路径解析
const NUM_AT = /^[\s,]*([+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?)/;
const FLAG_AT = /^[\s,]*([01])/;

/**
 * 弧的两个标志位是**单字符**,`a1.5 1.5 0 001.5 1.5` 里的 `001.5` 其实是
 * `0`(large)`0`(sweep)`1.5`(x)—— 用通用数字正则会读成一个 `001.5`,
 * 解析出来的终点是 NaN。所以这里按命令逐个读,弧的第 4/5 位按单字符读。
 */
function tokenize(d: string): { cmd: string; args: number[] }[] {
  const out: { cmd: string; args: number[] }[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) {
    const cmd = m[1];
    let rest = m[2];
    const args: number[] = [];
    const isArc = cmd === "A" || cmd === "a";
    let i = 0;
    for (;;) {
      const pat = isArc && (i % 7 === 3 || i % 7 === 4) ? FLAG_AT : NUM_AT;
      const hit = pat.exec(rest);
      if (!hit) break;
      args.push(Number(hit[1]));
      rest = rest.slice(hit[0].length);
      i += 1;
    }
    out.push({ cmd, args });
  }
  return out;
}

function sampleCubic(p0: Pt, c1: Pt, c2: Pt, p1: Pt, push: (p: Pt) => void): void {
  const n = 24;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    push({
      x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x,
      y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y,
    });
  }
}

/** SVG 弧 → 圆心参数化,再采样(端点参数化转换见 SVG 1.1 附录 F.6.5)。 */
function sampleArc(p0: Pt, rx: number, ry: number, rot: number, large: number, sweep: number, p1: Pt, push: (p: Pt) => void): void {
  if (rx === 0 || ry === 0 || (near(p0.x, p1.x) && near(p0.y, p1.y))) {
    push(p1);
    return;
  }
  const phi = (rot * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx = (p0.x - p1.x) / 2;
  const dy = (p0.y - p1.y) / 2;
  const x1 = cosP * dx + sinP * dy;
  const y1 = -sinP * dx + cosP * dy;
  let RX = Math.abs(rx);
  let RY = Math.abs(ry);
  const lambda = (x1 * x1) / (RX * RX) + (y1 * y1) / (RY * RY);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    RX *= s;
    RY *= s;
  }
  const sign = large === sweep ? -1 : 1;
  const num = RX * RX * RY * RY - RX * RX * y1 * y1 - RY * RY * x1 * x1;
  const den = RX * RX * y1 * y1 + RY * RY * x1 * x1;
  const co = sign * Math.sqrt(Math.max(0, num / den));
  const cx1 = (co * RX * y1) / RY;
  const cy1 = (-co * RY * x1) / RX;
  const cx = cosP * cx1 - sinP * cy1 + (p0.x + p1.x) / 2;
  const cy = sinP * cx1 + cosP * cy1 + (p0.y + p1.y) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    return ux * vy - uy * vx < 0 ? -a : a;
  };
  const theta = ang(1, 0, (x1 - cx1) / RX, (y1 - cy1) / RY);
  let delta = ang((x1 - cx1) / RX, (y1 - cy1) / RY, (-x1 - cx1) / RX, (-y1 - cy1) / RY);
  if (sweep === 0 && delta > 0) delta -= 2 * Math.PI;
  if (sweep === 1 && delta < 0) delta += 2 * Math.PI;
  const n = Math.max(8, Math.ceil((Math.abs(delta) / Math.PI) * 32));
  for (let i = 1; i <= n; i++) {
    const t = theta + (delta * i) / n;
    const ex = RX * Math.cos(t);
    const ey = RY * Math.sin(t);
    push({ x: cosP * ex - sinP * ey + cx, y: sinP * ex + cosP * ey + cy });
  }
}

function parsePath(d: string): Geom {
  const anchors: Pt[] = [];
  const samples: Pt[] = [];
  let cur: Pt = { x: 0, y: 0 };
  let start: Pt = { x: 0, y: 0 };
  let prevCubicC2: Pt | null = null;
  const line = (to: Pt): void => {
    const n = Math.max(2, Math.ceil(Math.hypot(to.x - cur.x, to.y - cur.y) / 0.15));
    for (let i = 1; i <= n; i++) samples.push({ x: cur.x + ((to.x - cur.x) * i) / n, y: cur.y + ((to.y - cur.y) * i) / n });
  };
  for (const { cmd, args } of tokenize(d)) {
    const rel = cmd === cmd.toLowerCase();
    const up = cmd.toUpperCase();
    const step = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }[up]!;
    const chunks: number[][] = step === 0 ? [[]] : [];
    for (let i = 0; i < args.length; i += step) chunks.push(args.slice(i, i + step));
    for (let ci = 0; ci < chunks.length; ci++) {
      const a = chunks[ci];
      const base = rel ? cur : { x: 0, y: 0 };
      let next: Pt = cur;
      if (up === "M") {
        next = { x: base.x + a[0], y: base.y + a[1] };
        if (ci === 0) {
          samples.push(next);
          start = next;
        } else line(next);
      } else if (up === "L") {
        next = { x: base.x + a[0], y: base.y + a[1] };
        line(next);
      } else if (up === "H") {
        next = { x: base.x + a[0], y: cur.y };
        line(next);
      } else if (up === "V") {
        next = { x: cur.x, y: base.y + a[0] };
        line(next);
      } else if (up === "C" || up === "S") {
        const c1 = up === "C" ? { x: base.x + a[0], y: base.y + a[1] } : prevCubicC2 ? { x: 2 * cur.x - prevCubicC2.x, y: 2 * cur.y - prevCubicC2.y } : cur;
        const c2 = up === "C" ? { x: base.x + a[2], y: base.y + a[3] } : { x: base.x + a[0], y: base.y + a[1] };
        next = up === "C" ? { x: base.x + a[4], y: base.y + a[5] } : { x: base.x + a[2], y: base.y + a[3] };
        sampleCubic(cur, c1, c2, next, (p) => samples.push(p));
        prevCubicC2 = c2;
      } else if (up === "Q" || up === "T") {
        const q = up === "Q" ? { x: base.x + a[0], y: base.y + a[1] } : cur;
        next = up === "Q" ? { x: base.x + a[2], y: base.y + a[3] } : { x: base.x + a[0], y: base.y + a[1] };
        sampleCubic(cur, { x: cur.x + (2 / 3) * (q.x - cur.x), y: cur.y + (2 / 3) * (q.y - cur.y) }, { x: next.x + (2 / 3) * (q.x - next.x), y: next.y + (2 / 3) * (q.y - next.y) }, next, (p) => samples.push(p));
      } else if (up === "A") {
        next = { x: base.x + a[5], y: base.y + a[6] };
        sampleArc(cur, a[0], a[1], a[2], a[3], a[4], next, (p) => samples.push(p));
      } else if (up === "Z") {
        next = start;
        line(next);
      }
      if (up !== "C" && up !== "S") prevCubicC2 = null;
      if (up !== "Z") anchors.push(next);
      cur = next;
    }
  }
  return { anchors, samples };
}

function circleGeom(cx: number, cy: number, r: number, isDot = false): Geom {
  const samples: Pt[] = [];
  // 点按**圆心**参与间隙计算(规范里的 ≥2.0 说的是中心线距离,点的中心线就是圆心);
  // 描边圆按轮廓采样。
  if (isDot) samples.push({ x: cx, y: cy });
  else {
    const n = 128;
    for (let i = 0; i < n; i++) {
      const t = (i / n) * 2 * Math.PI;
      samples.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
    }
  }
  // 描边圆判的是四个正交方向上的**笔画中心**;点(填充 r=0.75)判的是圆心
  // —— 点的边缘在 c±0.75,圆心落四分格时边缘正好落 .0/.5,2x 下是整设备像素。
  const anchors = isDot
    ? [{ x: cx, y: cy }]
    : [{ x: cx - r, y: cy }, { x: cx + r, y: cy }, { x: cx, y: cy - r }, { x: cx, y: cy + r }];
  return { anchors, samples };
}

type Piece = { kind: "path" | "fill" | "circle" | "dot"; label: string; geom: Geom; r?: number };

function piecesOf(name: IconName): Piece[] {
  const { container, unmount } = render(createElement(Icon, { name }));
  const svg = container.querySelector("svg")!;
  const out: Piece[] = [];
  svg.childNodes.forEach((node, i) => {
    const el = node as Element;
    const filled = el.getAttribute("fill") === "currentColor" && el.getAttribute("stroke") === "none";
    if (el.tagName.toLowerCase() === "circle") {
      const cx = Number(el.getAttribute("cx"));
      const cy = Number(el.getAttribute("cy"));
      const r = Number(el.getAttribute("r"));
      out.push({ kind: filled ? "dot" : "circle", label: `${name}#${i} circle`, geom: circleGeom(cx, cy, r, filled), r });
    } else {
      const d = el.getAttribute("d") ?? "";
      out.push({ kind: filled ? "fill" : "path", label: `${name}#${i} path`, geom: parsePath(d) });
    }
  });
  unmount();
  return out;
}

function minDistance(a: Geom, b: Geom): number {
  let best = Infinity;
  for (const p of a.samples) for (const q of b.samples) {
    const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

describe("图标几何门禁", () => {
  it("① 所有在线坐标落 .25 / .75 四分格", () => {
    const bad: string[] = [];
    for (const name of ICON_NAMES) {
      for (const piece of piecesOf(name)) {
        for (const p of piece.geom.anchors) {
          if (!onQuarterGrid(p.x)) bad.push(`${piece.label} x=${p.x}`);
          if (!onQuarterGrid(p.y)) bad.push(`${piece.label} y=${p.y}`);
        }
      }
    }
    expect(bad, `${bad.length} 个坐标不在四分格上:\n${bad.slice(0, 40).join("\n")}`).toEqual([]);
  });

  it("② 笔画中心线外接框落在 12.5 活动区内,长边 ≥ 8", () => {
    const bad: string[] = [];
    for (const name of ICON_NAMES) {
      const pts = piecesOf(name).flatMap((p) => p.geom.samples);
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
      const eps = 0.02;
      if (box.x0 < ACTIVE_MIN - eps || box.y0 < ACTIVE_MIN - eps || box.x1 > ACTIVE_MAX + eps || box.y1 > ACTIVE_MAX + eps) {
        bad.push(`${name} 越框 [${box.x0.toFixed(2)},${box.y0.toFixed(2)}]-[${box.x1.toFixed(2)},${box.y1.toFixed(2)}]`);
      } else if (Math.max(box.x1 - box.x0, box.y1 - box.y0) < 8) {
        bad.push(`${name} 太小 ${(box.x1 - box.x0).toFixed(2)}×${(box.y1 - box.y0).toFixed(2)}`);
      }
    }
    expect(bad, `${bad.length} 枚图标活动区不合格:\n${bad.join("\n")}`).toEqual([]);
  });

  it("③ 点只有一种:填充圆 r=0.75;描边圆半径 ≥1.5 且是 0.5 的整数倍", () => {
    const bad: string[] = [];
    for (const name of ICON_NAMES) {
      for (const piece of piecesOf(name)) {
        if (piece.kind === "dot" && !near(piece.r!, DOT_RADIUS)) bad.push(`${piece.label} 点径 ${piece.r} ≠ ${DOT_RADIUS}`);
        if (piece.kind === "circle") {
          if (piece.r! < 1.5) bad.push(`${piece.label} 描边圆 r=${piece.r} 太小(应该是点)`);
          else if (Math.abs(piece.r! * 2 - Math.round(piece.r! * 2)) > 1e-6) bad.push(`${piece.label} 描边圆 r=${piece.r} 不是 0.5 的整数倍`);
        }
      }
    }
    expect(bad, `${bad.length} 处点/圆不合规:\n${bad.join("\n")}`).toEqual([]);
  });

  it("④ 子形状之间要么相接,要么中心线距离 ≥ 2.0", () => {
    const bad: string[] = [];
    for (const name of ICON_NAMES) {
      const pieces = piecesOf(name);
      for (let i = 0; i < pieces.length; i++) {
        for (let j = i + 1; j < pieces.length; j++) {
          const d = minDistance(pieces[i].geom, pieces[j].geom);
          if (d > TOUCHING && d < MIN_GAP) bad.push(`${pieces[i].label} ↔ ${pieces[j].label} 间隙 ${d.toFixed(2)}`);
        }
      }
    }
    expect(bad, `${bad.length} 对形状间隙不合格:\n${bad.join("\n")}`).toEqual([]);
  });
});
