// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useDesignerStore, type TemplateLike } from '../../src/canvas/store';
import { elementLibrary } from '../../src/canvas/element-library';
import { parseLengthMm } from '../../src/canvas/types';

const baseDsl = (): TemplateLike => ({
  schemaVersion: '1.0',
  id: 'test_store',
  code: 'TEST_STORE',
  name: 'Store 测试',
  dataSources: [
    { name: 'main', type: 'primary', schema: { billNo: 'string' } },
    { name: 'items', type: 'detail', schema: { name: 'string', qty: 'number' } },
  ],
  presentations: {
    doc: { page: { size: 'A4' }, body: [{ type: 'text', content: 'a' }, { type: 'line' }] },
    label: {
      size: { width: '40mm', height: '30mm' },
      body: [{ type: 'text', content: 'L', x: '2mm', y: '3mm', width: '10mm', height: '10mm' }],
    },
  },
});

describe('designer store', () => {
  let store: ReturnType<typeof useDesignerStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    store = useDesignerStore();
  });

  it('loadDsl 深拷贝并自动选中首个可用设备', () => {
    const src = baseDsl();
    store.loadDsl(src);
    expect(store.device).toBe('doc');
    store.select(0);
    store.updateSelected({ content: 'changed' });
    expect((src.presentations.doc as { body: { content?: string }[] }).body[0].content).toBe('a');
  });

  it('setDevice 仅接受模板具备的呈现', () => {
    store.loadDsl(baseDsl());
    store.setDevice('label');
    expect(store.device).toBe('label');
    store.setDevice('receipt');
    expect(store.device).toBe('label');
  });

  it('addElement/removeSelected/updateSelected 维护 body', () => {
    store.loadDsl(baseDsl());
    store.addElement({ type: 'text', content: 'new' }, 1);
    expect(store.activeBody).toHaveLength(3);
    expect(store.selectedIndex).toBe(1);
    store.updateSelected({ content: 'patched' });
    expect(store.selectedElement?.content).toBe('patched');
    store.updateSelected({ content: undefined });
    expect('content' in (store.selectedElement as object)).toBe(false);
    store.removeSelected();
    expect(store.activeBody).toHaveLength(2);
    expect(store.selectedIndex).toBeNull();
  });

  it('moveFlowSelected 交换相邻元素并跟随选中', () => {
    store.loadDsl(baseDsl());
    store.select(0);
    store.moveFlowSelected(1);
    expect(store.activeBody[0].type).toBe('line');
    expect(store.selectedIndex).toBe(1);
    store.moveFlowSelected(-1);
    expect(store.activeBody[0].type).toBe('text');
    // 边界：首位不能再上移
    store.select(0);
    store.moveFlowSelected(-1);
    expect(store.selectedIndex).toBe(0);
  });

  it('moveLabelSelected 像素换算为 mm 且不越负界', () => {
    store.loadDsl(baseDsl());
    store.setDevice('label');
    store.select(0);
    store.moveLabelSelected(96 / 2.54, 96 / 2.54); // +10mm
    expect(store.selectedElement?.x).toBe('12mm');
    expect(store.selectedElement?.y).toBe('13mm');
    store.moveLabelSelected(-10000, -10000);
    expect(store.selectedElement?.x).toBe('0mm');
    expect(store.selectedElement?.y).toBe('0mm');
  });

  it('moveLabelSelected 在 doc 设备下无效', () => {
    store.loadDsl(baseDsl());
    store.select(0);
    store.moveLabelSelected(100, 100);
    expect(store.selectedElement?.x).toBeUndefined();
  });

  it('resizeSelected 最小 5mm', () => {
    store.loadDsl(baseDsl());
    store.setDevice('label');
    store.select(0);
    store.resizeSelected(10 * (96 / 25.4), -10000);
    expect(store.selectedElement?.width).toBe('20mm');
    expect(store.selectedElement?.height).toBe('5mm');
  });

  it('moveLabelSelected 上界钳制在纸面−元素尺寸', () => {
    store.loadDsl(baseDsl()); // label 40×30mm，元素 x2 y3 w10 h10
    store.setDevice('label');
    store.select(0);
    store.moveLabelSelected(100000, 100000);
    expect(store.selectedElement?.x).toBe('30mm');
    expect(store.selectedElement?.y).toBe('20mm');
  });

  it('resizeSelected 上界钳制在纸面−位置', () => {
    store.loadDsl(baseDsl());
    store.setDevice('label');
    store.select(0);
    store.resizeSelected(100000, 100000);
    expect(store.selectedElement?.width).toBe('38mm');
    expect(store.selectedElement?.height).toBe('27mm');
  });

  it('firstDetailSource 返回首个 detail 数据源', () => {
    store.loadDsl(baseDsl());
    expect(store.firstDetailSource).toBe('items');
  });

  it('elementLibrary 覆盖核心元素类型且 label 设备补绝对坐标', () => {
    expect(elementLibrary.map((i) => i.type)).toEqual([
      'text',
      'image',
      'barcode',
      'qrcode',
      'table',
      'kvtable',
      'line',
      'box',
      'loop',
      'conditional',
    ]);
    // T2 收口：label 模式暴露面＝六元素（table/kvtable 收进 doc/receipt 门禁）
    const labelVisible = elementLibrary.filter(
      (i) => !i.devices || (i.devices as string[]).includes('label'),
    );
    expect(labelVisible.map((i) => i.type)).toEqual([
      'text',
      'image',
      'barcode',
      'qrcode',
      'line',
      'box',
    ]);
    const text = elementLibrary[0].create('label', 2);
    expect(text.x).toBe('5mm');
    expect(text.y).toBe('29mm');
    const textDoc = elementLibrary[0].create('doc', 2);
    expect(textDoc.x).toBeUndefined();
    const table = elementLibrary[4].create('doc', 0, 'items');
    expect(table.source).toBe('items');
    // 专项步骤 4：loop/conditional 仅 doc 门禁，默认容器结构完整
    const loop = elementLibrary.find((i) => i.type === 'loop');
    expect(loop?.devices).toEqual(['doc']);
    expect(loop?.create('doc', 0, 'items').each).toBe('items');
    // T2：box 元素（schema v1.1 同构）label 补绝对坐标
    const box = elementLibrary.find((i) => i.type === 'box');
    expect(box?.create('label', 0).x).toBe('5mm');
    expect(box?.create('label', 0).thickness).toBe(2);
    const conditional = elementLibrary.find((i) => i.type === 'conditional');
    expect(conditional?.devices).toEqual(['doc']);
    expect(Array.isArray(conditional?.create('doc', 0).body)).toBe(true);
  });
});

describe('parseLengthMm', () => {
  it('mm/cm/pt/px 换算为 mm', () => {
    expect(parseLengthMm('10mm')).toBe(10);
    expect(parseLengthMm('2.5cm')).toBe(25);
    expect(parseLengthMm('72pt')).toBeCloseTo(25.4, 5);
    expect(parseLengthMm('96px')).toBeCloseTo(25.4, 5);
  });

  it('非法/不支持格式返回 0（% 无几何参照物）', () => {
    expect(parseLengthMm('50%')).toBe(0);
    expect(parseLengthMm('-5mm')).toBe(0);
    expect(parseLengthMm('abc')).toBe(0);
    expect(parseLengthMm(undefined)).toBe(0);
  });
});
