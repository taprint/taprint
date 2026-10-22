// SPDX-License-Identifier: Apache-2.0
// 字形栅格化：opentype.js Path 命令 → 曲线定步展平 → MonoCanvas.fillPolygons
// （even-odd 扫描线）。纯 JS 通路（ADR-0008），无 native canvas。
import type opentype from 'opentype.js';
import type { MonoCanvas } from './canvas.ts';
import { FONT_BASELINE_RATIO } from './font-provider.ts';
import type { FontProvider, GlyphRun } from './font-provider.ts';

/** 曲线展平步数（二次/三次贝塞尔；预览字号 ≤ ~100dot，16 步精度足够）。 */
const FLATTEN_STEPS = 16;

type Pt = { x: number; y: number };

/** opentype.Path → 轮廓点列（M 起新轮廓；L 直线、C 三次、Q 二次、Z 闭合）。 */
export function pathToContours(path: opentype.Path): Pt[][] {
  const contours: Pt[][] = [];
  let cur: Pt[] = [];
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  const push = (x: number, y: number) => cur.push({ x, y });
  for (const cmd of path.commands) {
    switch (cmd.type) {
      case 'M':
        if (cur.length) contours.push(cur);
        cur = [];
        cx = startX = cmd.x;
        cy = startY = cmd.y;
        push(cx, cy);
        break;
      case 'L':
        cx = cmd.x;
        cy = cmd.y;
        push(cx, cy);
        break;
      case 'C': {
        const x0 = cx;
        const y0 = cy;
        for (let i = 1; i <= FLATTEN_STEPS; i++) {
          const t = i / FLATTEN_STEPS;
          const mt = 1 - t;
          const x = mt * mt * mt * x0 + 3 * mt * mt * t * cmd.x1 + 3 * mt * t * t * cmd.x2 + t * t * t * cmd.x;
          const y = mt * mt * mt * y0 + 3 * mt * mt * t * cmd.y1 + 3 * mt * t * t * cmd.y2 + t * t * t * cmd.y;
          push(x, y);
        }
        cx = cmd.x;
        cy = cmd.y;
        break;
      }
      case 'Q': {
        const x0 = cx;
        const y0 = cy;
        for (let i = 1; i <= FLATTEN_STEPS; i++) {
          const t = i / FLATTEN_STEPS;
          const mt = 1 - t;
          const x = mt * mt * x0 + 2 * mt * t * cmd.x1 + t * t * cmd.x;
          const y = mt * mt * y0 + 2 * mt * t * cmd.y1 + t * t * cmd.y;
          push(x, y);
        }
        cx = cmd.x;
        cy = cmd.y;
        break;
      }
      case 'Z':
        if (cur.length) {
          if (cur[0].x !== cx || cur[0].y !== cy) push(startX, startY);
          contours.push(cur);
          cur = [];
        }
        break;
    }
  }
  if (cur.length) contours.push(cur);
  return contours;
}

export interface DrawTextOptions {
  /** 文字盒顶部 y（dot）；基线 = y + ascent。 */
  x: number;
  y: number;
  sizeDots: number;
  bold?: boolean;
  underline?: boolean;
  /** 墨色灰度（缺省 0）。 */
  value?: number;
}

/** 画一段已排版的字形 run（含假粗体/下划线；缺失字形画占位方框）。 */
export function drawGlyphRun(canvas: MonoCanvas, run: GlyphRun, opts: DrawTextOptions): void {
  const { x, y, sizeDots, bold, underline } = opts;
  const value = opts.value ?? 0;
  const baseline = y + sizeDots * FONT_BASELINE_RATIO;
  const boxSize = Math.max(2, sizeDots * 0.6);
  for (const b of run.boxes) {
    if (b.fallback) {
      // 缺字形占位：空心方框（0.6em）+ 右移 advance
      canvas.strokeRect(Math.round(x + b.x), Math.round(baseline - boxSize), Math.round(boxSize), Math.round(boxSize), 1);
      continue;
    }
    if (b.advance <= 0) continue;
    const path = b.glyph.getPath(x + b.x, baseline, sizeDots);
    const contours = pathToContours(path);
    canvas.fillPolygons(contours, value);
    if (bold) {
      // 假粗体：右移 1dot 重画一遍（热敏设备加粗的通行近似）
      const boldPath = b.glyph.getPath(x + b.x + 1, baseline, sizeDots);
      canvas.fillPolygons(pathToContours(boldPath), value);
    }
  }
  if (underline) {
    const uy = Math.round(baseline + sizeDots * 0.15);
    const uh = Math.max(1, Math.round(sizeDots / 14));
    canvas.fillRect(Math.round(x), uy, Math.round(run.width), uh, value);
  }
}

/** 排版 + 绘制一步到位（返回 run 供调用方做截断/居中决策）。 */
export async function drawText(
  canvas: MonoCanvas,
  provider: FontProvider,
  text: string,
  opts: DrawTextOptions,
): Promise<GlyphRun> {
  const run = await provider.layout(text, opts.sizeDots);
  drawGlyphRun(canvas, run, opts);
  return run;
}
