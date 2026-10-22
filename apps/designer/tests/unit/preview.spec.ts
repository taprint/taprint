// SPDX-License-Identifier: Apache-2.0
// M2 预览仿真（纯函数层）：mockData / evaluate / layoutReceipt / layoutLabel。
// 光栅化层（canvas toBlob）不进 jsdom 单测，由 e2e preview.spec.ts 覆盖。
import { describe, expect, it } from 'vitest';
import { provideMockData } from '../../src/canvas/preview/mockData';
import { evaluateInterpolated, evaluateWhen } from '../../src/canvas/preview/evaluate';
import { displayWidth, layoutReceipt, wrapText } from '../../src/canvas/preview/ReceiptSimulator';
import { layoutLabel } from '../../src/canvas/preview/LabelSimulator';

const DSL: Record<string, unknown> = {
  schemaVersion: '2.0',
  id: 'tpl_preview_test',
  code: 'PREVIEW_TEST',
  name: '预览仿真测试模板',
  dataSources: [
    {
      name: 'main',
      type: 'primary',
      schema: {
        billNo: 'string',
        billDate: 'date',
        customer: { name: 'string' },
        totalAmount: 'number',
        paidAmount: 'number',
      },
    },
    { name: 'items', type: 'detail', schema: { sku: 'string', qty: 'integer', amount: 'number' } },
  ],
  parameters: [
    { name: 'copies', type: 'integer', default: 1 },
    { name: 'printer', type: 'string', default: null },
    { name: 'silent', type: 'boolean', default: true },
  ],
  presentations: {
    receipt: { width: '80mm', body: [] },
    label: { size: { width: '40mm', height: '30mm' }, body: [] },
  },
};

function withReceiptBody(body: unknown[], width = '80mm'): Record<string, unknown> {
  return {
    ...DSL,
    presentations: {
      receipt: { width, body },
      label: { size: { width: '40mm', height: '30mm' }, body: [] },
    },
  };
}

describe('provideMockData（M2 预览仿真块 A）', () => {
  it('primary 源字段根级平铺 + 源名嵌套双挂（evaluate 路径解析口径）', () => {
    const data = provideMockData(DSL);
    expect(data.billNo).toBe('示例-billNo');
    expect((data.main as Record<string, unknown>).billNo).toBe('示例-billNo');
    expect((data.customer as Record<string, unknown>).name).toBe('示例-customer.name');
    expect(((data.main as Record<string, unknown>).customer as Record<string, unknown>).name).toBe(
      '示例-customer.name',
    );
    expect(data.billDate).toBe('2026-01-15');
  });

  it('detail 源 → 3 行数组挂源名键，数值随行号可辨识', () => {
    const data = provideMockData(DSL);
    const items = data.items as Record<string, unknown>[];
    expect(items).toHaveLength(3);
    expect(items.map((r) => r.qty)).toEqual([12, 13, 14]);
    expect(items.map((r) => r.amount)).toEqual([12.5, 13.5, 14.5]);
    expect(items[0].sku).toBe('示例-sku');
  });

  it('parameters 取 default（含显式 null），缺省按类型兜底', () => {
    const data = provideMockData(DSL);
    expect(data.copies).toBe(1);
    expect(data.printer).toBeNull();
    expect(data.silent).toBe(true);
    const noDefault = provideMockData({
      parameters: [
        { name: 'mode', type: 'boolean' },
        { name: 'tag', type: 'string' },
      ],
    });
    expect(noDefault.mode).toBe(true);
    expect(noDefault.tag).toBe('示例-tag');
  });

  it('空/畸形 DSL 容错返回空对象（宿主数据不信任边界）', () => {
    expect(provideMockData(null)).toEqual({});
    expect(provideMockData({ dataSources: 'x', parameters: {} })).toEqual({});
    expect(provideMockData({ dataSources: [{ name: 1 }] })).toEqual({});
  });

  it('同 DSL 两次生成逐字一致（确定性/golden 友好）', () => {
    expect(provideMockData(DSL)).toEqual(provideMockData(DSL));
  });
});

describe('evaluateInterpolated / evaluateWhen（M2 预览仿真块 A）', () => {
  const data = provideMockData(DSL);

  it('合法插值逐段替换', () => {
    expect(evaluateInterpolated('单号：{{billNo}}', data)).toBe('单号：示例-billNo');
    expect(evaluateInterpolated('{{customer.name}}', data)).toBe('示例-customer.name');
  });

  it('过滤器走内核沙箱（currency:CNY）', () => {
    expect(evaluateInterpolated('合计 {{totalAmount | currency:CNY}}', data)).toBe('合计 ¥12.50');
  });

  it('非法表达式原样保留（设计态容错，不抛错）', () => {
    expect(evaluateInterpolated('x {{a @ b}} y', data)).toBe('x {{a @ b}} y');
    expect(evaluateInterpolated('x {{no.such.field}} y', data)).toBe('x  y');
  });

  it('when 真值：替换后经内核求值（N2 JS 真值规则）', () => {
    expect(evaluateWhen('{{totalAmount}} > 0', data)).toBe(true);
    expect(
      evaluateWhen('{{paidAmount}} < {{totalAmount}} ? true : false', {
        paidAmount: 10,
        totalAmount: 12.5,
      }),
    ).toBe(true);
  });

  it('when 假值：0 / 比较不成立 → false；空/非法兜底 true', () => {
    expect(evaluateWhen('{{copies}}', { copies: 0 })).toBe(false);
    expect(
      evaluateWhen('{{paidAmount}} < {{totalAmount}}', { paidAmount: 20, totalAmount: 12.5 }),
    ).toBe(false);
    expect(evaluateWhen('', data)).toBe(true);
    // 整段非法（无 {{}} 可替换）→ 编译失败兜底 true；{{a @ b}} 替换为 null 后可合法求值
    expect(evaluateWhen('a @ b', data)).toBe(true);
    expect(evaluateWhen('{{a @ b}} === 1', data)).toBe(false);
  });
});

describe('layoutReceipt（M2 预览仿真块 B）', () => {
  it('80mm → 48 列；缺省纸宽按 80mm', () => {
    expect(layoutReceipt(withReceiptBody([]), {}).columns).toBe(48);
    expect(layoutReceipt({ presentations: { receipt: {} } }, {}).columns).toBe(48);
  });

  it('58mm → 32 列', () => {
    expect(layoutReceipt(withReceiptBody([], '58mm'), {}).columns).toBe(32);
  });

  it('CJK 双列宽折行（displayWidth 与 wrapText）', () => {
    expect(displayWidth('汉字ab')).toBe(6);
    const long = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十'; // 30 CJK = 60 列
    const lines = wrapText(long, 48);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(displayWidth(l)).toBeLessThanOrEqual(48);
    const layout = layoutReceipt(withReceiptBody([{ type: 'text', content: long }]), {});
    const textRows = layout.rows.filter((r) => r.kind === 'text');
    expect(textRows.length).toBeGreaterThan(1);
  });

  it('元素类型映射：line→sep、barcode/qrcode 占位、kvtable key：value、cut 切纸线', () => {
    const data = provideMockData(DSL);
    const layout = layoutReceipt(
      withReceiptBody([
        { type: 'line', lineStyle: 'solid' },
        { type: 'barcode', symbology: 'EAN13', content: '{{billNo}}' },
        { type: 'qrcode', content: '{{billNo}}' },
        { type: 'kvtable', columns: 1, rows: [[['单号', '{{billNo}}']]] },
        { type: 'cut', partial: true },
      ]),
      data,
    );
    expect(layout.rows.some((r) => r.kind === 'sep' && r.text === '-'.repeat(48))).toBe(true);
    expect(layout.rows).toContainEqual(
      expect.objectContaining({ kind: 'barcode', text: '[条码 EAN13] 示例-billNo' }),
    );
    expect(layout.rows).toContainEqual(
      expect.objectContaining({ kind: 'qrcode', text: '[二维码] 示例-billNo' }),
    );
    expect(layout.rows).toContainEqual(
      expect.objectContaining({ kind: 'kv', text: '单号：示例-billNo' }),
    );
    expect(layout.rows.at(-1)?.kind).toBe('sep');
  });

  it('loop 只渲一轮：each 源首行字段平铺进作用域', () => {
    const data = provideMockData(DSL);
    const layout = layoutReceipt(
      withReceiptBody([
        { type: 'loop', each: 'items', body: [{ type: 'text', content: '{{sku}}×{{qty}}' }] },
      ]),
      data,
    );
    const texts = layout.rows.filter((r) => r.kind === 'text');
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toBe('示例-sku×12');
  });

  it('conditional 按 when 择路（真 body / 假 elseBody）', () => {
    const body = [
      {
        type: 'conditional',
        when: '{{copies}} > 0',
        body: [{ type: 'text', content: '满足条件' }],
        elseBody: [{ type: 'text', content: '不满足条件' }],
      },
    ];
    const pass = layoutReceipt(withReceiptBody(body), { copies: 1 });
    expect(pass.rows.map((r) => r.text)).toContain('满足条件');
    const fail = layoutReceipt(withReceiptBody(body), { copies: 0 });
    expect(fail.rows.map((r) => r.text)).toContain('不满足条件');
  });

  it('表达式插值进 text 行且布局确定性（同输入逐字一致）', () => {
    const data = provideMockData(DSL);
    const dsl = withReceiptBody([
      { type: 'text', content: '{{storeName}} 销售单', align: 'center' },
    ]);
    const a = layoutReceipt(dsl, { ...data, storeName: '示例门店' });
    const b = layoutReceipt(dsl, { ...data, storeName: '示例门店' });
    expect(a).toEqual(b);
    expect(a.rows[0]).toEqual({ text: '示例门店 销售单', align: 'center', kind: 'text' });
  });
});

describe('layoutLabel（M2 预览仿真块 B）', () => {
  it('绝对坐标（mm）+ 缺省纸面 40×30mm', () => {
    const data = provideMockData(DSL);
    const layout = layoutLabel(
      {
        presentations: {
          label: {
            body: [
              {
                type: 'text',
                content: '{{billNo}}',
                x: '5mm',
                y: '8mm',
                width: '20mm',
                height: '6mm',
              },
              {
                type: 'barcode',
                symbology: 'CODE128',
                content: '{{billNo}}',
                x: '2mm',
                y: '16mm',
                width: '30mm',
                height: '8mm',
              },
            ],
          },
        },
      },
      data,
    );
    expect(layout.widthMm).toBe(40);
    expect(layout.heightMm).toBe(30);
    expect(layout.blocks[0]).toEqual(
      expect.objectContaining({
        type: 'text',
        x: 5,
        y: 8,
        width: 20,
        height: 6,
        text: '示例-billNo',
      }),
    );
    expect(layout.blocks[1].text).toBe('[条码 CODE128] 示例-billNo');
  });

  it('缺省 size 与缺省元素宽高兜底（40×30mm / 20×6mm）', () => {
    const layout = layoutLabel(
      { presentations: { label: { body: [{ type: 'text', content: 'x' }] } } },
      {},
    );
    expect(layout.widthMm).toBe(40);
    expect(layout.heightMm).toBe(30);
    expect(layout.blocks[0]).toEqual(expect.objectContaining({ x: 0, y: 0, width: 20, height: 6 }));
  });
});
