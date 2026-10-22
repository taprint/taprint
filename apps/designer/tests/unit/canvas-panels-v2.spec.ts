// SPDX-License-Identifier: Apache-2.0
// 专项步骤 4（块 C）：属性面板 v2 编辑器——列/多级表头/分组/自由行编辑写回 DSL，
// 容器分区 each/when + body 子元素最小编辑，校验错误就近展示。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PropertyPanel from '../../src/canvas/panels/PropertyPanel.vue';
import { useDesignerStore, type TemplateLike } from '../../src/canvas/store';
import type { HeaderCellV2, StaticRowsV2, TableColumn, TableGroupV2 } from '../../src/canvas/types';

vi.mock('interactjs', () => ({ default: vi.fn() }));

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const inventory = (): TemplateLike =>
  JSON.parse(
    readFileSync(resolve(repoRoot, 'fixtures/templates/inventory-report-v2.0.json'), 'utf8'),
  ) as TemplateLike;

function mountPanel() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(PropertyPanel, { global: { plugins: [pinia] } });
  return { wrapper, store: useDesignerStore() };
}

async function mountTablePanel() {
  const ctx = mountPanel();
  ctx.store.loadTemplate(inventory());
  ctx.store.select(1); // body[1] 为 8 列 table
  await ctx.wrapper.vm.$nextTick();
  return ctx;
}

async function setInput(wrapper: VueWrapper, testid: string, value: string): Promise<void> {
  const input = wrapper.find(`[data-testid="${testid}"]`);
  (input.element as HTMLInputElement).value = value;
  await input.trigger('change');
}

/** 选中 table 的 DSL 节点（写回断言用） */
function tableOf(store: ReturnType<typeof useDesignerStore>) {
  return store.activeBody[1] as {
    columns: TableColumn[];
    headerRows: HeaderCellV2[][];
    groups: TableGroupV2[];
    staticRows: StaticRowsV2;
    layout?: { repeatHeaderOnPageBreak?: boolean };
  };
}

describe('表格列编辑器', () => {
  // column-row 计数含子列编辑器行：顶层 8 + 批次子表 3 = 11（子列复用同一组件）
  it('渲染 8 列 + 编辑 header/field 整体替换写回', async () => {
    const { wrapper, store } = await mountTablePanel();
    expect(wrapper.findAll('[data-testid="column-row"]')).toHaveLength(11);
    await setInput(wrapper, 'column-header-input-0', '类目');
    expect(tableOf(store).columns[0].header).toBe('类目');
    await setInput(wrapper, 'column-field-input-0', 'cat');
    expect(tableOf(store).columns[0].field).toBe('cat');
  });

  it('增删列（顶层编辑器为 DOM 最后一个 column-add）', async () => {
    const { wrapper, store } = await mountTablePanel();
    const addButtons = wrapper.findAll('[data-testid="column-add"]');
    await addButtons[addButtons.length - 1].trigger('click');
    expect(tableOf(store).columns).toHaveLength(9);
    await wrapper.find('[data-testid="column-remove-8"]').trigger('click');
    expect(tableOf(store).columns).toHaveLength(8);
  });

  it('子表编辑：source 仅列 detail 源，子列复用编辑器', async () => {
    const { wrapper, store } = await mountTablePanel();
    const sourceSelect = wrapper.find('[data-testid="subtable-source-7"]');
    expect(sourceSelect.exists()).toBe(true);
    const options = sourceSelect.findAll('option').map((o) => o.element.value);
    expect(options).toEqual(['', 'items', 'batches']); // 不含 primary 源 main
    expect(wrapper.find('[data-testid="subtable-toggle-7"]').text()).toContain('batches');
    // 子列编辑器渲染 3 列（批号/数量/效期）
    await wrapper.find('[data-testid="column-remove-7"]').trigger('click');
    expect(tableOf(store).columns).toHaveLength(7);
  });
});

describe('多级表头编辑器', () => {
  it('两行表头可编辑文字/跨度，写回 headerRows', async () => {
    const { wrapper, store } = await mountTablePanel();
    const text = wrapper.find<HTMLInputElement>('[data-testid="header-cell-text-0-1"]');
    expect(text.element.value).toBe('商品');
    await setInput(wrapper, 'header-cell-text-0-1', '商品信息');
    expect(tableOf(store).headerRows[0][1].text).toBe('商品信息');
    await setInput(wrapper, 'header-cell-colspan-0-1', '3');
    expect(tableOf(store).headerRows[0][1].colspan).toBe(3);
  });

  it('diagonal 切换：清除时连带移除 diagonalLabels（schema if/then）', async () => {
    const { wrapper, store } = await mountTablePanel();
    expect(tableOf(store).headerRows[0][0].diagonal).toBe('ltr');
    expect(wrapper.find('[data-testid="header-corner-tl-0-0"]').exists()).toBe(true);
    await wrapper.find<HTMLSelectElement>('[data-testid="header-cell-diagonal-0-0"]').setValue('');
    const cell = tableOf(store).headerRows[0][0];
    expect(cell.diagonal).toBeUndefined();
    expect(cell.diagonalLabels).toBeUndefined();
  });

  it('v1 表格无 headerRows：提供按列数初始化入口', async () => {
    const { wrapper, store } = mountPanel();
    store.loadDsl({
      schemaVersion: '1.0',
      id: 't',
      code: 'T',
      name: 't',
      presentations: {
        doc: {
          body: [
            {
              type: 'table',
              source: 'items',
              columns: [
                { header: 'a', field: 'a' },
                { header: 'b', field: 'b' },
              ],
            },
          ],
        },
      },
    });
    store.select(0);
    await wrapper.vm.$nextTick();
    await wrapper.find('[data-testid="prop-header-rows-create"]').trigger('click');
    const el = store.activeBody[0] as { headerRows: HeaderCellV2[][] };
    expect(el.headerRows).toHaveLength(1);
    expect(el.headerRows[0]).toHaveLength(2);
  });
});

describe('分组小计编辑器', () => {
  it('values 按列数渲染等长输入，「对齐到列数」一键修复', async () => {
    const { wrapper, store } = await mountTablePanel();
    // 8 列 → 8 个 values 输入
    expect(wrapper.findAll('[data-testid^="group-value-0-"]')).toHaveLength(8);
    // 构造长度错误后就近红条 + 一键修复
    tableOf(store).groups[0].subtotal!.values.pop();
    store.revalidate();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="inline-error-subtotal-length"]').exists()).toBe(true);
    await wrapper.find('[data-testid="group-align-0"]').trigger('click');
    expect(tableOf(store).groups[0].subtotal!.values).toHaveLength(8);
    expect(wrapper.find('[data-testid="inline-error-subtotal-length"]').exists()).toBe(false);
  });

  it('空输入写 null，非空保留原文', async () => {
    const { wrapper, store } = await mountTablePanel();
    await setInput(wrapper, 'group-value-0-3', '');
    expect(tableOf(store).groups[0].subtotal!.values[3]).toBeNull();
    await setInput(wrapper, 'group-value-0-3', '{{x}}');
    expect(tableOf(store).groups[0].subtotal!.values[3]).toBe('{{x}}');
  });
});

describe('自由合并行编辑器', () => {
  it('渲染 position/行/格，colspan 编辑写回', async () => {
    const { wrapper, store } = await mountTablePanel();
    expect(wrapper.find<HTMLSelectElement>('[data-testid="static-position"]').element.value).toBe(
      'after',
    );
    const value = wrapper.find<HTMLInputElement>('[data-testid="static-cell-value-0-0"]');
    expect(value.element.value).toContain('制单');
    await setInput(wrapper, 'static-cell-colspan-0-0', '4');
    expect(tableOf(store).staticRows.rows[0][0].colspan).toBe(4);
  });

  it('colspan 合计越界：就近展示 static-row-span-mismatch', async () => {
    const { wrapper } = await mountTablePanel();
    // 3+3+2=8 → 4+3+2=9 越界
    await setInput(wrapper, 'static-cell-colspan-0-0', '4');
    expect(wrapper.find('[data-testid="inline-error-static-span"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="inline-error-static-span"]').text()).toContain(
      'static-row-span-mismatch',
    );
  });

  it('多级表头跨度越界就近展示 header-cell-span-mismatch', async () => {
    const { wrapper } = await mountTablePanel();
    // 商品 colspan 2→4：首行跨度合计 10 > 8 列
    await setInput(wrapper, 'header-cell-colspan-0-1', '4');
    expect(wrapper.find('[data-testid="inline-error-header-span"]').exists()).toBe(true);
  });
});

describe('容器属性分区', () => {
  it('loop：each 下拉仅 detail 源，改选写回', async () => {
    const { wrapper, store } = mountPanel();
    store.loadTemplate(inventory());
    store.select(3); // loop each=batches
    await wrapper.vm.$nextTick();
    const select = wrapper.find<HTMLSelectElement>('[data-testid="container-each"]');
    expect(select.element.value).toBe('batches');
    const options = select.findAll('option').map((o) => o.element.value);
    expect(options).not.toContain('main');
    await select.setValue('items');
    expect((store.activeBody[3] as { each: string }).each).toBe('items');
    expect(wrapper.find('[data-testid="inline-error-loop-each"]').exists()).toBe(false);
  });

  it('loop.each 指向非 detail 源：就近展示 loop-each-not-detail', async () => {
    const { wrapper, store } = mountPanel();
    store.loadTemplate(inventory());
    store.select(3);
    store.updateSelected({ each: 'main' });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="inline-error-loop-each"]').exists()).toBe(true);
  });

  it('loop body 子元素最小编辑：编辑/添加/删除/移动', async () => {
    const { wrapper, store } = mountPanel();
    store.loadTemplate(inventory());
    store.select(3);
    await wrapper.vm.$nextTick();
    await setInput(wrapper, 'container-body-content-0', '新内容');
    expect((store.activeBody[3] as { body: Array<{ content: string }> }).body[0].content).toBe(
      '新内容',
    );
    await wrapper.find('[data-testid="container-body-add-line"]').trigger('click');
    let body = (store.activeBody[3] as { body: Array<{ type: string }> }).body;
    expect(body).toHaveLength(2);
    await wrapper.find('[data-testid="container-body-up-1"]').trigger('click');
    body = (store.activeBody[3] as { body: Array<{ type: string }> }).body;
    expect(body[0].type).toBe('line');
    await wrapper.find('[data-testid="container-body-remove-0"]').trigger('click');
    expect((store.activeBody[3] as { body: unknown[] }).body).toHaveLength(1);
  });

  it('conditional：when 编辑 + body/elseBody 双支编辑区', async () => {
    const { wrapper, store } = mountPanel();
    store.loadTemplate(inventory());
    store.select(2); // conditional
    await wrapper.vm.$nextTick();
    const when = wrapper.find<HTMLInputElement>('[data-testid="container-when"]');
    expect(when.element.value).toBe('{{diffTotal}} > 0');
    await setInput(wrapper, 'container-when', '{{diffTotal}} >= 0');
    expect((store.activeBody[2] as { when: string }).when).toBe('{{diffTotal}} >= 0');
    // elseBody 编辑区存在且含 1 个子元素
    expect(wrapper.find('[data-testid="container-elseBody-item-0"]').exists()).toBe(true);
    await setInput(wrapper, 'container-elseBody-content-0', '无差异');
    expect(
      (store.activeBody[2] as { elseBody: Array<{ content: string }> }).elseBody[0].content,
    ).toBe('无差异');
  });
});

describe('layout 复选框', () => {
  it('跨页重复表头勾选/取消写回 layout', async () => {
    const { wrapper, store } = await mountTablePanel();
    const box = wrapper.find<HTMLInputElement>('[data-testid="prop-repeat-header"]');
    expect(box.element.checked).toBe(true);
    await box.setValue(false);
    expect(tableOf(store).layout).toBeUndefined();
    await box.setValue(true);
    expect(tableOf(store).layout?.repeatHeaderOnPageBreak).toBe(true);
  });
});
