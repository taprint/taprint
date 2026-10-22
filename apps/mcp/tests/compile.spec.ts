// SPDX-License-Identifier: Apache-2.0
// compile 工具测试：三 target 字节非空 + 帧序、未知 target / 缺呈现 /
// 能力外元素 / 参数域的显式报错。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileTemplate } from '../src/tools/compile.ts';
import { ToolError } from '../src/lib/errors.ts';
import { asciiBytes, indexOfBytes } from 'taprint';

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../fixtures/templates/${name}`, import.meta.url)),
      'utf8',
    ),
  );

const decode = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, 'base64'));
const hasText = (bytes: Uint8Array, text: string) =>
  indexOfBytes(bytes, asciiBytes(text)) >= 0;

const labelData = {
  main: {
    sku: '6901234567892',
    name: '有机牛奶 250ml',
    price: 12.5,
    unit: '瓶',
    origin: '河北',
    shelfNo: 'A-01',
  },
  copies: 2,
};

const receiptData = {
  main: {
    billNo: 'SN20261022001',
    billDate: '2026-10-22T10:30:00',
    store: { name: '示例门店', phone: '010-00000000' },
    cashier: '张三',
    totalAmount: 25,
    discount: 0,
    paidAmount: 25,
    changeAmount: 0,
    payMethod: '现金',
  },
  items: [
    { name: '有机牛奶', qty: 2, price: 12.5, amount: 25 },
  ],
};

describe('compile — tspl', () => {
  it('货架标签 → 字节非空 + 帧序含 SIZE/GAP/TEXT/BARCODE/PRINT', () => {
    const out = compileTemplate({ template: fixture('shelf-label-v1.0.json'), data: labelData, target: 'tspl' });
    expect(out.byteCount).toBeGreaterThan(0);
    expect(out.bytesBase64.length).toBeGreaterThan(0);
    const bytes = decode(out.bytesBase64);
    expect(bytes.length).toBe(out.byteCount);
    expect(hasText(bytes, 'SIZE 70 mm,30 mm\r\n')).toBe(true);
    expect(hasText(bytes, 'PRINT 2\r\n')).toBe(true);
    expect(out.frameSummary.some((s) => s.startsWith('SIZE 70 mm,30 mm'))).toBe(true);
    expect(out.frameSummary.some((s) => s.startsWith('BARCODE'))).toBe(true);
    expect(out.frameSummary[out.frameSummary.length - 1]).toBe('PRINT 2');
  });

  it('options 覆盖：widthMm=50 → SIZE 50 mm；copies=3 → PRINT 3', () => {
    const out = compileTemplate({
      template: fixture('shelf-label-v1.0.json'),
      data: labelData,
      target: 'tspl',
      options: { widthMm: 50, copies: 3 },
    });
    const bytes = decode(out.bytesBase64);
    expect(hasText(bytes, 'SIZE 50 mm,30 mm\r\n')).toBe(true);
    expect(hasText(bytes, 'PRINT 3\r\n')).toBe(true);
  });
});

describe('compile — cpcl', () => {
  it('货架标签 → 字节非空 + 帧序含 header/FORM/PRINT', () => {
    const out = compileTemplate({ template: fixture('shelf-label-v1.0.json'), data: labelData, target: 'cpcl' });
    expect(out.byteCount).toBeGreaterThan(0);
    expect(out.frameSummary[0]).toMatch(/^! 200 dpi header/);
    expect(out.frameSummary).toContain('FORM');
    expect(out.frameSummary).toContain('PRINT');
    expect(decode(out.bytesBase64).length).toBe(out.byteCount);
  });
});

describe('compile — escpos', () => {
  it('销售小票 + 数据 → 字节非空 + ESC @ 帧首 + GS V 切纸 + 数据渲染进字节', () => {
    const out = compileTemplate({
      template: fixture('esc-pos-receipt-v1.0.json'),
      data: receiptData,
      target: 'escpos',
    });
    expect(out.byteCount).toBeGreaterThan(0);
    const bytes = decode(out.bytesBase64);
    expect(bytes[0]).toBe(0x1b);
    expect(bytes[1]).toBe(0x40);
    expect(hasText(bytes, 'SN20261022001')).toBe(true);
    expect(indexOfBytes(bytes, Uint8Array.from([0x1d, 0x56, 0x01]))).toBeGreaterThanOrEqual(0);
    expect(out.frameSummary.some((s) => s.startsWith('TABLE items'))).toBe(true);
    expect(out.frameSummary.some((s) => s.startsWith('CUT'))).toBe(true);
  });

  it('收据含 barcode 元素 → 内核 Dart 兜底口径：空行占位 + WARN 入帧序（不静默）', () => {
    const out = compileTemplate({
      template: fixture('goods-barcode-label-v1.0.json'),
      data: { main: { sku: '123', name: 'x', spec: 's', price: 1 } },
      target: 'escpos',
    });
    expect(out.byteCount).toBeGreaterThan(0);
    expect(out.frameSummary.some((s) => s.startsWith('WARN barcode') && s.includes('空行占位'))).toBe(true);
  });

  it('收据含 image 元素 → unsupported-element 显式报错（光栅化属 v0.3）', () => {
    const tpl = fixture('esc-pos-receipt-v1.0.json');
    const receipt = (tpl.presentations as Record<string, unknown>).receipt as Record<string, unknown>;
    (receipt.body as Array<Record<string, unknown>>).push({ type: 'image', src: '{{billNo}}' });
    try {
      compileTemplate({ template: tpl, data: receiptData, target: 'escpos' });
      expect.unreachable('应抛 unsupported-element');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe('unsupported-element');
    }
  });

  it('table 源无数据 → missing-data', () => {
    const tpl = fixture('esc-pos-receipt-v1.0.json');
    expect(() => compileTemplate({ template: tpl, data: { main: (receiptData as Record<string, unknown>).main }, target: 'escpos' })).toThrowError(/items/);
  });
});

describe('compile — 入参与能力边界', () => {
  it('未知 target → unknown-target', () => {
    try {
      compileTemplate({ template: fixture('shelf-label-v1.0.json'), target: 'zpl' as never });
      expect.unreachable('应抛 unknown-target');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as ToolError).code).toBe('unknown-target');
    }
  });

  it('tspl 目标遇纯收据模板 → missing-presentation（呈现路不匹配显式报错）', () => {
    try {
      compileTemplate({ template: fixture('esc-pos-receipt-v1.0.json'), data: receiptData, target: 'tspl' });
      expect.unreachable('应抛 missing-presentation');
    } catch (e) {
      expect((e as ToolError).code).toBe('missing-presentation');
    }
  });

  it('escpos 目标遇纯标签模板 → missing-presentation', () => {
    try {
      compileTemplate({ template: fixture('shelf-label-v1.0.json'), data: labelData, target: 'escpos' });
      expect.unreachable('应抛 missing-presentation');
    } catch (e) {
      expect((e as ToolError).code).toBe('missing-presentation');
    }
  });

  it('dpi=300 → unsupported-dpi（内核锁 8 dot/mm）', () => {
    try {
      compileTemplate({ template: fixture('shelf-label-v1.0.json'), data: labelData, target: 'tspl', options: { dpi: 300 } });
      expect.unreachable('应抛 unsupported-dpi');
    } catch (e) {
      expect((e as ToolError).code).toBe('unsupported-dpi');
    }
  });

  it('escpos 份数 → option-not-supported（收据份数=宿主重发语义）', () => {
    try {
      compileTemplate({ template: fixture('esc-pos-receipt-v1.0.json'), data: receiptData, target: 'escpos', options: { copies: 2 } });
      expect.unreachable('应抛 option-not-supported');
    } catch (e) {
      expect((e as ToolError).code).toBe('option-not-supported');
    }
  });

  it('label 含 image 元素 → unsupported-element（光栅化属 v0.3）', () => {
    const tpl = fixture('shelf-label-v1.0.json');
    const label = (tpl.presentations as Record<string, unknown>).label as Record<string, unknown>;
    (label.body as Array<Record<string, unknown>>).push({ type: 'image', src: '{{sku}}', x: '1mm', y: '1mm' });
    try {
      compileTemplate({ template: tpl, data: labelData, target: 'tspl' });
      expect.unreachable('应抛 unsupported-element');
    } catch (e) {
      expect((e as ToolError).code).toBe('unsupported-element');
    }
  });
});
