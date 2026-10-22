// SPDX-License-Identifier: Apache-2.0
// receipt 呈现渲染单测：58mm 全元素流式出图、行高栅格、对齐三态、警告收集。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderCanvas, renderPng } from '../src/index.ts';

const fontAvailable = existsSync(
  fileURLToPath(new URL('../fonts/NotoSansSC-Regular.ttf', import.meta.url)),
);

/** 58mm 收据全元素模板（text/line/barcode/qrcode/kvtable/table/cut/cashDrawer）。 */
const RECEIPT = {
  schemaVersion: '1.1',
  id: 'tpl_test_receipt',
  code: 'TEST_RECEIPT',
  name: '测试小票',
  dataSources: [
    { name: 'main', type: 'primary', schema: { shop: 'string', total: 'number' } },
    { name: 'items', type: 'detail', schema: { name: 'string', qty: 'number', amount: 'number' } },
  ],
  presentations: {
    receipt: {
      width: '58mm',
      body: [
        { type: 'text', content: '{{shop}}', align: 'center', style: { fontSize: 'double', bold: true } },
        { type: 'kvtable', columns: 1, compact: true, rows: [[[['合计', '{{total}}']]]] },
        {
          type: 'table',
          source: 'items',
          columns: [
            { header: '商品', field: 'name', width: '50%' },
            { header: '数量', field: 'qty', width: '20%', align: 'right' },
            { header: '金额', field: 'amount', width: '30%', align: 'right' },
          ],
        },
        { type: 'line', lineStyle: 'solid' },
        { type: 'barcode', symbology: 'CODE128', content: '690123456789', height: '8mm' },
        { type: 'qrcode', content: 'taprint-preview', size: 3 },
        { type: 'cashDrawer', pulse: 1 },
        { type: 'cut', partial: true },
      ],
    },
  },
};

const DATA = {
  main: { shop: '智慧商店', total: '¥42.50' },
  items: [
    { name: '苹果', qty: 2, amount: '¥10.00' },
    { name: '牛奶', qty: 1, amount: '¥32.50' },
  ],
};

describe.skipIf(!fontAvailable)('receipt 呈现渲染', () => {
  it('58mm 全元素收据：出图非空、宽 464dot（58mm@203 half-up）、高随行累积', async () => {
    const r = await renderPng(RECEIPT, DATA, { dpi: 203 });
    expect(r.png.length).toBeGreaterThan(100);
    expect(r.widthDots).toBe(464);
    expect(r.heightDots).toBeGreaterThanOrEqual(24);
    expect(r.presentation).toBe('receipt');
  });

  it('全元素都有落墨：标题/表格/横线/条码/QR 分区抽查非空', async () => {
    const { canvas } = await renderCanvas(RECEIPT, DATA, { dpi: 203 });
    // 标题行（居中，前 60dot 内应有墨）
    expect(canvas.inkBBox()).not.toBeNull();
    let topInk = 0;
    for (let y = 0; y < 60; y++) for (let x = 0; x < canvas.width; x++) if (canvas.at(x, y) === 0) topInk++;
    expect(topInk).toBeGreaterThan(100);
    // 横线：某一行几乎全宽有墨（rule 行语义）
    const hasFullRow = Array.from({ length: canvas.height }, (_, y) => {
      let ink = 0;
      for (let x = 0; x < canvas.width; x += 4) if (canvas.at(x, y) === 0) ink++;
      return ink > canvas.width / 4 / 1.5;
    }).some(Boolean);
    expect(hasFullRow).toBe(true);
    // 条码区（kvtable+表头+2 行 ≈ 4 行 ×24 + 标题 48 + rule 24 → ~190 附近）有墨块
    let midInk = 0;
    for (let y = 150; y < 260; y++) for (let x = 0; x < canvas.width; x++) if (canvas.at(x, y) === 0) midInk++;
    expect(midInk).toBeGreaterThan(200);
  });

  it('对齐三态：center 行左留白≈右留白、right 行贴右缘（P4/P5 口径）', async () => {
    const t = {
      presentations: {
        receipt: {
          width: '58mm',
          body: [
            { type: 'text', content: '居中文本', align: 'center' },
            { type: 'text', content: '右对齐文本', align: 'right' },
            { type: 'text', content: '左' },
          ],
        },
      },
    };
    const { canvas } = await renderCanvas(t, { main: {} }, { dpi: 203 });
    const rowBBox = (y0: number, y1: number) => {
      let minX = Infinity;
      let maxX = -Infinity;
      for (let y = y0; y < y1; y++)
        for (let x = 0; x < canvas.width; x++) if (canvas.at(x, y) === 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      return { minX, maxX };
    };
    const centerRow = rowBBox(0, 24);
    const rightRow = rowBBox(24, 48);
    const leftGap = centerRow.minX;
    const rightGap = canvas.width - 1 - centerRow.maxX;
    expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(4);
    expect(canvas.width - 1 - rightRow.maxX).toBeLessThanOrEqual(2);
  });

  it('行高栅格：double 行高=2×normal（24dot 栅格折算 dpi）', async () => {
    const t = {
      presentations: {
        receipt: {
          width: '58mm',
          body: [
            { type: 'text', content: '甲' },
            { type: 'text', content: '乙', style: { fontSize: 'double' } },
            { type: 'text', content: '丙' },
          ],
        },
      },
    };
    const { canvas } = await renderCanvas(t, { main: {} }, { dpi: 203 });
    // 高 = 24 + 48 + 24 = 96（无现金区，画布高恰为行高累积）
    expect(canvas.height).toBe(24 + 48 + 24);
    // 三行文字各自区间有墨
    const inkAt = (y0: number, y1: number) => {
      for (let y = y0; y < y1; y++) for (let x = 0; x < canvas.width; x++) if (canvas.at(x, y) === 0) return true;
      return false;
    };
    expect(inkAt(0, 24)).toBe(true);
    expect(inkAt(24, 72)).toBe(true);
    expect(inkAt(72, 96)).toBe(true);
  });

  it('数字 fontSize pt→dot：12pt@300dpi 行=50dot（ADR-0009 half-up 精确折算）', async () => {
    const t = {
      presentations: {
        receipt: { width: '58mm', body: [{ type: 'text', content: 'A', style: { fontSize: 12 } }] },
      },
    };
    const { canvas } = await renderCanvas(t, { main: {} }, { dpi: 300 });
    expect(canvas.height).toBe(50);
  });

  it('警告收集：cashDrawer 跳过、image 跳过、不支持码制跳过', async () => {
    const t = {
      presentations: {
        receipt: {
          width: '58mm',
          body: [
            { type: 'cashDrawer', pulse: 1 },
            { type: 'image', src: 'x.png' },
            { type: 'barcode', symbology: 'ITF', content: '123' },
            { type: 'text', content: 'end' },
          ],
        },
      },
    };
    const r = await renderCanvas(t, { main: {} }, { dpi: 203 });
    const joined = r.warnings.join('\n');
    expect(joined).toContain('cashDrawer-skipped');
    expect(joined).toContain('image-skipped');
    expect(joined).toContain('unsupported-symbology: ITF');
  });

  it('超宽截断：超长文本不越出纸宽（与热敏打印截断一致）', async () => {
    const t = {
      presentations: {
        receipt: { width: '58mm', body: [{ type: 'text', content: '超长商品名称超长商品名称超长商品名称超长商品名称' }] },
      },
    };
    const { canvas } = await renderCanvas(t, { main: {} }, { dpi: 203 });
    const bb = canvas.inkBBox()!;
    expect(bb.maxX).toBeLessThan(canvas.width);
    expect(bb.minX).toBeGreaterThanOrEqual(0);
  });

  it('缺 body 显式报错；auto 呈现选择 label 优先', async () => {
    await expect(renderCanvas({ presentations: { receipt: { width: '58mm' } } }, {}, {})).rejects.toThrow(/body/);
    const both = {
      presentations: {
        label: { size: { width: '40mm', height: '30mm' }, body: [{ type: 'text', content: 'x', x: '1mm', y: '1mm', size: 1 }] },
        receipt: { width: '58mm', body: [{ type: 'text', content: 'y' }] },
      },
    };
    const r = await renderCanvas(both, { main: {} }, {});
    expect(r.presentation).toBe('label');
  });
});
