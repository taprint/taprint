// SPDX-License-Identifier: Apache-2.0
// MonoCanvas 单测：图元、扫描线多边形填充（even-odd 挖洞）、单色化、PNG 往返。
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { MonoCanvas } from '../src/canvas.ts';
import { pathToContours } from '../src/text.ts';

describe('MonoCanvas', () => {
  it('构造：白底（255）；非法尺寸抛错', () => {
    const c = new MonoCanvas(4, 3);
    expect(c.width).toBe(4);
    expect(c.height).toBe(3);
    expect(c.at(0, 0)).toBe(255);
    expect(() => new MonoCanvas(0, 3)).toThrow(RangeError);
  });

  it('fillRect + inkBBox：包围盒与写入区一致；越界裁剪', () => {
    const c = new MonoCanvas(20, 20);
    c.fillRect(5, 5, 4, 3);
    expect(c.inkBBox()).toEqual({ minX: 5, minY: 5, maxX: 8, maxY: 7 });
    c.fillRect(18, 18, 10, 10); // 越界部分裁剪
    expect(c.inkBBox()!.maxX).toBe(19);
    expect(c.inkBBox()!.maxY).toBe(19);
  });

  it('strokeRect：四边有墨、中心保持纸白', () => {
    const c = new MonoCanvas(30, 30);
    c.strokeRect(2, 2, 20, 20, 2);
    expect(c.at(2, 2)).toBe(0);
    expect(c.at(21, 2)).toBe(0);
    expect(c.at(12, 12)).toBe(255);
  });

  it('fillPolygons even-odd：外框含内洞——洞内纸白、环带有墨', () => {
    const c = new MonoCanvas(40, 40);
    const sq = (x0: number, y0: number, x1: number, y1: number) => [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ];
    c.fillPolygons([sq(5, 5, 35, 35), sq(15, 15, 25, 25)]);
    expect(c.at(10, 10)).toBe(0); // 环带
    expect(c.at(20, 20)).toBe(255); // 洞
    expect(c.at(20, 8)).toBe(0);
  });

  it('dashedLine：实段有墨、空段纸白', () => {
    const c = new MonoCanvas(40, 4);
    c.dashedLine(0, 1, 40, 2, 4, 2);
    expect(c.at(1, 1)).toBe(0);
    expect(c.at(5, 1)).toBe(255); // dash(4)+gap(2) 后空段
    expect(c.at(7, 1)).toBe(0);
  });

  it('toMonochrome 阈值：<128→黑、≥128→白', () => {
    const c = new MonoCanvas(3, 1);
    c.set(0, 0, 127);
    c.set(1, 0, 128);
    const mono = c.toMonochrome(128);
    expect(mono[0]).toBe(0);
    expect(mono[1]).toBe(255);
  });

  it('toPng：grayscale PNG 尺寸与画布一致、解码往返宽度高度正确', () => {
    const c = new MonoCanvas(17, 9);
    c.fillRect(0, 0, 17, 9, 0);
    const png = c.toPng();
    const back = PNG.sync.read(png);
    expect(back.width).toBe(17);
    expect(back.height).toBe(9);
    // 首行首像素 = 墨（grayscale 展开 RGBA 后 r=0）
    expect(back.data[0]).toBe(0);
  });

  it('pathToContours：opentype 命令展平为闭合轮廓（M…Z→点数 ≥ 4）', () => {
    const contours = pathToContours({
      commands: [
        { type: 'M', x: 0, y: 0 },
        { type: 'L', x: 10, y: 0 },
        { type: 'L', x: 10, y: 10 },
        { type: 'Z' },
      ],
    } as never);
    expect(contours.length).toBe(1);
    expect(contours[0].length).toBeGreaterThanOrEqual(4);
    expect(contours[0][0]).toEqual(contours[0][contours[0].length - 1]);
  });
});
