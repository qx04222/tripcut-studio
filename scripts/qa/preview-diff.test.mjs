import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { decodePng, diffPercent } from "./preview-diff.mjs";

/** 手搓一张最小 8-bit RGBA PNG(不依赖任何图像库),喂给 decodePng 做往返验证。 */
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData));
    return Buffer.concat([len, typeAndData, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // color type 6 = RGBA
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type "None"
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function solidRgba(width, height, [r, g, b, a]) {
  const buf = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    buf[p * 4] = r;
    buf[p * 4 + 1] = g;
    buf[p * 4 + 2] = b;
    buf[p * 4 + 3] = a;
  }
  return buf;
}

describe("preview-diff.mjs · decodePng(手写最小 PNG 解码器,替代不让新增的 pixelmatch/pngjs 依赖)", () => {
  it("往返:自己编码一张 4x3 纯色 RGBA PNG,解码回来的宽高与像素值原样", () => {
    const png = encodePng(4, 3, solidRgba(4, 3, [10, 20, 30, 255]));
    const decoded = decodePng(png);
    expect(decoded.width).toBe(4);
    expect(decoded.height).toBe(3);
    expect(decoded.channels).toBe(4);
    expect([...decoded.pixels.subarray(0, 4)]).toEqual([10, 20, 30, 255]);
    expect([...decoded.pixels.subarray(decoded.pixels.length - 4)]).toEqual([10, 20, 30, 255]);
  });
  it("不是 PNG 签名就报错(门禁读到坏文件要喊出来,不能悄悄当成全黑图)", () => {
    expect(() => decodePng(Buffer.from("not a png at all"))).toThrow(/不是 PNG/);
  });
});

describe("preview-diff.mjs · diffPercent(逐像素通道差,躲开量化抖动的阈值)", () => {
  const frame = (width, height, channels, fill) => ({ width, height, channels, pixels: Buffer.alloc(width * height * channels, fill) });
  it("完全相同的两张图:0%", () => {
    const a = frame(10, 10, 4, 128);
    const b = frame(10, 10, 4, 128);
    expect(diffPercent(a, b).percent).toBe(0);
  });
  it("尺寸不同直接判 100%,且带出原因(不该往下算像素,算了也没意义)", () => {
    const a = frame(10, 10, 4, 0);
    const b = frame(20, 10, 4, 0);
    const result = diffPercent(a, b);
    expect(result.percent).toBe(100);
    expect(result.note).toMatch(/尺寸不同/);
  });
  it("轻微量化抖动(每通道差 ≤ 24)不计入 diff——截图链路本身就有这级抖动,不能把它当回归", () => {
    const a = frame(10, 10, 4, 100);
    const b = { ...frame(10, 10, 4, 100), pixels: Buffer.alloc(10 * 10 * 4, 105) }; // 每通道差 5
    expect(diffPercent(a, b).percent).toBe(0);
  });
  it("整张图明显变色(每通道差远超 24)全部计入 diff:100%", () => {
    const a = frame(4, 4, 4, 20);
    const b = frame(4, 4, 4, 200);
    expect(diffPercent(a, b).percent).toBe(100);
  });
  it("门禁自身会响:只改一个像素,diff 占比等于 1/总像素数(不是四舍五入抹掉的量)", () => {
    const width = 10;
    const height = 10;
    const a = frame(width, height, 4, 50);
    const b = frame(width, height, 4, 50);
    b.pixels[0] = 250; // 单个像素的单个通道差 200,远超阈值
    const percent = diffPercent(a, b).percent;
    expect(percent).toBeCloseTo(100 / (width * height), 5);
  });
});
