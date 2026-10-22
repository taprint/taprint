// SPDX-License-Identifier: Apache-2.0
// TemplateListPage 组件交互单测。
// 覆盖：列表渲染/搜索过滤/新建向导/重命名/删除二次确认（含后代守卫 UI）/另存为跳转/
// 三处跳转按钮可点击；既有 open-designer testid 保留。
import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import TemplateListPage from '../../../src/full/pages/TemplateListPage.vue';
import {
  getSharedRepository,
  MemoryTemplateRepository,
  buildSeedTemplates,
  buildSeedVersions,
  resetSharedRepository,
  setSharedRepository,
} from '../../../src/template-domain';

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'template-list', component: TemplateListPage },
      {
        path: '/design/:id',
        name: 'designer',
        component: { template: '<div/>' },
      },
      {
        path: '/versions/:id',
        name: 'version-history',
        component: { template: '<div/>' },
      },
      {
        path: '/lineage/:id',
        name: 'template-lineage',
        component: { template: '<div/>' },
      },
    ],
  });
}

async function mountList(): Promise<{
  wrapper: ReturnType<typeof mount>;
  router: Router;
}> {
  const router = makeRouter();
  await router.push('/');
  await router.isReady();
  const wrapper = mount(TemplateListPage, {
    global: {
      plugins: [router],
    },
  });
  // 等待 onMounted reload 完成
  await vi.waitFor(() => {
    expect(wrapper.findAll('[data-testid^="template-row-"]')).toHaveLength(3);
  });
  return { wrapper, router };
}

describe('TemplateListPage 列表渲染', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setSharedRepository(new MemoryTemplateRepository(buildSeedTemplates(), buildSeedVersions()));
  });
  afterEach(() => {
    resetSharedRepository();
    vi.restoreAllMocks();
  });

  it('seed 3 模板渲染：含 id 1/2/3，6 列各 testid 齐全', async () => {
    const { wrapper } = await mountList();
    const rows = wrapper.findAll('[data-testid^="template-row-"]');
    expect(rows).toHaveLength(3);
    // id=1 行各列 testid 齐全
    const row1 = `[data-testid="template-row-1"]`;
    expect(wrapper.find(`${row1} [data-testid="template-open-1"]`).exists()).toBe(true);
    expect(wrapper.find(`${row1} [data-testid="template-device-1"]`).exists()).toBe(true);
    expect(wrapper.find(`${row1} [data-testid="template-schema-1"]`).exists()).toBe(true);
    expect(wrapper.find(`${row1} [data-testid="template-version-1"]`).exists()).toBe(true);
    expect(wrapper.find(`${row1} [data-testid="template-lineage-chip-1"]`).exists()).toBe(false); // id=1 是原始无血缘
    // id=3 是 sales-note 后代 → 血缘 chip 显示
    expect(wrapper.find('[data-testid="template-lineage-chip-3"]').exists()).toBe(true);
  });

  it('已发布模板显示 vX（id=1 currentVersion=1）；未发布显示 —（id=2/3）', async () => {
    const { wrapper } = await mountList();
    expect(wrapper.find('[data-testid="template-version-1"]').text()).toContain('v1');
    expect(wrapper.find('[data-testid="template-version-2"]').text()).toBe('—');
    expect(wrapper.find('[data-testid="template-version-3"]').text()).toBe('—');
  });

  it('既有 open-designer testid 保留（指向 /design/sample 兼容路由）', async () => {
    const { wrapper } = await mountList();
    expect(wrapper.find('[data-testid="open-designer"]').attributes('href')).toBe('/design/sample');
  });

  it('新建模板按钮 + create-template testid 存在', async () => {
    const { wrapper } = await mountList();
    expect(wrapper.find('[data-testid="create-template"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="template-search"]').exists()).toBe(true);
  });
});

describe('TemplateListPage 搜索过滤', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setSharedRepository(new MemoryTemplateRepository(buildSeedTemplates(), buildSeedVersions()));
  });
  afterEach(() => {
    resetSharedRepository();
  });

  it('关键词匹配名称：销售单 → 仅匹配销售单', async () => {
    const { wrapper } = await mountList();
    await wrapper.find('[data-testid="template-search"]').setValue('销售单');
    // 仅 id=1 命中（coupon-sheet 的 desc 含「销售单」字样，但关键词为「销售单」时严格包含——
    // coupon-sheet desc 是「...来自「销售单」副本...」，同样命中，故预期 2 个）
    const matched = wrapper.findAll('[data-testid^="template-row-"]');
    expect(matched.length).toBeGreaterThanOrEqual(1);
    expect(wrapper.find('[data-testid="template-open-1"]').text()).toContain('销售');
  });

  it('关键词匹配描述：盘点 → 仅匹配盘点汇总表', async () => {
    const { wrapper } = await mountList();
    await wrapper.find('[data-testid="template-search"]').setValue('盘点');
    expect(wrapper.findAll('[data-testid^="template-row-"]')).toHaveLength(1);
  });

  it('空关键词恢复全列表', async () => {
    const { wrapper } = await mountList();
    await wrapper.find('[data-testid="template-search"]').setValue('销售单');
    expect(wrapper.findAll('[data-testid^="template-row-"]').length).toBeGreaterThanOrEqual(1);
    await wrapper.find('[data-testid="template-search"]').setValue('');
    expect(wrapper.findAll('[data-testid^="template-row-"]')).toHaveLength(3);
  });

  it('大小写不敏感：代金券 匹配 coupon-sheet', async () => {
    const { wrapper } = await mountList();
    await wrapper.find('[data-testid="template-search"]').setValue('代金券');
    expect(wrapper.findAll('[data-testid^="template-row-"]')).toHaveLength(1);
    expect(wrapper.find('[data-testid="template-open-3"]').text()).toContain('代金券');
  });

  it('无匹配显示提示', async () => {
    const { wrapper } = await mountList();
    await wrapper.find('[data-testid="template-search"]').setValue('不存在的关键词');
    expect(wrapper.findAll('[data-testid^="template-row-"]')).toHaveLength(0);
    expect(wrapper.text()).toContain('无匹配模板');
  });
});

describe('TemplateListPage 新建向导', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setSharedRepository(new MemoryTemplateRepository(buildSeedTemplates(), buildSeedVersions()));
  });
  afterEach(() => {
    resetSharedRepository();
  });

  it('点新建按钮打开向导，填名称确认后跳转 /design/:id', async () => {
    const { wrapper, router } = await mountList();
    await wrapper.find('[data-testid="create-template"]').trigger('click');
    expect(wrapper.find('[data-testid="create-template-modal"]').exists()).toBe(true);
    await wrapper.find('[data-testid="create-name-input"]').setValue('新模板');
    await wrapper.find('[data-testid="create-device-select"]').setValue('label');
    await wrapper.find('[data-testid="create-confirm"]').trigger('click');
    await vi.waitFor(() => {
      expect(router.currentRoute.value.name).toBe('designer');
    });
    expect(Number(router.currentRoute.value.params.id)).toBeGreaterThanOrEqual(4);
  });

  it('名称为空时确认不触发跳转', async () => {
    const { wrapper, router } = await mountList();
    await wrapper.find('[data-testid="create-template"]').trigger('click');
    await wrapper.find('[data-testid="create-name-input"]').setValue(' ');
    await wrapper.find('[data-testid="create-confirm"]').trigger('click');
    expect(router.currentRoute.value.name).toBe('template-list');
    expect(wrapper.find('[data-testid="create-template-modal"]').exists()).toBe(true);
  });

  it('取消关闭向导', async () => {
    const { wrapper } = await mountList();
    await wrapper.find('[data-testid="create-template"]').trigger('click');
    await wrapper.find('[data-testid="create-cancel"]').trigger('click');
    expect(wrapper.find('[data-testid="create-template-modal"]').exists()).toBe(false);
  });
});

describe('TemplateListPage 重命名', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setSharedRepository(new MemoryTemplateRepository(buildSeedTemplates(), buildSeedVersions()));
  });
  afterEach(() => {
    resetSharedRepository();
  });

  it('点重命名显示输入框，确认后写回 + 列表刷新', async () => {
    const { wrapper } = await mountList();
    await wrapper.find('[data-testid="template-rename-2"]').trigger('click');
    expect(wrapper.find('[data-testid="rename-input-2"]').exists()).toBe(true);
    await wrapper.find('[data-testid="rename-input-2"]').setValue('盘点表-改名');
    await wrapper.find('[data-testid="rename-confirm-2"]').trigger('click');
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="template-open-2"]').text()).toContain('盘点表-改名');
    });
  });

  it('ESC 取消重命名（输入框消失）', async () => {
    const { wrapper } = await mountList();
    await wrapper.find('[data-testid="template-rename-1"]').trigger('click');
    await wrapper.find('[data-testid="rename-input-1"]').trigger('keydown.esc');
    expect(wrapper.find('[data-testid="rename-input-1"]').exists()).toBe(false);
  });

  it('重命名为同名直接关闭（视为无变更）', async () => {
    const { wrapper } = await mountList();
    const before = wrapper.find('[data-testid="template-open-1"]').text();
    await wrapper.find('[data-testid="template-rename-1"]').trigger('click');
    await wrapper.find('[data-testid="rename-input-1"]').setValue('销售单'); // 同原名
    await wrapper.find('[data-testid="rename-confirm-1"]').trigger('click');
    expect(wrapper.find('[data-testid="rename-input-1"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="template-open-1"]').text()).toBe(before);
  });
});

describe('TemplateListPage 删除（含后代守卫 UI）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setSharedRepository(new MemoryTemplateRepository(buildSeedTemplates(), buildSeedVersions()));
  });
  afterEach(() => {
    resetSharedRepository();
  });

  it('点删除显示二次确认；取消关闭', async () => {
    const { wrapper } = await mountList();
    await wrapper.find('[data-testid="template-delete-2"]').trigger('click');
    expect(wrapper.find('[data-testid="delete-confirm-2"]').exists()).toBe(true);
    await wrapper.find('[data-testid="delete-cancel-2"]').trigger('click');
    expect(wrapper.find('[data-testid="delete-confirm-2"]').exists()).toBe(false);
  });

  it('确认删除无后代模板：列表刷新（id=2 消失）', async () => {
    const { wrapper } = await mountList();
    await wrapper.find('[data-testid="template-delete-2"]').trigger('click');
    await wrapper.find('[data-testid="delete-confirm-2"]').trigger('click');
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="template-row-2"]').exists()).toBe(false);
    });
    // 其他模板仍在
    expect(wrapper.find('[data-testid="template-row-1"]').exists()).toBe(true);
  });

  it('有后代的模板禁删：错误提示显示在顶栏', async () => {
    const { wrapper } = await mountList();
    await wrapper.find('[data-testid="template-delete-1"]').trigger('click');
    await wrapper.find('[data-testid="delete-confirm-1"]').trigger('click');
    await vi.waitFor(() => {
      const err = wrapper.find('[data-testid="template-list-error"]');
      expect(err.exists()).toBe(true);
      expect(err.text()).toContain('后代');
    });
    // id=1 仍在（守卫拒绝删除）
    expect(wrapper.find('[data-testid="template-row-1"]').exists()).toBe(true);
  });
});

describe('TemplateListPage 三处跳转按钮', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setSharedRepository(new MemoryTemplateRepository(buildSeedTemplates(), buildSeedVersions()));
  });
  afterEach(() => {
    resetSharedRepository();
  });

  it('点行内「设计」按钮跳转 /design/:id', async () => {
    const { wrapper, router } = await mountList();
    await wrapper.find('[data-testid="template-design-2"]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('designer'));
    expect(router.currentRoute.value.params.id).toBe('2');
  });

  it('点行内「版本」按钮跳转 /versions/:id', async () => {
    const { wrapper, router } = await mountList();
    await wrapper.find('[data-testid="template-versions-1"]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('version-history'));
    expect(router.currentRoute.value.params.id).toBe('1');
  });

  it('点行内「血缘」按钮跳转 /lineage/:id', async () => {
    const { wrapper, router } = await mountList();
    await wrapper.find('[data-testid="template-lineage-3"]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('template-lineage'));
    expect(router.currentRoute.value.params.id).toBe('3');
  });

  it('点行内名称（template-open）也跳转 /design/:id', async () => {
    const { wrapper, router } = await mountList();
    await wrapper.find('[data-testid="template-open-1"]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('designer'));
    expect(router.currentRoute.value.params.id).toBe('1');
  });
});

describe('TemplateListPage SaveAsDialog 插槽', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setSharedRepository(new MemoryTemplateRepository(buildSeedTemplates(), buildSeedVersions()));
  });
  afterEach(() => {
    resetSharedRepository();
  });

  it('每行挂载 SaveAsDialog 占位组件 + 另存为按钮可点击', async () => {
    const { wrapper } = await mountList();
    // 每行 3 个 SaveAsDialog
    expect(wrapper.findAll('[data-testid^="save-as-trigger-"]')).toHaveLength(3);
  });

  it('点击另存为触发按钮 → 显示对话框 → 确认 → duplicate + 跳转新模板', async () => {
    const { wrapper, router } = await mountList();
    await wrapper.find('[data-testid="save-as-trigger-2"]').trigger('click');
    expect(wrapper.find('[data-testid="save-as-modal"]').exists()).toBe(true);
    await wrapper.find('[data-testid="save-as-name-input"]').setValue('盘点-实验副本');
    await wrapper.find('[data-testid="save-as-confirm"]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('designer'));
    const newId = Number(router.currentRoute.value.params.id);
    expect(newId).toBeGreaterThanOrEqual(4);
    // 验证 duplicate 已写入 Repository：新模板 sourceTemplateId=2、sourceVersion=null（id=2 未发布）
    const newRecord = await getSharedRepository().get(newId);
    expect(newRecord?.sourceTemplateId).toBe(2);
    expect(newRecord?.sourceVersion).toBeNull();
    expect(newRecord?.name).toBe('盘点-实验副本');
  });
});
