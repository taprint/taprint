// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { Component } from 'vue';
import FieldPanel from '../../src/canvas/panels/FieldPanel.vue';
import LayersPanel from '../../src/canvas/panels/LayersPanel.vue';
import PropertyPanel from '../../src/canvas/panels/PropertyPanel.vue';
import DeviceSwitcher from '../../src/canvas/panels/DeviceSwitcher.vue';
import { useDesignerStore, type TemplateLike } from '../../src/canvas/store';

const dsl = (): TemplateLike => ({
  schemaVersion: '1.0',
  id: 'test_panels',
  code: 'TEST_PANELS',
  name: '面板测试',
  dataSources: [
    {
      name: 'main',
      type: 'primary',
      schema: { billNo: 'string', customer: { name: 'string', phone: 'string' } },
    },
    { name: 'items', type: 'detail', schema: { name: 'string', qty: 'number' } },
  ],
  presentations: {
    doc: { page: { size: 'A4' }, body: [{ type: 'text', content: 'a' }, { type: 'line' }] },
    receipt: { body: [{ type: 'text', content: 'r' }] },
    label: {
      size: { width: '40mm', height: '30mm' },
      body: [{ type: 'text', content: 'L', x: '5mm', y: '5mm' }],
    },
  },
});

function mountPanel(component: Component) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useDesignerStore();
  store.loadDsl(dsl());
  const wrapper = mount(component, { global: { plugins: [pinia] } });
  return { wrapper, store };
}

describe('FieldPanel', () => {
  it('展平嵌套字段为点路径', () => {
    const { wrapper } = mountPanel(FieldPanel);
    const texts = wrapper.findAll('[data-testid="field-item"]').map((n) => n.text());
    expect(texts).toContain('main.billNo');
    expect(texts).toContain('main.customer.name');
    expect(texts).toContain('items.qty');
  });

  it('点击字段插入 {{source.field}} 文本元素并选中', async () => {
    const { wrapper, store } = mountPanel(FieldPanel);
    await wrapper.findAll('[data-testid="field-item"]')[0].trigger('click');
    expect(store.activeBody).toHaveLength(3);
    expect(store.activeBody[2].content).toBe('{{main.billNo}}');
    expect(store.selectedIndex).toBe(2);
  });

  it('元素库按钮按当前设备创建元素', async () => {
    const { wrapper, store } = mountPanel(FieldPanel);
    await wrapper.find('[data-testid="element-add-table"]').trigger('click');
    expect(store.activeBody[2].type).toBe('table');
    expect(store.activeBody[2].source).toBe('items');
  });
});

describe('LayersPanel', () => {
  it('列出元素并支持选中/移动/删除', async () => {
    const { wrapper, store } = mountPanel(LayersPanel);
    expect(wrapper.findAll('li')).toHaveLength(2);
    await wrapper.find('[data-testid="layer-item-0"] button[aria-label="下移"]').trigger('click');
    expect(store.activeBody[0].type).toBe('line');
    expect(store.selectedIndex).toBe(1);
    await wrapper.find('[data-testid="layer-item-1"] button[aria-label="删除"]').trigger('click');
    expect(store.activeBody).toHaveLength(2); // 二次确认：首次点击仅进入确认态
    await wrapper
      .find('[data-testid="layer-item-1"] button[aria-label="确认删除"]')
      .trigger('click');
    expect(store.activeBody).toHaveLength(1);
  });
});

describe('PropertyPanel', () => {
  it('未选中时 doc 呈现页面属性分区，非 doc 显示空态（专项步骤 4 块 D）', async () => {
    const { wrapper, store } = mountPanel(PropertyPanel);
    expect(wrapper.find('[data-testid="page-props"]').exists()).toBe(true);
    store.setDevice('receipt');
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('未选中元素');
  });

  it('编辑文本内容/字号/粗体写回 DSL', async () => {
    const { wrapper, store } = mountPanel(PropertyPanel);
    store.select(0);
    await wrapper.vm.$nextTick();
    const content = wrapper.find('[data-testid="prop-content"]');
    expect((content.element as HTMLTextAreaElement).value).toBe('a');
    await content.setValue('hello {{main.billNo}}');
    expect(store.selectedElement?.content).toBe('hello {{main.billNo}}');
    await wrapper.find('[data-testid="prop-font-size"]').setValue(16);
    expect(store.selectedElement?.style?.fontSize).toBe(16);
    await wrapper.find('input[type="checkbox"]').setValue(true);
    expect(store.selectedElement?.style?.bold).toBe(true);
  });

  it('删除按钮二次确认后才移除选中元素', async () => {
    const { wrapper, store } = mountPanel(PropertyPanel);
    store.select(0);
    await wrapper.vm.$nextTick();
    const del = () => wrapper.find('[data-testid="prop-delete"]');
    await del().trigger('click');
    expect(store.activeBody).toHaveLength(2); // 首次点击仅进入确认态
    expect(del().text()).toBe('确认删除？');
    await del().trigger('click');
    expect(store.activeBody).toHaveLength(1);
  });
});

describe('DeviceSwitcher', () => {
  it('仅渲染模板具备的呈现并可切换', async () => {
    const { wrapper, store } = mountPanel(DeviceSwitcher);
    expect(wrapper.find('[data-testid="device-doc"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="device-label"]').exists()).toBe(true);
    await wrapper.find('[data-testid="device-receipt"]').trigger('click');
    expect(store.device).toBe('receipt');
  });
});

describe('PropertyPanel label 几何字段', () => {
  it('清空必填 x/y 回退 0mm，可选 width 清空才删键', async () => {
    const { wrapper, store } = mountPanel(PropertyPanel);
    store.setDevice('label');
    store.select(0);
    await wrapper.vm.$nextTick();
    await wrapper.find('[data-testid="prop-x"]').setValue('');
    expect(store.selectedElement?.x).toBe('0mm');
    expect('x' in (store.selectedElement as object)).toBe(true);
    await wrapper.find('[data-testid="prop-width"]').setValue('');
    expect('width' in (store.selectedElement as object)).toBe(false);
  });

  it('非法单位格式拒写（不会把元素打成 0）', async () => {
    const { wrapper, store } = mountPanel(PropertyPanel);
    store.setDevice('label');
    store.select(0);
    await wrapper.vm.$nextTick();
    await wrapper.find('[data-testid="prop-x"]').setValue('abc');
    expect(store.selectedElement?.x).toBe('5mm');
    await wrapper.find('[data-testid="prop-x"]').setValue('50%');
    expect(store.selectedElement?.x).toBe('5mm');
    await wrapper.find('[data-testid="prop-x"]').setValue('1.5cm');
    expect(store.selectedElement?.x).toBe('1.5cm');
  });
});

describe('LayersPanel label 模式', () => {
  it('label 呈现隐藏上/下移（顺序无布局语义），保留删除', async () => {
    const { wrapper, store } = mountPanel(LayersPanel);
    expect(wrapper.find('button[aria-label="上移"]').exists()).toBe(true);
    store.setDevice('label');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('button[aria-label="上移"]').exists()).toBe(false);
    expect(wrapper.find('button[aria-label="下移"]').exists()).toBe(false);
    expect(wrapper.find('button[aria-label="删除"]').exists()).toBe(true);
  });
});

// ── readOnly 完整编辑锁——fieldset[disabled] 视觉灰态 + 交互拦截 ──
// 注：jsdom 不完整实现「fieldset[disabled] 自动 propagate 到子 form element 的 disabled
// 属性」语义（实际浏览器按 HTML 标准执行）；单测层只断言 fieldset 自身的 disabled 状态 +
// data-readonly 标记 + store self-guard；子按钮在实浏览器中的 disabled 视觉/交互拦截
// 由 e2e host-comm.spec.ts 「只读锁可见性」用例在 playwright 实浏览器中验证。
describe('readOnly 完整编辑锁', () => {
  it('FieldPanel readOnly=true 时根 fieldset[data-readonly=true] + disabled', async () => {
    const { wrapper, store } = mountPanel(FieldPanel);
    const fs = wrapper.find('fieldset.embed-readonly-lock');
    expect(fs.exists()).toBe(true);
    expect(fs.element.getAttribute('data-readonly')).toBe('false');
    expect((fs.element as HTMLFieldSetElement).disabled).toBe(false);

    store.setReadOnly(true);
    await wrapper.vm.$nextTick();
    expect(fs.element.getAttribute('data-readonly')).toBe('true');
    expect((fs.element as HTMLFieldSetElement).disabled).toBe(true);

    // readOnly 下点击字段/元素按钮无副作用（store.addElement self-guard）
    const fieldBtn = wrapper.findAll('[data-testid="field-item"]')[0];
    await fieldBtn.trigger('click');
    const elementBtn = wrapper.find('[data-testid="element-add-table"]');
    await elementBtn.trigger('click');
    expect(store.activeBody).toHaveLength(2);
  });

  it('LayersPanel readOnly=true 时根 fieldset[data-readonly=true] + disabled', async () => {
    const { wrapper, store } = mountPanel(LayersPanel);
    const fs = wrapper.find('fieldset.embed-readonly-lock');
    expect(fs.exists()).toBe(true);
    expect((fs.element as HTMLFieldSetElement).disabled).toBe(false);
    store.setReadOnly(true);
    await wrapper.vm.$nextTick();
    expect(fs.element.getAttribute('data-readonly')).toBe('true');
    expect((fs.element as HTMLFieldSetElement).disabled).toBe(true);
    // store.select self-guard：直接调 store 也不生效
    store.select(0);
    expect(store.selectedIndex).toBeNull();
  });

  it('PropertyPanel readOnly=true 时根 fieldset[data-readonly=true] + disabled', async () => {
    const { wrapper, store } = mountPanel(PropertyPanel);
    store.select(0);
    await wrapper.vm.$nextTick();
    const fs = wrapper.find('fieldset.embed-readonly-lock');
    expect(fs.exists()).toBe(true);
    expect((fs.element as HTMLFieldSetElement).disabled).toBe(false);

    store.setReadOnly(true);
    await wrapper.vm.$nextTick();
    expect(fs.element.getAttribute('data-readonly')).toBe('true');
    expect((fs.element as HTMLFieldSetElement).disabled).toBe(true);
    // store.removeSelected self-guard：直接调 store 也不生效
    const beforeLen = store.activeBody.length;
    store.removeSelected();
    expect(store.activeBody.length).toBe(beforeLen);
  });

  it('解除只读后 fieldset disabled 复位（状态切换可逆）', async () => {
    const { wrapper, store } = mountPanel(FieldPanel);
    const fs = wrapper.find('fieldset.embed-readonly-lock');
    store.setReadOnly(true);
    await wrapper.vm.$nextTick();
    expect((fs.element as HTMLFieldSetElement).disabled).toBe(true);
    store.setReadOnly(false);
    await wrapper.vm.$nextTick();
    expect((fs.element as HTMLFieldSetElement).disabled).toBe(false);
    // 解除后点击字段按钮可正常添加（store.select/addElement 恢复）
    const fieldBtn = wrapper.findAll('[data-testid="field-item"]')[0];
    await fieldBtn.trigger('click');
    expect(store.activeBody).toHaveLength(3);
  });
});
