// SPDX-License-Identifier: Apache-2.0
// 画布模型：8-bit 灰度（255=纸白、0=墨黑），白底黑像素；几何图元（矩形/描边框/
// 横竖线/任意多边形扫描线填充）+ 单色化（阈值）+ pngjs 出 PNG。
//
// 为什么中间层是灰度而不是 1bpp：单色化阈值可调（抖动为后续任务，见 README），
// conformance bbox/采样断言也需要读灰度值；PNG 输出用 grayscale（colorType 0，
// 8bpp）保持文件紧凑。
import { PNG } from 'pngjs';

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** 扫描线填充的边（折线段；y 单调区间 [y0,y1]，端点交叉按左闭右开避免重复计）。 */
interface Edge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class MonoCanvas {
  readonly width: number;
  readonly height: number;
  /** 灰度像素（行主序，255=纸白起点）。 */
  readonly gray: Uint8Array;

  constructor(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new RangeError(`画布尺寸必须为正整数（实际：${width}x${height}）`);
    }
    this.width = width;
    this.height = height;
    this.gray = new Uint8Array(width * height).fill(255);
  }

  at(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 255;
    return this.gray[y * this.width + x];
  }

  set(x: number, y: number, v: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.gray[y * this.width + x] = v;
  }

  /** 实心矩形（越界裁剪）。 */
  fillRect(x: number, y: number, w: number, h: number, value = 0): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) {
      this.gray.fill(value, yy * this.width + x0, yy * this.width + x1);
    }
  }

  /** 描边矩形（四边各 thickness 像素，向内生长）。 */
  strokeRect(x: number, y: number, w: number, h: number, thickness = 2): void {
    const t = Math.max(1, thickness);
    this.fillRect(x, y, w, t);
    this.fillRect(x, y + h - t, w, t);
    this.fillRect(x, y, t, h);
    this.fillRect(x + w - t, y, t, h);
  }

  /** 横线（thickness 向下生长）。 */
  hline(x: number, y: number, length: number, thickness = 2): void {
    this.fillRect(x, y, length, thickness);
  }

  /** 竖线（thickness 向右生长）。 */
  vline(x: number, y: number, length: number, thickness = 2): void {
    this.fillRect(x, y, thickness, length);
  }

  /** 虚线（dash=实段长度、gap=空段长度；横竖由 vertical 决定）。 */
  dashedLine(x: number, y: number, length: number, thickness: number, dash = 4, gap = 2, vertical = false): void {
    let p = 0;
    while (p < length) {
      const seg = Math.min(dash, length - p);
      if (vertical) this.fillRect(x, y + p, thickness, seg);
      else this.fillRect(x + p, y, seg, thickness);
      p += dash + gap;
    }
  }

  /**
   * 多边形扫描线填充（even-odd）：字形路径（opentype Path 命令展平后）走这里。
   * 曲线由调用方按固定步数展平为折线点列；多条子路径（path.commands 的多个 M）
   * 一并传入做 even-odd 合成（挖洞正确）。
   */
  fillPolygons(contours: Array<Array<{ x: number; y: number }>>, value = 0): void {
    const edges: Edge[] = [];
    let minY = Infinity;
    let maxY = -Infinity;
    for (const contour of contours) {
      for (let i = 0; i < contour.length; i++) {
        const a = contour[i];
        const b = contour[(i + 1) % contour.length];
        if (a.y === b.y) continue; // 水平边不产生交叉
        edges.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y });
        if (Math.min(a.y, b.y) < minY) minY = Math.min(a.y, b.y);
        if (Math.max(a.y, b.y) > maxY) maxY = Math.max(a.y, b.y);
      }
    }
    if (!edges.length) return;
    const yStart = Math.max(0, Math.floor(minY));
    const yEnd = Math.min(this.height - 1, Math.ceil(maxY));
    const xs: number[] = [];
    for (let y = yStart; y <= yEnd; y++) {
      const yc = y + 0.5; // 像素中心采样
      xs.length = 0;
      for (const e of edges) {
        const lo = Math.min(e.y0, e.y1);
        const hi = Math.max(e.y0, e.y1);
        if (yc < lo || yc >= hi) continue; // 左闭右开：顶点交叉不重复计
        xs.push(e.x0 + ((yc - e.y0) * (e.x1 - e.x0)) / (e.y1 - e.y0));
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const from = Math.max(0, Math.round(xs[i]));
        const to = Math.min(this.width, Math.round(xs[i + 1]));
        if (to > from) this.gray.fill(value, y * this.width + from, y * this.width + to);
      }
    }
  }

  /** 有墨像素的包围盒（无墨 → null；conformance bbox 断言用）。 */
  inkBBox(): BBox | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.gray[y * this.width + x] < 255) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return minX === Infinity ? null : { minX, minY, maxX, maxY };
  }

  /** 单色化：gray<threshold → 0（黑），否则 255。返回新数组。 */
  toMonochrome(threshold = 128): Uint8Array {
    const out = new Uint8Array(this.gray.length);
    for (let i = 0; i < this.gray.length; i++) out[i] = this.gray[i] < threshold ? 0 : 255;
    return out;
  }

  /** 单色化 → PNG Buffer（grayscale 8bpp，colorType 0）。 */
  toPng(threshold = 128): Buffer {
    const mono = this.toMonochrome(threshold);
    const png = new PNG({ width: this.width, height: this.height, colorType: 0, inputColorType: 0 });
    png.data = Buffer.from(mono); // grayscale：每像素 1 字节
    return PNG.sync.write(png, { colorType: 0, inputColorType: 0 });
  }
}
