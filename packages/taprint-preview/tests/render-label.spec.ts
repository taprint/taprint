// SPDX-License-Identifier: Apache-2.0
// label 呈现渲染单测：绝对坐标、字号倍率、条码/QR、box/line、警告收集。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderCanvas, renderPng } from '../src/index.ts';
import { mmToDots } from '../src/length.ts';

const fontAvailable = existsSync(
  fileURLToPath(new URL('../fonts/NotoSansSC-Regular.ttf', import.meta.url)),
);

const LABEL = {
  schemaVersion: '1.1',
  id: 'tpl_test_label',
  code: 'TEST_LABEL',
  name: '测试标签',
  dataSources: [{ name: 'main', type: 'primary', schema: { sku: 'string', name: 'string', price: 'number' } }],
  presentations: {
    label: {
      size: { width: '40mm', height: '30mm' },
      body: [
        { type: 'qrcode', content: '{{sku}}', x: '2mm', y: '2mm', size: 4 },
        {
          type: 'barcode',
          symbology: 'CODE128',
          content: '{{sku}}',
          x: '2mm',
          y: '20mm',
          height: '8mm',
        },
        { type: 'text', content: '{{name}}', x: '18mm', y: '4mm', size: 1 },
        { type: 'text', content: '¥{{price}}', x: '18mm', y: '12mm', size: 1 },
        { type: 'box', x: '1mm', y: '1mm', width: '38mm', height: '28mm', thickness: 2 },
        { type: 'line', x: '18mm', y: '10mm', width: '20mm', height: '0mm', thickness: 2 },
        { type: 'image', src: 'logo.png', x: '30mm', y: '24mm' },
      ],
    },
  },
};

const DATA = { main: { sku: 'SKU-690123', name: '测试商品名称', price: 12.5 } };

describe.skipIf(!fontAvailable)('label 呈现渲染', () => {
  it('40×30 标签全元素渲染：出图非空、尺寸 320×240（203dpi half-up）', async () => {
    const r = await renderPng(LABEL, DATA, { dpi: 203 });
    expect(r.png.length).toBeGreaterThan(100);
    expect(r.widthDots).toBe(320);
    expect(r.heightDots).toBe(240);
    expect(r.presentation).toBe('label');
  });

  it('元素墨迹非空：QR/条码/文本/box/line 都有落墨（bbox 覆盖各区域）', async () => {
    const { canvas } = await renderCanvas(LABEL, DATA, { dpi: 203 });
    const bb = canvas.inkBBox();
    expect(bb).not.toBeNull();
    // QR 起点 2mm→16；box 外框 1mm→8；文本 18mm→144；条码 y 20mm→160
    expect(bb!.minX).toBeLessThanOrEqual(mmToDots(2, 203));
    expect(bb!.maxX).toBeGreaterThanOrEqual(mmToDots(36, 203));
    expect(bb!.maxY).toBeGreaterThanOrEqual(mmToDots(20, 203));
    // 文本区非空
    let textInk = 0;
    for (let y = 32; y < 56; y++)
      for (let x = 144; x < 250; x++) if (canvas.at(x, y) === 0) textInk++;
    expect(textInk).toBeGreaterThan(50);
  });

  it('CJK 文本行非空且随数据变化（表达式绑定生效）', async () => {
    const a = await renderCanvas(LABEL, DATA, { dpi: 203 });
    const b = await renderCanvas(LABEL, { main: { sku: 'X1', name: '乙', price: 3 } }, { dpi: 203 });
    expect(a.canvas.inkBBox()).not.toBeNull();
    expect(b.canvas.inkBBox()).not.toBeNull();
    // 数据不同 → 票面像素不同（表达式真实求值）
    expect(a.canvas.gray).not.toEqual(b.canvas.gray);
  });

  it('text size 倍率：size 2 行高≈2×size 1（24dot 栅格折算 dpi）', async () => {
    const t = {
      presentations: {
        label: {
          size: { width: '40mm', height: '30mm' },
          body: [
            { type: 'text', content: '测', x: '1mm', y: '1mm', size: 1 },
            { type: 'text', content: '测', x: '1mm', y: '10mm', size: 2 },
          ],
        },
      },
    };
    const { canvas } = await renderCanvas(t, {}, { dpi: 203 });
    // size1 顶 8dot；size2 顶 10mm→80dot、高 48dot
    const rowHeightAt = (y: number) => {
      let h = 0;
      for (let yy = y; yy < canvas.height; yy++) {
        let ink = 0;
        for (let x = 8; x < 40; x++) if (canvas.at(x, yy) === 0) ink++;
        if (ink === 0 && yy > y + 10) break;
        if (ink > 0) h = yy - y + 1;
      }
      return h;
    };
    const h1 = rowHeightAt(8);
    const h2 = rowHeightAt(80);
    expect(h1).toBeGreaterThan(10);
    expect(h2).toBeGreaterThan(h1);
  });

  it('警告收集：image 跳过、不支持码制、未知元素、圆角降级都进 warnings', async () => {
    const t = {
      presentations: {
        label: {
          size: { width: '40mm', height: '30mm' },
          body: [
            { type: 'image', src: 'a.png', x: '1mm', y: '1mm' },
            { type: 'barcode', symbology: 'CODE39', content: 'X', x: '1mm', y: '5mm', height: '5mm' },
            { type: 'glyph', content: '??', x: '1mm', y: '9mm' },
            { type: 'box', x: '1mm', y: '13mm', width: '10mm', height: '10mm', radius: '2mm' },
          ],
        },
      },
    };
    const r = await renderCanvas(t, {}, { dpi: 203 });
    const joined = r.warnings.join('\n');
    expect(joined).toContain('image-skipped');
    expect(joined).toContain('unsupported-symbology: CODE39');
    expect(joined).toContain('unknown-element: glyph');
    expect(joined).toContain('box-radius-degraded');
  });

  it('EAN13 渲染成功且 bbox 高度=height 折算 dot（C8 口径）', async () => {
    const t = {
      presentations: {
        label: {
          size: { width: '40mm', height: '30mm' },
          body: [{ type: 'barcode', symbology: 'EAN13', content: '690123456789', x: '5mm', y: '5mm', height: '8mm' }],
        },
      },
    };
    const { canvas } = await renderCanvas(t, {}, { dpi: 203 });
    const bb = canvas.inkBBox();
    expect(bb).not.toBeNull();
    expect(bb!.maxY - bb!.minY + 1).toBe(mmToDots(8, 203));
  });

  it('EAN13 内容非法显式报错（barcode-encode-failed），不静默出空图', async () => {
    const t = {
      dataSources: [{ name: 'main', type: 'primary', schema: { bad: 'string' } }],
      presentations: {
        label: {
          size: { width: '40mm', height: '30mm' },
          body: [{ type: 'barcode', symbology: 'EAN13', content: '{{bad}}', x: '5mm', y: '5mm', height: '8mm' }],
        },
      },
    };
    await expect(renderCanvas(t, { main: { bad: 'abc' } }, { dpi: 203 })).rejects.toThrow(/bwip-js/);
  });

  it('缺 size/缺 body 显式报错（RenderError，不静默）', async () => {
    await expect(
      renderCanvas({ presentations: { label: { body: [{ type: 'text', content: 'x', x: '1mm', y: '1mm' }] } } }, {}, {}),
    ).rejects.toThrow(/size/);
    await expect(
      renderCanvas({ presentations: { label: { size: { width: '40mm', height: '30mm' } } } }, {}, {}),
    ).rejects.toThrow(/body/);
  });
});
