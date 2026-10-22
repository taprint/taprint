// SPDX-License-Identifier: Apache-2.0
// 专项步骤 4（块 B）：DSL 2.0 容器渲染与入口门禁——loop 渲一轮 body + chip，
// conditional 渲双支（body + 灰化 elseBody），元素库 devices 门禁（doc 可见、label 隐藏），
// 图层面板摘要 each/when。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import DesignerCanvas from '../../src/canvas/DesignerCanvas.vue';
import FieldPanel from '../../src/canvas/panels/FieldPanel.vue';
import LayersPanel from '../../src/canvas/panels/LayersPanel.vue';
import { useDesignerStore, type TemplateLike } from '../../src/canvas/store';

vi.mock('interactjs', () => ({ default: vi.fn() }));

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const inventory = (): TemplateLike =>
  JSON.parse(
    readFileSync(resolve(repoRoot, 'fixtures/templates/inventory-report-v2.0.json'), 'utf8'),
  ) as TemplateLike;

function mountWith(component: Parameters<typeof mount>[0]) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(component, { global: { plugins: [pinia] } });
  return { wrapper, store: useDesignerStore() };
}

async function mountInventoryCanvas() {
  const ctx = mountWith(DesignerCanvas);
  ctx.store.loadTemplate(inventory());
  await ctx.wrapper.vm.$nextTick();
  return ctx;
}

describe('loop 容器', () => {
  it('chip 含 each 源，body 只读渲一轮', async () => {
    const { wrapper } = await mountInventoryCanvas();
    const chip = wrapper.find('[data-testid="loop-chip"]');
    expect(chip.exists()).toBe(true);
    expect(chip.text()).toContain('each=batches');
    // body 渲一轮（占位表达式不求值，结构保真）
    expect(wrapper.text()).toContain('批次 {{batchNo}}');
  });

  it('容器子元素不进顶层宿主：canvas-element 总数仍为 7', async () => {
    const { wrapper } = await mountInventoryCanvas();
    expect(wrapper.findAll('[data-testid="canvas-element"]')).toHaveLength(7);
  });
});

describe('conditional 容器', () => {
  it('chip 含 when 表达式，双支渲染（elseBody 灰化「否则」）', async () => {
    const { wrapper } = await mountInventoryCanvas();
    const chip = wrapper.find('[data-testid="conditional-chip"]');
    expect(chip.exists()).toBe(true);
    expect(chip.text()).toContain('when={{diffTotal}} > 0');
    expect(wrapper.text()).toContain('本次盘点存在差异');
    const elseBranch = wrapper.find('[data-testid="conditional-else"]');
    expect(elseBranch.exists()).toBe(true);
    expect(elseBranch.text()).toContain('否则');
    expect(elseBranch.text()).toContain('本次盘点账实相符。');
  });
});

describe('元素库 devices 门禁', () => {
  const triDsl: TemplateLike = {
    schemaVersion: '1.0',
    id: 'test_container_gate',
    code: 'TEST_CONTAINER_GATE',
    name: '容器门禁',
    dataSources: [
      { name: 'main', type: 'primary', schema: { billNo: 'string' } },
      { name: 'items', type: 'detail', schema: { name: 'string' } },
    ],
    presentations: {
      doc: { body: [{ type: 'text', content: '正文' }] },
      label: {
        size: { width: '40mm', height: '30mm' },
        body: [{ type: 'text', content: '标签', x: '2mm', y: '2mm' }],
      },
    },
  };

  it('doc 下 loop/conditional 按钮可见，点击插入默认容器', async () => {
    const { wrapper, store } = mountWith(FieldPanel);
    store.loadDsl(triDsl);
    await wrapper.vm.$nextTick();
    const loopBtn = wrapper.find('[data-testid="element-add-loop"]');
    const condBtn = wrapper.find('[data-testid="element-add-conditional"]');
    expect(loopBtn.exists()).toBe(true);
    expect(condBtn.exists()).toBe(true);
    await loopBtn.trigger('click');
    const loop = store.activeBody.at(-1);
    expect(loop?.type).toBe('loop');
    expect(loop?.each).toBe('items'); // 取首个 detail 源
    expect(Array.isArray(loop?.body)).toBe(true);
    await condBtn.trigger('click');
    const cond = store.activeBody.at(-1);
    expect(cond?.type).toBe('conditional');
    expect(Array.isArray(cond?.elseBody)).toBe(true);
  });

  it('label 下容器按钮隐藏', async () => {
    const { wrapper, store } = mountWith(FieldPanel);
    store.loadDsl(triDsl);
    store.setDevice('label');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="element-add-loop"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="element-add-conditional"]').exists()).toBe(false);
    // 基础元素仍可见
    expect(wrapper.find('[data-testid="element-add-text"]').exists()).toBe(true);
  });
});

describe('图层面板容器摘要', () => {
  it('loop/conditional 显示 each/when 语义而非 type 名', async () => {
    const { wrapper, store } = mountWith(LayersPanel);
    store.loadTemplate(inventory());
    await wrapper.vm.$nextTick();
    const text = wrapper.text();
    expect(text).toContain('循环：each=batches');
    expect(text).toContain('条件：when={{diffTotal}}');
  });
});
