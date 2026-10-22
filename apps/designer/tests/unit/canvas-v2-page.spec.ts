// SPDX-License-Identifier: Apache-2.0
// 专项步骤 4（块 D）：doc 页级能力——水印覆盖层（text tile/image 占位）、
// nup 一页多单只读副本、PagePropsSection 编辑写回、ValidationStatus 状态条。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import DesignerCanvas from '../../src/canvas/DesignerCanvas.vue';
import DesignerWorkbench from '../../src/canvas/DesignerWorkbench.vue';
import PropertyPanel from '../../src/canvas/panels/PropertyPanel.vue';
import ValidationStatus from '../../src/canvas/panels/ValidationStatus.vue';
import { useDesignerStore, type TemplateLike } from '../../src/canvas/store';

vi.mock('interactjs', () => ({ default: vi.fn() }));

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const readFixture = (name: string): TemplateLike =>
  JSON.parse(readFileSync(resolve(repoRoot, `fixtures/templates/${name}`), 'utf8')) as TemplateLike;

function mountWith(component: Parameters<typeof mount>[0]) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(component, { global: { plugins: [pinia] } });
  return { wrapper, store: useDesignerStore() };
}

describe('水印渲染', () => {
  it('text 水印 + tile：12 枚平铺，opacity/angle 取自 DSL', async () => {
    const { wrapper, store } = mountWith(DesignerCanvas);
    store.loadTemplate(readFixture('inventory-report-v2.0.json'));
    await wrapper.vm.$nextTick();
    const overlay = wrapper.find('[data-testid="watermark-overlay"]');
    expect(overlay.exists()).toBe(true);
    const texts = wrapper.findAll('[data-testid="watermark-text"]');
    expect(texts).toHaveLength(12); // tile 平铺 3×4
    expect(texts[0].text()).toContain('内部资料 严禁外传');
    const style = texts[0].attributes('style') ?? '';
    expect(style).toContain('opacity: 0.12');
    expect(style).toContain('rotate(-30deg)');
    // 覆盖层不参与交互
    expect(overlay.classes().join(' ')).toContain('pointer-events-none');
  });

  it('image 水印含表达式：渲染占位不求值', async () => {
    const { wrapper, store } = mountWith(DesignerCanvas);
    store.loadTemplate(readFixture('coupon-sheet-v2.0.json'));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="watermark-placeholder"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="watermark-image"]').exists()).toBe(false);
  });
});

describe('nup 一页多单', () => {
  it('coupon 2×2：chip + 3 份只读副本，可编辑主体仍在', async () => {
    const { wrapper, store } = mountWith(DesignerCanvas);
    store.loadTemplate(readFixture('coupon-sheet-v2.0.json'));
    await wrapper.vm.$nextTick();
    const chip = wrapper.find('[data-testid="nup-chip"]');
    expect(chip.exists()).toBe(true);
    expect(chip.text()).toContain('2×2');
    expect(wrapper.findAll('[data-testid="nup-copy"]')).toHaveLength(3);
    // 首个单元仍可编辑（canvas-element 存在且可点击选中）
    await wrapper.find('[data-testid="canvas-element"]').trigger('click');
    expect(store.selectedIndex).toBe(0);
  });

  it('无 nup 时无 chip 无副本（inventory）', async () => {
    const { wrapper, store } = mountWith(DesignerCanvas);
    store.loadTemplate(readFixture('inventory-report-v2.0.json'));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="nup-chip"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="nup-copy"]').exists()).toBe(false);
  });
});

describe('PagePropsSection（未选中元素时渲染）', () => {
  async function mountPageProps() {
    const ctx = mountWith(PropertyPanel);
    ctx.store.loadTemplate(readFixture('inventory-report-v2.0.json'));
    await ctx.wrapper.vm.$nextTick();
    return ctx;
  }

  function pageOf(store: ReturnType<typeof useDesignerStore>) {
    return (store.activePresentation?.page ?? {}) as Record<string, unknown>;
  }

  it('水印编辑：文字/透明度/角度/平铺写回 page.watermark', async () => {
    const { wrapper, store } = await mountPageProps();
    expect(wrapper.find('[data-testid="page-props"]').exists()).toBe(true);
    const text = wrapper.find<HTMLInputElement>('[data-testid="page-watermark-text"]');
    expect(text.element.value).toBe('内部资料 严禁外传');
    (text.element as HTMLInputElement).value = '草稿';
    await text.trigger('change');
    expect((pageOf(store).watermark as { text: string }).text).toBe('草稿');

    const opacity = wrapper.find<HTMLInputElement>('[data-testid="page-watermark-opacity"]');
    (opacity.element as HTMLInputElement).value = '0.3';
    await opacity.trigger('change');
    expect((pageOf(store).watermark as { opacity: number }).opacity).toBe(0.3);

    await wrapper.find('[data-testid="page-watermark-tile"]').setValue(false);
    // 取消勾选收敛为删键（与其他可选键一致），而非写 false
    expect((pageOf(store).watermark as { tile?: boolean }).tile).toBeUndefined();
  });

  it('水印 type 切换互斥：text→image 移除 text 字段', async () => {
    const { wrapper, store } = await mountPageProps();
    await wrapper.find<HTMLSelectElement>('[data-testid="page-watermark-type"]').setValue('image');
    const wm = pageOf(store).watermark as { type: string; text?: string; src?: string };
    expect(wm.type).toBe('image');
    expect(wm.text).toBeUndefined();
    expect(wm.src).toBe('');
    expect(wrapper.find('[data-testid="page-watermark-src"]').exists()).toBe(true);
  });

  it('水印移除 → 画布覆盖层消失', async () => {
    const { wrapper, store } = await mountPageProps();
    await wrapper.find('[data-testid="page-watermark-remove"]').trigger('click');
    expect(pageOf(store).watermark).toBeUndefined();
  });

  it('nup 添加/钳制/移除', async () => {
    const { wrapper, store } = await mountPageProps();
    expect(wrapper.find('[data-testid="page-nup-add"]').exists()).toBe(true);
    await wrapper.find('[data-testid="page-nup-add"]').trigger('click');
    expect(pageOf(store).nup).toEqual({ cols: 2, rows: 2 });
    const cols = wrapper.find<HTMLInputElement>('[data-testid="page-nup-cols"]');
    (cols.element as HTMLInputElement).value = '9';
    await cols.trigger('change');
    expect((pageOf(store).nup as { cols: number }).cols).toBe(4); // 钳制 1-4
    await wrapper.find('[data-testid="page-nup-remove"]').trigger('click');
    expect(pageOf(store).nup).toBeUndefined();
  });
});

describe('ValidationStatus 状态条', () => {
  it('合法模板：绿色通过态', async () => {
    const { wrapper, store } = mountWith(ValidationStatus);
    store.loadTemplate(readFixture('inventory-report-v2.0.json'));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('校验通过');
    expect(wrapper.find('[data-testid="validation-error-list"]').exists()).toBe(false);
  });

  it('制造错误：红色计数 + 展开列表含 code 徽标与指引', async () => {
    const { wrapper, store } = mountWith(ValidationStatus);
    store.loadTemplate(readFixture('inventory-report-v2.0.json'));
    store.select(1);
    store.updateSelected({ source: 'nope' }); // table-source-unknown
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('校验错误');
    await wrapper.find('[data-testid="validation-toggle"]').trigger('click');
    const items = wrapper.findAll('[data-testid="validation-error-item"]');
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.text().includes('table-source-unknown'))).toBe(true);
    expect(wrapper.text()).toContain('dataSources 不匹配'); // V2_ERROR_HINTS 指引
  });
});

describe('Workbench 保存门禁', () => {
  it('校验失败时点击保存：prepareSave 拦截并强制展开错误列表', async () => {
    const { wrapper, store } = mountWith(DesignerWorkbench);
    store.loadTemplate(readFixture('inventory-report-v2.0.json'));
    store.select(1);
    store.updateSelected({ source: 'nope' }); // table-source-unknown
    await wrapper.vm.$nextTick();
    const btn = wrapper.find('[data-testid="save-button"]');
    expect(btn.attributes('aria-disabled')).toBe('true');
    await btn.trigger('click');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="validation-error-list"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="save-note"]').exists()).toBe(false);
  });

  it('校验通过时点击保存：显示保存提示', async () => {
    const { wrapper, store } = mountWith(DesignerWorkbench);
    store.loadTemplate(readFixture('inventory-report-v2.0.json'));
    await wrapper.vm.$nextTick();
    await wrapper.find('[data-testid="save-button"]').trigger('click');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="save-note"]').text()).toContain('校验通过');
  });
});
