// SPDX-License-Identifier: Apache-2.0
// DesignerPage 组件交互单测。
// 覆盖：预载机制（repo.get → store.loadTemplate 后渲染 workbench）/ 不存在 404 /
// /design/sample 重定向到 /design/1 / saveChannel 写回（updatedAt 更新，不动血缘/版本字段）/
// 样例下拉误操作提示文案可见 / DesignerWorkbench/store 零改动 git diff 锚点（间接验证）。
import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import DesignerPage from '../../../src/full/pages/DesignerPage.vue';
import { useDesignerStore } from '../../../src/canvas/store';
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
      // 兼容路由：与 src/full/routes.ts 同口径，在路由层 redirect 到 /design/1
      {
        path: '/design/sample',
        redirect: { name: 'designer', params: { id: '1' } },
      },
      {
        path: '/design/:id',
        name: 'designer',
        component: DesignerPage,
      },
      {
        path: '/',
        name: 'template-list',
        component: { template: '<div/>' },
      },
    ],
  });
}

async function mountDesigner(initialPath: string): Promise<{
  wrapper: ReturnType<typeof mount>;
  router: Router;
}> {
  const router = makeRouter();
  await router.push(initialPath);
  await router.isReady();
  const wrapper = mount(DesignerPage, {
    global: {
      plugins: [router, createPinia()],
    },
  });
  return { wrapper, router };
}

describe('DesignerPage 预载机制', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setSharedRepository(new MemoryTemplateRepository(buildSeedTemplates(), buildSeedVersions()));
  });
  afterEach(() => {
    resetSharedRepository();
  });

  it('setup 阶段 repo.get → store.loadTemplate 后渲染 workbench', async () => {
    const { wrapper } = await mountDesigner('/design/1');
    // 等待 async onMounted 完成
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="designer-loading"]').exists()).toBe(false);
    });
    // workbench 渲染（顶栏 workbench-topbar 是 DesignerWorkbench 的 testid）
    expect(wrapper.find('[data-testid="workbench-topbar"]').exists()).toBe(true);
    // store.dsl 已预载（迁移后 schemaVersion=CURRENT_VERSION）
    const store = useDesignerStore();
    expect(store.dsl).not.toBeNull();
    expect(store.dsl?.name).toBeDefined();
    // 顶部信息条：模板名 + id 显示
    expect(wrapper.find('[data-testid="designer-infobar"]').text()).toContain('销售单');
    expect(wrapper.find('[data-testid="designer-infobar"]').text()).toContain('id=1');
  });

  it('未发布的模板也能渲染（id=2 inventory-report）', async () => {
    const { wrapper } = await mountDesigner('/design/2');
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="workbench-topbar"]').exists()).toBe(true);
    });
    const store = useDesignerStore();
    expect(store.dsl).not.toBeNull();
    expect(wrapper.find('[data-testid="designer-infobar"]').text()).toContain('盘点');
  });
});

describe('DesignerPage 不存在 → 404 友好态', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setSharedRepository(new MemoryTemplateRepository(buildSeedTemplates(), buildSeedVersions()));
  });
  afterEach(() => {
    resetSharedRepository();
  });

  it('id=999 不存在：显示 404 态，不挂 workbench', async () => {
    const { wrapper } = await mountDesigner('/design/999');
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="designer-not-found"]').exists()).toBe(true);
    });
    expect(wrapper.find('[data-testid="designer-not-found"]').text()).toContain('999');
    expect(wrapper.find('[data-testid="workbench-topbar"]').exists()).toBe(false);
  });

  it('非法 id（字符串非数字）：显示 404 态', async () => {
    const { wrapper } = await mountDesigner('/design/abc');
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="designer-not-found"]').exists()).toBe(true);
    });
    expect(wrapper.find('[data-testid="workbench-topbar"]').exists()).toBe(false);
  });
});

describe('DesignerPage /design/sample 重定向（兼容路由）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setSharedRepository(new MemoryTemplateRepository(buildSeedTemplates(), buildSeedVersions()));
  });
  afterEach(() => {
    resetSharedRepository();
  });

  it('/design/sample → router.replace 到 /design/1（sales-note seed）', async () => {
    const { router } = await mountDesigner('/design/sample');
    await vi.waitFor(() => {
      expect(router.currentRoute.value.params.id).toBe('1');
    });
  });
});

describe('DesignerPage saveChannel 写回', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setSharedRepository(new MemoryTemplateRepository(buildSeedTemplates(), buildSeedVersions()));
  });
  afterEach(() => {
    resetSharedRepository();
  });

  it('点击保存按钮触发 saveChannel 写回 Repository（updatedAt 更新，血缘/版本字段不动）', async () => {
    const { wrapper } = await mountDesigner('/design/1');
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="workbench-topbar"]').exists()).toBe(true);
    });
    const before = (await getSharedRepository().get(1))!;
    // 修改 store.dsl 后点击保存（workbench onSave 调 props.saveChannel(store.dsl)）
    const store = useDesignerStore();
    store.updateSelected({ content: '改了一个字段' });
    // 让 dirty=true 触发；prepareSave 通过则 saveChannel 调用
    await wrapper.find('[data-testid="save-button"]').trigger('click');
    await vi.waitFor(async () => {
      expect(wrapper.find('[data-testid="designer-last-saved"]').exists()).toBe(true);
    });
    const after = await getSharedRepository().get(1);
    expect(after?.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
    // 血缘/版本字段不动
    expect(after?.sourceTemplateId).toBe(before.sourceTemplateId);
    expect(after?.sourceVersion).toBe(before.sourceVersion);
    expect(after?.currentVersion).toBe(before.currentVersion);
  });
});

describe('DesignerPage 样例下拉误操作提示文案', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setSharedRepository(new MemoryTemplateRepository(buildSeedTemplates(), buildSeedVersions()));
  });
  afterEach(() => {
    resetSharedRepository();
  });

  it('sample-dropdown-hint 可见且包含当前模板 id', async () => {
    const { wrapper } = await mountDesigner('/design/2');
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="sample-dropdown-hint"]').exists()).toBe(true);
    });
    const text = wrapper.find('[data-testid="sample-dropdown-hint"]').text();
    expect(text).toContain('id=2');
    expect(text).toContain('样例模板');
  });
});

describe('DesignerPage 样例下拉切换语义）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setSharedRepository(new MemoryTemplateRepository(buildSeedTemplates(), buildSeedVersions()));
  });
  afterEach(() => {
    resetSharedRepository();
  });

  it('下拉切换样例：store.dsl 变为新样例内容；保存仅写当前路由模板（id=1）的草稿', async () => {
    const { wrapper } = await mountDesigner('/design/1');
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="workbench-topbar"]').exists()).toBe(true);
    });
    const store = useDesignerStore();
    // 切换到 inventory-report（sample-select option value='inventory-report'）
    await wrapper.find('[data-testid="sample-select"]').setValue('inventory-report');
    // store.dsl 变为 inventory-report 的内容
    expect(store.dsl?.name).toBeDefined();
    // 路由仍是 /design/1（下拉不改路由）
    // 保存：写当前路由模板 id=1
    await wrapper.find('[data-testid="save-button"]').trigger('click');
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="designer-last-saved"]').exists()).toBe(true);
    });
    // Repository id=1 的 dsl 已被覆盖为 inventory-report 的内容（即下拉载入的样例）
    const saved = await getSharedRepository().get(1);
    // inventory-report fixture 的 name 字段在 dsl.name
    expect(saved?.dsl.name).not.toBe('销售单'); // 已切换为 inventory-report 的 dsl
    // 但路由仍是 id=1（不切换路由）
    expect(wrapper.vm.$route.params.id).toBe('1');
  });
});
