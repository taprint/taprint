// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import DesignerCanvas from '../../src/canvas/DesignerCanvas.vue';
import CanvasElementHost from '../../src/canvas/CanvasElementHost.vue';
import BarcodeElement from '../../src/canvas/elements/BarcodeElement.vue';
import TextElement from '../../src/canvas/elements/TextElement.vue';
import { useDesignerStore, type TemplateLike } from '../../src/canvas/store';
import { sampleTemplate } from '../../src/canvas/samples/sales-note';

// interactjs 打桩：P3 回归以 interact()/unset() 调用计数断言 interactable 生命周期
// （真实 interact 的 isSet 在 jsdom 下不可靠）
const interactSpy = vi.hoisted(() => {
  const unset = vi.fn();
  const interact = vi.fn(() => ({
    draggable: () => ({ resizable: () => ({ unset }) }),
  }));
  return { interact, unset };
});
vi.mock('interactjs', () => ({ default: interactSpy.interact }));

// 三呈现覆盖的最小 DSL（doc/receipt/label）
const triDeviceDsl: TemplateLike = {
  schemaVersion: '1.0',
  id: 'test_tri_device',
  code: 'TEST_TRI_DEVICE',
  name: '三呈现测试',
  dataSources: [{ name: 'main', type: 'primary', schema: { billNo: 'string' } }],
  presentations: {
    doc: {
      page: { size: 'A4', margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' } },
      header: [{ type: 'text', content: '页眉' }],
      body: [
        { type: 'text', content: '正文 {{main.billNo}}' },
        { type: 'line', lineStyle: 'solid' },
      ],
      footer: [{ type: 'text', content: '页脚' }],
    },
    receipt: { width: '58mm', body: [{ type: 'text', content: '小票正文' }] },
    label: {
      size: { width: '40mm', height: '30mm' },
      body: [{ type: 'text', content: '标签', x: '5mm', y: '8mm', width: '20mm', height: '10mm' }],
    },
  },
};

function mountCanvas() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(DesignerCanvas, { global: { plugins: [pinia] } });
  return { wrapper, store: useDesignerStore() };
}

describe('DesignerCanvas', () => {
  it('未加载模板时显示空态', () => {
    const { wrapper } = mountCanvas();
    expect(wrapper.find('[data-testid="designer-canvas"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('未加载模板');
  });

  it('doc 呈现：页面 + header/body/footer 全量渲染', async () => {
    const { wrapper, store } = mountCanvas();
    store.loadDsl(triDeviceDsl);
    await wrapper.vm.$nextTick();
    expect(store.device).toBe('doc');
    const page = wrapper.find('[data-testid="canvas-doc-page"]');
    expect(page.exists()).toBe(true);
    // header 1 + body 2 + footer 1
    expect(wrapper.findAll('[data-testid="canvas-element"]')).toHaveLength(4);
    expect(wrapper.text()).toContain('正文');
  });

  it('receipt 呈现：按纸宽渲染 body', async () => {
    const { wrapper, store } = mountCanvas();
    store.loadDsl(triDeviceDsl);
    store.setDevice('receipt');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="canvas-receipt-page"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-testid="canvas-element"]')).toHaveLength(1);
  });

  it('label 呈现：绝对坐标定位', async () => {
    const { wrapper, store } = mountCanvas();
    store.loadDsl(triDeviceDsl);
    store.setDevice('label');
    await wrapper.vm.$nextTick();
    const page = wrapper.find('[data-testid="canvas-label-page"]');
    expect(page.exists()).toBe(true);
    const holder = page.element.firstElementChild as HTMLElement;
    expect(holder.style.position).toBe('absolute');
    // 5mm @96dpi ≈ 18.9px
    expect(Number.parseFloat(holder.style.left)).toBeCloseTo(18.9, 1);
    expect(Number.parseFloat(holder.style.top)).toBeCloseTo(30.2, 1);
  });

  it('点击元素选中，点击背景取消选中', async () => {
    const { wrapper, store } = mountCanvas();
    store.loadDsl(triDeviceDsl);
    await wrapper.vm.$nextTick();
    await wrapper.findAll('[data-testid="canvas-element"]')[1].trigger('click');
    expect(store.selectedIndex).toBe(0); // header 不可选中，body 从 index 0 起
    await wrapper.find('[data-testid="canvas-background"]').trigger('click');
    expect(store.selectedIndex).toBeNull();
  });

  it('label 页内空白点击清空选中，元素点击不受影响（三轮 M5）', async () => {
    const { wrapper, store } = mountCanvas();
    store.loadDsl(triDeviceDsl);
    store.setDevice('label');
    await wrapper.vm.$nextTick();
    await wrapper.find('[data-testid="canvas-element"]').trigger('click');
    expect(store.selectedIndex).toBe(0);
    await wrapper.find('[data-testid="canvas-label-page"]').trigger('click');
    expect(store.selectedIndex).toBeNull();
  });

  it('样例 fixture（sales-note）可加载并渲染 doc 呈现', async () => {
    const { wrapper, store } = mountCanvas();
    store.loadDsl(sampleTemplate);
    await wrapper.vm.$nextTick();
    const doc = sampleTemplate.presentations.doc as {
      body: unknown[];
      header?: unknown[];
      footer?: unknown[];
    };
    expect(store.device).toBe('doc');
    expect(wrapper.findAll('[data-testid="canvas-element"]')).toHaveLength(
      doc.body.length + (doc.header?.length ?? 0) + (doc.footer?.length ?? 0),
    );
  });
});

describe('DesignerCanvas 评审回归', () => {
  const deleteDsl: TemplateLike = {
    schemaVersion: '1.0',
    id: 'test_delete',
    code: 'TEST_DELETE',
    name: '删除回归',
    presentations: {
      doc: {
        body: [
          { type: 'text', content: 'a' },
          { type: 'barcode', content: '123' },
        ],
      },
    },
  };

  it('P1：删除首个元素后剩余宿主渲染的组件类型与 model.type 一致', async () => {
    const { wrapper, store } = mountCanvas();
    store.loadDsl(deleteDsl);
    await wrapper.vm.$nextTick();
    store.select(0);
    store.removeSelected();
    await wrapper.vm.$nextTick();
    expect(wrapper.findAllComponents(CanvasElementHost)).toHaveLength(1);
    expect(wrapper.findComponent(BarcodeElement).exists()).toBe(true);
    expect(wrapper.findComponent(TextElement).exists()).toBe(false);
    expect(wrapper.find('[data-testid="canvas-element"]').text()).toContain('123');
  });

  it('P2：元素可键盘选中（Enter/Space），并有 aria-label', async () => {
    const { wrapper, store } = mountCanvas();
    store.loadDsl(triDeviceDsl);
    await wrapper.vm.$nextTick();
    const el = wrapper.findAll('[data-testid="canvas-element"]')[1];
    expect(el.attributes('aria-label')).toContain('text');
    expect(el.attributes('tabindex')).toBe('0');
    await el.trigger('keydown.enter');
    expect(store.selectedIndex).toBe(0);
    expect(el.attributes('aria-pressed')).toBe('true');
  });

  it('P3：label 呈现仅选中元素创建 interactable，未选中零开销', async () => {
    interactSpy.interact.mockClear();
    interactSpy.unset.mockClear();
    const { wrapper, store } = mountCanvas();
    store.loadDsl({
      schemaVersion: '1.0',
      id: 'test_label_interact',
      code: 'TEST_LABEL_INTERACT',
      name: 'interact 守卫',
      presentations: {
        label: {
          size: { width: '40mm', height: '30mm' },
          body: [
            { type: 'text', content: 'a', x: '2mm', y: '2mm', width: '10mm', height: '5mm' },
            { type: 'text', content: 'b', x: '15mm', y: '15mm', width: '10mm', height: '5mm' },
          ],
        },
      },
    });
    await wrapper.vm.$nextTick();
    expect(interactSpy.interact).not.toHaveBeenCalled(); // 未选中时零开销
    await wrapper.find('[data-testid="canvas-element"]').trigger('click');
    await wrapper.vm.$nextTick();
    expect(interactSpy.interact).toHaveBeenCalledTimes(1); // 仅选中者创建
    store.clearSelection();
    await wrapper.vm.$nextTick();
    expect(interactSpy.unset).toHaveBeenCalledTimes(1); // 取消选中即回收
  });
});
