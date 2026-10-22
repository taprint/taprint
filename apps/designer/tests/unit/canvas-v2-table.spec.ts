// SPDX-License-Identifier: Apache-2.0
// 专项步骤 4（块 B）：画布 v2 表格渲染——加载 inventory-report 锚点 fixture，
// 逐能力断言：多级表头/斜线表头/分组小计/staticRows/主从子表/summary/跨页徽标，
// 以及 v1.0 单行表头回退与 subtotal 长度不匹配的就近红条。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import DesignerCanvas from '../../src/canvas/DesignerCanvas.vue';
import { useDesignerStore, type TemplateLike } from '../../src/canvas/store';

vi.mock('interactjs', () => ({ default: vi.fn() }));

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const inventory = (): TemplateLike =>
  JSON.parse(
    readFileSync(resolve(repoRoot, 'fixtures/templates/inventory-report-v2.0.json'), 'utf8'),
  ) as TemplateLike;

function mountCanvas() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const wrapper = mount(DesignerCanvas, { global: { plugins: [pinia] } });
  return { wrapper, store: useDesignerStore() };
}

async function mountInventory() {
  const ctx = mountCanvas();
  ctx.store.loadTemplate(inventory());
  await ctx.wrapper.vm.$nextTick();
  return ctx;
}

describe('v2 表格渲染（inventory-report 锚点）', () => {
  it('加载后 doc 呈现全量元素（header 2 + body 4 + footer 1）', async () => {
    const { wrapper, store } = await mountInventory();
    expect(store.device).toBe('doc');
    expect(wrapper.findAll('[data-testid="canvas-element"]')).toHaveLength(7);
  });

  it('多级表头：headerRows 两行真实网格，跨行/跨列跨度保真', async () => {
    const { wrapper } = await mountInventory();
    const rows = wrapper.findAll('[data-testid="table-header-row"]');
    expect(rows).toHaveLength(2);
    // 首行 6 个逻辑格：斜线格(rowspan2) + 商品(colspan2) + 账面(colspan2) + 实盘 + 差异 + 批次
    const firstCells = rows[0].findAll('th');
    expect(firstCells).toHaveLength(6);
    expect(firstCells[0].attributes('rowspan')).toBe('2');
    expect(firstCells[1].attributes('colspan')).toBe('2');
    expect(firstCells[1].text()).toContain('商品');
    expect(firstCells[2].attributes('colspan')).toBe('2');
    // 次行仅 4 个子列格
    expect(rows[1].findAll('th')).toHaveLength(4);
    expect(rows[1].text()).toContain('编码');
  });

  it('斜线表头：ltr 斜线 + tl/br 角标', async () => {
    const { wrapper } = await mountInventory();
    expect(wrapper.find('[data-testid="diagonal-label-tl"]').text()).toBe('项目');
    expect(wrapper.find('[data-testid="diagonal-label-br"]').text()).toBe('类别');
    // rtl 角标不应出现
    expect(wrapper.find('[data-testid="diagonal-label-tr"]').exists()).toBe(false);
    expect(wrapper.find('svg line').exists()).toBe(true);
  });

  it('分组小计：组头行 + 小计行逐列对齐（null 留空，首列标签）', async () => {
    const { wrapper } = await mountInventory();
    const groupHeader = wrapper.find('[data-testid="table-group-header"]');
    expect(groupHeader.text()).toContain('类别：{{category}}');
    const subtotal = wrapper.find('[data-testid="table-group-subtotal"]');
    const cells = subtotal.findAll('td');
    expect(cells).toHaveLength(8); // 与 8 列对齐
    expect(cells[0].text()).toContain('小计');
    expect(cells[3].text()).toContain("{{items | sum:'bookQty'}}");
  });

  it('staticRows（position=after）：自由合并行结构保真', async () => {
    const { wrapper } = await mountInventory();
    const staticRow = wrapper.find('[data-testid="table-static-row"]');
    expect(staticRow.exists()).toBe(true);
    const cells = staticRow.findAll('td');
    expect(cells).toHaveLength(3);
    expect(cells[0].attributes('colspan')).toBe('3');
    expect(cells[0].text()).toContain('制单：{{checker}}');
    expect(wrapper.text()).toContain('盘点确认：');
  });

  it('staticRows 缺省 position（default=after）：自由行只渲一次', async () => {
    const dsl = inventory();
    const table = (dsl.presentations.doc as { body: Array<{ staticRows?: { position?: string } }> })
      .body[1];
    if (table.staticRows) delete table.staticRows.position;
    const ctx = mountCanvas();
    ctx.store.loadTemplate(dsl);
    await ctx.wrapper.vm.$nextTick();
    // fixture staticRows 仅 1 行（colspan 3+3+2）；缺省 position 时只渲一次（修复前双渲为 2）
    expect(ctx.wrapper.findAll('[data-testid="table-static-row"]')).toHaveLength(1);
  });

  it('明细占位行 + 逐行渲染提示（数据求值为渲染器职责）', async () => {
    const { wrapper } = await mountInventory();
    expect(wrapper.text()).toContain('{{items.sku}}');
    expect(wrapper.text()).toContain('数据源「items」逐行渲染');
  });

  it('主从子表：列级 subtable 缩进块 + 子列头 + source 标注', async () => {
    const { wrapper } = await mountInventory();
    const sub = wrapper.find('[data-testid="table-subtable"]');
    expect(sub.exists()).toBe(true);
    expect(sub.text()).toContain('source=batches');
    expect(sub.text()).toContain('批号');
    expect(sub.text()).toContain('{{batchNo}}');
  });

  it('summary 合计行 + repeatHeaderOnPageBreak 徽标', async () => {
    const { wrapper } = await mountInventory();
    expect(wrapper.text()).toContain('合计金额');
    const badge = wrapper.find('[data-testid="table-repeat-badge"]');
    expect(badge.exists()).toBe(true);
    expect(badge.text()).toContain('跨页重复表头');
  });

  it('v1.0 回退：无 headerRows 时按 columns 渲单行表头', async () => {
    const { wrapper, store } = mountCanvas();
    store.loadDsl({
      schemaVersion: '1.0',
      id: 'test_v1_table',
      code: 'TEST_V1_TABLE',
      name: 'v1 表格回退',
      presentations: {
        doc: {
          body: [
            {
              type: 'table',
              source: 'items',
              columns: [
                { header: '名称', field: 'name', width: '50%' },
                { header: '数量', field: 'qty', width: '50%' },
              ],
            },
          ],
        },
      },
    });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="table-header-row"]').exists()).toBe(false);
    expect(wrapper.findAll('thead th')).toHaveLength(2);
    expect(wrapper.text()).toContain('名称');
  });

  it('subtotal.values 长度不匹配：就近红条提示错误码', async () => {
    const { wrapper, store } = mountCanvas();
    const dsl = inventory();
    const table = (dsl.presentations.doc as { body: Array<Record<string, unknown>> }).body[1] as {
      groups: Array<{ subtotal: { values: Array<string | null> } }>;
    };
    table.groups[0].subtotal.values.pop(); // 8 → 7，构造 mismatch
    store.loadTemplate(dsl);
    await wrapper.vm.$nextTick();
    const subtotal = wrapper.find('[data-testid="table-group-subtotal"]');
    expect(subtotal.text()).toContain('subtotal-values-length');
    expect(subtotal.find('td').classes().join(' ')).toContain('text-red-600');
  });
});
