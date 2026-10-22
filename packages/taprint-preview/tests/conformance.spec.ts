// SPDX-License-Identifier: Apache-2.0
// 预览 conformance 用例集（M3a）：bbox/非空断言钉几何口径。
//
// 登记：docs/conformance.md「Preview (M3a)」段——与 C# IrWpfPreviewRenderer 的
// 逐例几何对齐（P 序号 ↔ C# 行为映射）为后续任务；本文件先钉 TS 侧口径：
// DPI 真值折算（203/25.4 dot/mm，ADR-0009 half-up）、24dot 行高栅格（C#
// BaseLineDots 同源）、对齐三态/超宽截断同语义。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderCanvas } from '../src/index.ts';
import { mmToDots } from '../src/length.ts';

const fontAvailable = existsSync(
  fileURLToPath(new URL('../fonts/NotoSansSC-Regular.ttf', import.meta.url)),
);

describe.skipIf(!fontAvailable)('preview conformance（P1-P10）', () => {
  it('P1 纸面尺寸：40×30mm@203dpi → 320×240 dot（half-up，非 8dot/mm 近似）', async () => {
    const r = await renderCanvas(LABEL_40X30, {}, { dpi: 203 });
    expect(r.canvas.width).toBe(320);
    expect(r.canvas.height).toBe(240);
  });

  it('P2 纸面尺寸 @300dpi：40×30mm → 472×354 dot（同模板换 dpi 线性放大）', async () => {
    const r = await renderCanvas(LABEL_40X30, {}, { dpi: 300 });
    expect(r.canvas.width).toBe(472); // 40*300/25.4 = 472.44 → 472
    expect(r.canvas.height).toBe(354); // 30*300/25.4 = 354.33 → 354
  });

  it('P3 绝对坐标：text x/y 18mm/4mm → 笔起点折算落点（half-up；字形侧留 ≤3dot）', async () => {
    const tpl = {
      presentations: {
        label: {
          size: { width: '40mm', height: '30mm' },
          body: [{ type: 'text', content: '测试', x: '18mm', y: '4mm', size: 1 }],
        },
      },
    };
    const { canvas } = await renderCanvas(tpl, { main: {} }, { dpi: 203 });
    const bb = canvas.inkBBox()!;
    // 笔位置 = half-up 折算（143.86→144、31.97→32）；首墨点因字形侧边距右/下偏 ≤3dot
    expect(bb.minX).toBeGreaterThanOrEqual(mmToDots(18, 203));
    expect(bb.minX).toBeLessThanOrEqual(mmToDots(18, 203) + 3);
    expect(bb.minY).toBeGreaterThanOrEqual(mmToDots(4, 203));
    expect(bb.minY).toBeLessThanOrEqual(mmToDots(4, 203) + 3);
  });

  it('P4 居中文本：左留白≈右留白（±4dot）', async () => {
    const tpl = {
      presentations: {
        receipt: { width: '58mm', body: [{ type: 'text', content: '居中标题', align: 'center' }] },
      },
    };
    const { canvas } = await renderCanvas(tpl, { main: {} }, { dpi: 203 });
    const bb = canvas.inkBBox()!;
    expect(Math.abs(bb.minX - (canvas.width - 1 - bb.maxX))).toBeLessThanOrEqual(4);
  });

  it('P5 右对齐文本：右缘贴边 ≤2dot', async () => {
    const tpl = {
      presentations: {
        receipt: { width: '58mm', body: [{ type: 'text', content: '合计', align: 'right' }] },
      },
    };
    const { canvas } = await renderCanvas(tpl, { main: {} }, { dpi: 203 });
    const bb = canvas.inkBBox()!;
    expect(canvas.width - 1 - bb.maxX).toBeLessThanOrEqual(2);
  });

  it('P6 横线：y 向厚度=thickness dot（2），x 覆盖整行', async () => {
    const tpl = {
      presentations: {
        label: {
          size: { width: '40mm', height: '30mm' },
          body: [{ type: 'line', x: '2mm', y: '15mm', width: '36mm', height: '0mm', thickness: 2 }],
        },
      },
    };
    const { canvas } = await renderCanvas(tpl, {}, { dpi: 203 });
    const bb = canvas.inkBBox()!;
    expect(bb.maxY - bb.minY + 1).toBe(2);
    expect(bb.minX).toBe(mmToDots(2, 203));
    expect(bb.maxX).toBe(mmToDots(38, 203) - 1); // 2+36=38mm 端点
  });

  it('P7 box：四边有墨、内部纸白（C7 interior 采样）', async () => {
    const tpl = {
      presentations: {
        label: {
          size: { width: '40mm', height: '30mm' },
          body: [{ type: 'box', x: '2mm', y: '2mm', width: '36mm', height: '26mm', thickness: 2 }],
        },
      },
    };
    const { canvas } = await renderCanvas(tpl, {}, { dpi: 203 });
    const bb = canvas.inkBBox()!;
    expect(bb.minX).toBe(mmToDots(2, 203));
    expect(bb.maxX).toBe(mmToDots(38, 203) - 1);
    expect(canvas.at(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2))).toBe(255);
  });

  it('P8 条码 bbox 高度 = height 折算 dot（等比宽度，C8）', async () => {
    const tpl = {
      presentations: {
        label: {
          size: { width: '40mm', height: '30mm' },
          body: [{ type: 'barcode', symbology: 'CODE128', content: 'ABC-123', x: '4mm', y: '6mm', height: '10mm' }],
        },
      },
    };
    const { canvas } = await renderCanvas(tpl, {}, { dpi: 203 });
    const bb = canvas.inkBBox()!;
    expect(bb.maxY - bb.minY + 1).toBe(mmToDots(10, 203));
    expect(bb.maxX - bb.minX + 1).toBeGreaterThan(mmToDots(10, 203)); // 宽 > 高（一维码形态）
  });

  it('P9 QR bbox 正方形（模块 cell 折算后宽=高）', async () => {
    const tpl = {
      presentations: {
        label: {
          size: { width: '40mm', height: '30mm' },
          body: [{ type: 'qrcode', content: 'P9', x: '5mm', y: '5mm', size: 4 }],
        },
      },
    };
    const { canvas } = await renderCanvas(tpl, {}, { dpi: 203 });
    const bb = canvas.inkBBox()!;
    expect(bb.maxX - bb.minX).toBe(bb.maxY - bb.minY);
  });

  it('P10 超宽截断：不越出纸面（右上角留白 ≥0，票面完整）', async () => {
    const tpl = {
      presentations: {
        label: {
          size: { width: '40mm', height: '30mm' },
          body: [{ type: 'text', content: '很长很长的商品名称很长很长的商品名称很长很长的商品名称', x: '20mm', y: '4mm', size: 1 }],
        },
      },
    };
    const { canvas } = await renderCanvas(tpl, { main: {} }, { dpi: 203 });
    const bb = canvas.inkBBox()!;
    expect(bb.maxX).toBeLessThan(canvas.width);
    expect(bb.maxY).toBeLessThan(canvas.height);
  });
});

const LABEL_40X30 = {
  presentations: {
    label: {
      size: { width: '40mm', height: '30mm' },
      body: [{ type: 'text', content: 'P', x: '1mm', y: '1mm', size: 1 }],
    },
  },
};
